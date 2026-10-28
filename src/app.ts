import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Config } from './config.ts';
import { codeMatches, createSession, equalToken, readSession, sessionMaxAge } from './crypto.ts';
import type { Role, Session } from './crypto.ts';
import { Store, RateLimitError } from './store.ts';
import { GoogleConnection } from './google/connection.ts';
import { SdmClient, GoogleApiError } from './google/sdm.ts';
import { ThermostatService } from './service.ts';
import { CommandValidationError } from './domain/thermostat.ts';
import {
  memoryAccessStore,
  parseUserAccess,
  readUserAccess,
  userRefusal,
  type AccessStore,
} from './controls.ts';

type AppEnv = { Variables: { session: Session | null } };
const LOGIN_LIMITS = [
  { max: 10, windowMs: 60_000 },
  { max: 50, windowMs: 3_600_000 },
];
export interface AppOptions {
  config: Config;
  access?: AccessStore;
  store?: Store;
  connection?: GoogleConnection;
  service?: ThermostatService;
}

export function createApp({
  config,
  access = memoryAccessStore(),
  store = new Store(),
  connection = new GoogleConnection(config),
  service,
}: AppOptions) {
  const app = new Hono<AppEnv>();
  const client = connection.connected
    ? new SdmClient({
        deviceResource: connection.resource!,
        accessToken: () => connection.accessToken(),
      })
    : null;
  const thermostat =
    service ||
    new ThermostatService({
      store,
      policy: {
        minCelsius: config.minCelsius,
        maxCelsius: config.maxCelsius,
        minRangeGapCelsius: config.minRangeGapCelsius,
      },
      client: () => client,
    });
  const cookieName = config.secureCookies ? '__Host-thermostat-session' : 'thermostat-session';
  const codes: Record<Role, string | undefined> = {
    admin: config.adminCode,
    user: config.userCode,
  };
  const session = (cookie: string | undefined) => readSession(config.sessionSecret, cookie, codes);

  app.use('*', async (c, next) => {
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    if (config.secureCookies) c.header('Strict-Transport-Security', 'max-age=31536000');
    c.header('Cache-Control', 'no-store');
    c.set('session', session(getCookie(c, cookieName)));
    await next();
  });
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 4096,
      onError: (c) => c.json({ message: 'Request body is too large.' }, 413),
    }),
  );
  app.use('/api/*', async (c, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
      if (
        c.req.header('origin') !== config.origin ||
        c.req.header('sec-fetch-site') === 'cross-site'
      )
        return c.json({ message: 'Request origin was not accepted.' }, 403);
      if (!c.req.header('content-type')?.startsWith('application/json'))
        return c.json({ message: 'Use application/json.' }, 415);
      if (c.req.path !== '/api/login') {
        const current = c.get('session');
        if (!current) return c.json({ message: 'Please sign in.' }, 401);
        if (!equalToken(c.req.header('x-csrf-token') || '', current.csrfToken))
          return c.json({ message: 'Refresh the page before trying again.' }, 403);
      }
    }
    await next();
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/api/session', (c) => {
    const current = c.get('session');
    return c.json({
      authenticated: Boolean(current),
      configured: Boolean(config.adminCode),
      ...(current ? { role: current.role, csrfToken: current.csrfToken } : {}),
    });
  });
  app.post('/api/login', async (c) => {
    // Only wrong codes count, so guessing can't lock out the real user.
    const wait = store.wait('login-failures', LOGIN_LIMITS);
    if (wait > 0) throw new RateLimitError(wait);
    const body = (await c.req.json()) as Record<string, unknown>;
    if (!body || typeof body.code !== 'string' || Object.keys(body).length !== 1)
      return c.json({ message: 'Enter your code.' }, 400);
    const typed = body.code.trim();
    const role: Role | null = codeMatches(config.sessionSecret, typed, config.adminCode)
      ? 'admin'
      : codeMatches(config.sessionSecret, typed, config.userCode)
        ? 'user'
        : null;
    if (!role) {
      store.record('login-failures');
      return c.json({ message: 'Wrong code.' }, 401);
    }
    if (role === 'user' && !(await readUserAccess(access, config)).enabled)
      return c.json({ message: 'Access is turned off.' }, 403);
    const cookie = createSession(config.sessionSecret, role, typed);
    setCookie(c, cookieName, cookie, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'Lax',
      path: '/',
      maxAge: sessionMaxAge,
    });
    store.audit(role, 'login', 'success');
    return c.json({ authenticated: true, role, csrfToken: session(cookie)!.csrfToken });
  });
  app.post('/api/logout', (c) => {
    deleteCookie(c, cookieName, { path: '/', secure: config.secureCookies });
    return c.json({ ok: true });
  });

  app.use('/api/thermostat', async (c, next) => {
    if (!c.get('session')) return c.json({ message: 'Please sign in.' }, 401);
    await next();
  });
  app.get('/api/thermostat', async (c) => {
    const status = await thermostat.status();
    if (c.get('session')!.role === 'admin') return c.json(status);
    const userAccess = await readUserAccess(access, config);
    if (!userAccess.enabled) return c.json({ message: 'Access is turned off.' }, 403);
    return c.json({
      ...status,
      limits: {
        ...status.limits,
        minCelsius: userAccess.minCelsius,
        maxCelsius: userAccess.maxCelsius,
      },
      controls: { modes: userAccess.modes, eco: userAccess.eco },
    });
  });
  app.post('/api/commands', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    if (
      !body ||
      typeof body !== 'object' ||
      typeof body.requestId !== 'string' ||
      !Object.hasOwn(body, 'command') ||
      Object.keys(body).length !== 2
    )
      return c.json({ message: 'A command and unique request ID are required.' }, 400);
    const { role } = c.get('session')!;
    if (role === 'user') {
      const refusal = userRefusal(body.command, await readUserAccess(access, config));
      if (refusal) return c.json({ message: refusal }, 403);
    }
    const cookie = getCookie(c, cookieName);
    const result = await thermostat.command(role, body.requestId, body.command, () =>
      Boolean(session(cookie)),
    );
    if (result.body.retryAfterSeconds)
      c.header('Retry-After', String(result.body.retryAfterSeconds));
    return c.json(result.body, result.status as 200);
  });

  app.use('/api/admin/*', async (c, next) => {
    if (c.get('session')?.role !== 'admin')
      return c.json({ message: 'Admin access is required.' }, 403);
    await next();
  });
  app.get('/api/admin/access', async (c) =>
    c.json({
      access: await readUserAccess(access, config),
      limits: {
        minCelsius: config.minCelsius,
        maxCelsius: config.maxCelsius,
        minRangeGapCelsius: config.minRangeGapCelsius,
      },
      userCodeSet: Boolean(config.userCode),
      googleConnected: connection.connected,
    }),
  );
  app.put('/api/admin/access', async (c) => {
    const next = parseUserAccess(await c.req.json(), config);
    if (!next) return c.json({ message: 'Check the user access settings.' }, 400);
    await access.set(next);
    store.audit('admin', 'user-access', JSON.stringify(next));
    return c.json(next);
  });

  app.onError((error, c) => {
    if (error instanceof RateLimitError) {
      c.header('Retry-After', String(error.retryAfterSeconds));
      return c.json({ message: error.message, retryAfterSeconds: error.retryAfterSeconds }, 429);
    }
    if (error instanceof CommandValidationError || error instanceof GoogleApiError)
      return c.json({ message: error.message }, error.status as 400);
    if (error instanceof SyntaxError) return c.json({ message: 'Invalid JSON request.' }, 400);
    // Deliberately do not log request bodies, Google responses or credentials.
    return c.json({ message: 'The request could not be completed. Please try again later.' }, 500);
  });
  app.notFound((c) => c.json({ message: 'Not found.' }, 404));
  return app;
}
