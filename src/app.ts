import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Config } from './config.ts';
import { googleConfigured } from './config.ts';
import { equalToken } from './crypto.ts';
import { Store, RateLimitError } from './store.ts';
import type { Session } from './store.ts';
import { GoogleConnection } from './google/connection.ts';
import { SdmClient, GoogleApiError } from './google/sdm.ts';
import { ThermostatService } from './service.ts';
import { CommandValidationError } from './domain/thermostat.ts';

type AppEnv = { Variables: { session: Session | null } };
export interface AppOptions {
  config: Config;
  store: Store;
  connection?: GoogleConnection;
  service?: ThermostatService;
  staticRoot?: string;
}
export function createApp({
  config,
  store,
  connection = new GoogleConnection(config, store),
  service,
  staticRoot = './public',
}: AppOptions) {
  const app = new Hono<AppEnv>();
  let deviceClient: SdmClient | undefined;
  let deviceResource: string | undefined;
  const thermostat =
    service ||
    new ThermostatService({
      store,
      policy: {
        minCelsius: config.minCelsius,
        maxCelsius: config.maxCelsius,
        minRangeGapCelsius: config.minRangeGapCelsius,
      },
      client: () => {
        if (!connection.connected) return null;
        if (deviceResource !== connection.resource) {
          deviceResource = connection.resource;
          deviceClient = new SdmClient({
            deviceResource: deviceResource!,
            accessToken: () => connection.accessToken(),
          });
        }
        return deviceClient!;
      },
    });
  const cookieName = config.secureCookies ? '__Host-neighbor-session' : 'neighbor-session';
  app.use('*', async (c, next) => {
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.secureCookies) c.header('Strict-Transport-Security', 'max-age=31536000');
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/oauth/'))
      c.header('Cache-Control', 'no-store');
    c.set('session', store.session(getCookie(c, cookieName)));
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
        const session = c.get('session');
        if (!session) return c.json({ message: 'Please sign in.' }, 401);
        if (!equalToken(c.req.header('x-csrf-token') || '', session.csrfToken))
          return c.json({ message: 'Refresh the page before trying again.' }, 403);
      }
    }
    await next();
  });
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/api/session', (c) => {
    const session = c.get('session');
    return c.json({
      authenticated: Boolean(session),
      configured: store.hasOwner(),
      ...(session
        ? { role: session.role, label: session.label, csrfToken: session.csrfToken }
        : {}),
    });
  });
  app.post('/api/login', async (c) => {
    store.reserve('login', [
      { max: 20, windowMs: 60_000 },
      { max: 100, windowMs: 3_600_000 },
    ]);
    store.prune();
    const body = (await c.req.json()) as Record<string, unknown>;
    if (
      !body ||
      typeof body !== 'object' ||
      typeof body.key !== 'string' ||
      Object.keys(body).length !== 1
    )
      return c.json({ message: 'Enter a valid access key.' }, 400);
    const logged = store.login(body.key.trim());
    if (!logged)
      return c.json({ message: 'This access key is invalid, expired, or revoked.' }, 401);
    const old = c.get('session');
    if (old) store.logout(old.hash);
    setCookie(c, cookieName, logged.token, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'Lax',
      path: '/',
      maxAge: 7 * 86400,
    });
    store.audit(logged.session.keyId, 'login', 'success');
    return c.json({
      authenticated: true,
      role: logged.session.role,
      label: logged.session.label,
      csrfToken: logged.session.csrfToken,
    });
  });
  app.post('/api/logout', (c) => {
    store.logout(c.get('session')!.hash);
    deleteCookie(c, cookieName, { path: '/', secure: config.secureCookies });
    return c.json({ ok: true });
  });
  app.use('/api/thermostat', async (c, next) => {
    if (!c.get('session')) return c.json({ message: 'Please sign in.' }, 401);
    await next();
  });
  app.get('/api/thermostat', async (c) => c.json(await thermostat.status()));
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
    const session = c.get('session')!;
    const token = getCookie(c, cookieName);
    const result = await thermostat.command(session.keyId, body.requestId, body.command, () =>
      Boolean(store.session(token)),
    );
    if (result.body.retryAfterSeconds)
      c.header('Retry-After', String(result.body.retryAfterSeconds));
    return c.json(result.body, result.status as 200);
  });
  app.use('/api/owner/*', async (c, next) => {
    if (c.get('session')?.role !== 'owner')
      return c.json({ message: 'Owner access is required.' }, 403);
    await next();
  });
  app.get('/api/owner/status', (c) =>
    c.json({
      googleConfigured: googleConfigured(config),
      googleConnected: connection.connected,
      deviceConfigured: Boolean(connection.resource),
      accessKeys: store.listKeys(),
      setupMessage: googleConfigured(config)
        ? 'Ready for the owner to authorize one thermostat.'
        : 'Not configured. See docs/google-setup.md.',
    }),
  );
  app.post('/api/owner/keys', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    if (
      !body ||
      typeof body !== 'object' ||
      typeof body.label !== 'string' ||
      !body.label.trim() ||
      body.label.length > 80 ||
      !Number.isInteger(body.days) ||
      (body.days as number) < 1 ||
      (body.days as number) > 365 ||
      Object.keys(body).length !== 2
    )
      return c.json({ message: 'Give the key a name and an expiry of 1–365 days.' }, 400);
    store.reserve('key-create', [{ max: 10, windowMs: 60_000 }]);
    const created = store.createKey(
      'neighbor',
      body.label,
      Date.now() + (body.days as number) * 86_400_000,
    );
    store.audit(c.get('session')!.keyId, 'key-create', created.id);
    return c.json(created, 201);
  });
  app.delete('/api/owner/keys/:id', (c) => {
    const id = c.req.param('id');
    // Owner keys are only revoked from the local CLI, so the app can't lock its owner out.
    if (!store.listKeys().some((key) => key.id === id && key.role === 'neighbor'))
      return c.json({ message: 'Key not found.' }, 404);
    store.revokeKey(id);
    store.audit(c.get('session')!.keyId, 'key-revoke', id);
    return c.json({ ok: true });
  });
  app.post('/api/owner/google/connect', async (c) => {
    if (!googleConfigured(config))
      return c.json(
        { message: 'Google connection is not configured. Follow the owner setup guide first.' },
        503,
      );
    store.reserve('google-connect', [{ max: 5, windowMs: 60_000 }]);
    return c.json({ url: await connection.authorizationUrl(c.get('session')!.hash) });
  });
  app.get('/oauth/google/callback', async (c) => {
    const session = c.get('session');
    if (session?.role !== 'owner')
      return c.text('Owner sign-in is required. Return to the app and connect Google again.', 403);
    const state = c.req.query('state');
    const code = c.req.query('code');
    if (!state || !code || state.length > 200 || code.length > 4096)
      return c.text('Google connection was not completed. Return to the app and start again.', 400);
    try {
      await connection.complete(
        code,
        state,
        session.hash,
        () => store.session(getCookie(c, cookieName))?.role === 'owner',
      );
      thermostat.reset();
      store.audit(session.keyId, 'google-connect', 'success');
      return c.redirect('/?connected=1', 303);
    } catch {
      return c.text(
        'Google connection could not be completed. Check your setup, selected thermostat, and permissions, then start again from the app. No credentials are displayed here.',
        400,
      );
    }
  });
  app.onError((error, c) => {
    if (error instanceof RateLimitError) {
      c.header('Retry-After', String(error.retryAfterSeconds));
      return c.json({ message: error.message, retryAfterSeconds: error.retryAfterSeconds }, 429);
    }
    if (error instanceof CommandValidationError || error instanceof GoogleApiError)
      return c.json({ message: error.message }, error.status as 400);
    if (error instanceof SyntaxError) return c.json({ message: 'Invalid JSON request.' }, 400);
    // Deliberately do not log raw request URLs, bodies, Google responses or credentials.
    return c.json({ message: 'The request could not be completed. Please try again later.' }, 500);
  });
  app.get('/', serveStatic({ path: `${staticRoot}/index.html` }));
  app.get('/app.js', serveStatic({ path: `${staticRoot}/app.js` }));
  app.get('/styles.css', serveStatic({ path: `${staticRoot}/styles.css` }));
  app.get('/favicon.svg', serveStatic({ path: `${staticRoot}/favicon.svg` }));
  app.get('/theme.js', serveStatic({ path: `${staticRoot}/theme.js` }));
  app.notFound((c) => c.json({ message: 'Not found.' }, 404));
  return app;
}
