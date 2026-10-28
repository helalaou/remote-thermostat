import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { GoogleConnection } from '../src/google/connection.ts';
import { memoryAccessStore } from '../src/controls.ts';

const ADMIN = 'correct-horse-battery-staple';
const USER = 'prancer';
function setup(env: Record<string, string> = {}) {
  const config = readConfig({
    APP_ORIGIN: 'http://localhost:3000',
    ADMIN_CODE: ADMIN,
    USER_CODE: USER,
    ...env,
  });
  return { config, app: createApp({ config, access: memoryAccessStore() }) };
}
type App = ReturnType<typeof createApp>;
async function login(app: App, origin: string, code: string) {
  const response = await app.request('/api/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await response.json();
  const cookie = response.headers.get('Set-Cookie')?.split(';')[0] ?? '';
  return {
    response,
    data,
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRF-Token': data.csrfToken as string,
    },
  };
}
const send = (app: App, headers: Record<string, string>, command: unknown) =>
  app.request('/api/commands', {
    method: 'POST',
    headers,
    body: JSON.stringify({ requestId: crypto.randomUUID(), command }),
  });
const putAccess = (app: App, headers: Record<string, string>, body: unknown) =>
  app.request('/api/admin/access', { method: 'PUT', headers, body: JSON.stringify(body) });

test('anonymous visitors get nothing private', async () => {
  const { app } = setup();
  assert.equal((await app.request('/healthz')).status, 200);
  assert.deepEqual(await (await app.request('/api/session')).json(), {
    authenticated: false,
    configured: true,
  });
  assert.equal((await app.request('/api/thermostat')).status, 401);
  assert.equal((await app.request('/api/admin/access')).status, 403);
});

test('login needs the right code, exact origin and JSON; production cookies are hardened', async () => {
  const { app, config } = setup({ APP_ORIGIN: 'https://thermo.example' });
  for (const origin of ['https://evil.example', 'null', ''])
    assert.equal((await login(app, origin, ADMIN)).response.status, 403);
  assert.equal((await login(app, config.origin, 'prancer2')).response.status, 401);
  const signed = await login(app, config.origin, USER);
  assert.equal(signed.response.status, 200);
  assert.equal(signed.data.role, 'user');
  const cookie = signed.response.headers.get('Set-Cookie')!;
  for (const part of ['__Host-thermostat-session=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/'])
    assert.ok(cookie.includes(part));
  assert.ok(!cookie.includes(USER));
  assert.match(signed.response.headers.get('Content-Security-Policy')!, /frame-ancestors 'none'/);
});

test('writes need the session CSRF token; the user cannot reach admin routes', async () => {
  const { app, config } = setup();
  const user = await login(app, config.origin, USER);
  const noCsrf = { ...user.headers, 'X-CSRF-Token': '' };
  assert.equal((await send(app, noCsrf, { type: 'mode', mode: 'HEAT' })).status, 403);
  assert.equal(
    (await app.request('/api/logout', { method: 'POST', headers: noCsrf, body: '{}' })).status,
    403,
  );
  assert.equal((await app.request('/api/admin/access', { headers: user.headers })).status, 403);
  assert.equal((await putAccess(app, user.headers, {})).status, 403);
});

test('admin sets user access; the server enforces modes, Eco, range and on/off', async () => {
  const { app, config } = setup();
  const admin = await login(app, config.origin, ADMIN);
  const user = await login(app, config.origin, USER);
  const current = await (await app.request('/api/admin/access', { headers: admin.headers })).json();
  assert.deepEqual(current.access, {
    enabled: true,
    modes: ['HEAT', 'COOL', 'HEATCOOL', 'OFF'],
    eco: true,
    minCelsius: 10,
    maxCelsius: 30,
  });
  const valid = { enabled: true, modes: ['HEAT'], eco: false, minCelsius: 17, maxCelsius: 23 };
  for (const bad of [
    { ...valid, modes: ['FAN'] },
    { ...valid, modes: ['HEAT', 'HEAT'] },
    { ...valid, minCelsius: 5 },
    { ...valid, maxCelsius: 31 },
    { ...valid, minCelsius: 22, maxCelsius: 22.5 },
    { ...valid, eco: 'no' },
    { ...valid, extra: 1 },
  ])
    assert.equal((await putAccess(app, admin.headers, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await putAccess(app, admin.headers, valid)).status, 200);

  const status = await (await app.request('/api/thermostat', { headers: user.headers })).json();
  assert.deepEqual(status.controls, { modes: ['HEAT'], eco: false });
  assert.equal(status.limits.minCelsius, 17);
  assert.equal(status.limits.maxCelsius, 23);

  for (const command of [
    { type: 'mode', mode: 'OFF' },
    { type: 'cool', coolCelsius: 22 },
    { type: 'eco', mode: 'MANUAL_ECO' },
    { type: 'heat', heatCelsius: 26 },
    { type: 'heat', heatCelsius: 15 },
  ])
    assert.equal((await send(app, user.headers, command)).status, 403, JSON.stringify(command));
  // Allowed user commands and every admin command get past the access check.
  for (const [headers, command] of [
    [user.headers, { type: 'heat', heatCelsius: 21 }],
    [user.headers, { type: 'eco', mode: 'OFF' }],
    [admin.headers, { type: 'mode', mode: 'OFF' }],
  ] as const)
    assert.notEqual((await send(app, headers, command)).status, 403, JSON.stringify(command));

  assert.equal((await putAccess(app, admin.headers, { ...valid, enabled: false })).status, 200);
  assert.equal((await app.request('/api/thermostat', { headers: user.headers })).status, 403);
  assert.equal((await send(app, user.headers, { type: 'heat', heatCelsius: 21 })).status, 403);
  assert.equal((await login(app, config.origin, USER)).response.status, 403);
  assert.equal((await login(app, config.origin, ADMIN)).response.status, 200);
});

test('oversized bodies and repeated wrong codes fail safely', async () => {
  const { app, config } = setup();
  const headers = { Origin: config.origin, 'Content-Type': 'application/json' };
  const post = (code: string) =>
    app.request('/api/login', { method: 'POST', headers, body: JSON.stringify({ code }) });
  assert.equal((await post('x'.repeat(5000))).status, 413);
  for (let i = 0; i < 15; i++)
    assert.equal((await post(USER)).status, 200, 'right codes never count');
  for (let i = 0; i < 10; i++) await post('wrong');
  const response = await post('wrong');
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('Retry-After')) > 0);
});

test('a command goes through Google and is confirmed by a fresh reading', async (t) => {
  const config = readConfig({
    APP_ORIGIN: 'http://localhost:3000',
    ADMIN_CODE: ADMIN,
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_DEVICE_ACCESS_PROJECT_ID: 'project',
    GOOGLE_REFRESH_TOKEN: 'refresh',
    GOOGLE_DEVICE_ID: 'device',
  });
  const resource = 'enterprises/project/devices/device';
  let heat = 20;
  let writes = 0;
  let tokenRequests = 0;
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    if (String(input) === 'https://oauth2.googleapis.com/token') {
      tokenRequests++;
      assert.match(String(init.body), /refresh_token=refresh/);
      return Response.json({ access_token: 'access', expires_in: 3600 });
    }
    assert.ok(
      String(input).startsWith(`https://smartdevicemanagement.googleapis.com/v1/${resource}`),
    );
    if (init.method === 'POST') {
      writes++;
      heat = JSON.parse(init.body as string).params.heatCelsius;
      return Response.json({});
    }
    const p = 'sdm.devices.traits.';
    return Response.json({
      name: resource,
      type: 'sdm.devices.types.THERMOSTAT',
      traits: {
        [p + 'Connectivity']: { status: 'ONLINE' },
        [p + 'ThermostatMode']: { mode: 'HEAT', availableModes: ['HEAT', 'OFF'] },
        [p + 'ThermostatEco']: { mode: 'OFF', availableModes: ['MANUAL_ECO', 'OFF'] },
        [p + 'ThermostatTemperatureSetpoint']: { heatCelsius: heat },
      },
    });
  });
  const app = createApp({ config, connection: new GoogleConnection(config) });
  const admin = await login(app, config.origin, ADMIN);
  const response = await send(app, admin.headers, { type: 'heat', heatCelsius: 22 });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.confirmed, true);
  assert.equal(result.snapshot.heatCelsius, 22);
  assert.equal(writes, 1);
  assert.equal(tokenRequests, 1, 'the access token is cached');
});

test('if saved access cannot be read, the user is locked out', async () => {
  const config = readConfig({ ADMIN_CODE: ADMIN, USER_CODE: USER });
  const broken = {
    get: async () => {
      throw new Error('storage down');
    },
    set: async () => {},
  };
  const app = createApp({ config, access: broken });
  assert.equal((await login(app, config.origin, USER)).response.status, 403);
  assert.equal((await login(app, config.origin, ADMIN)).response.status, 200);
});
