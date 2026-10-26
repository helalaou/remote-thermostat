import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';
function setup(t: TestContext, secure = false) {
  const path = mkdtempSync(join(tmpdir(), 'nest-app-'));
  const store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(path, { recursive: true, force: true });
  });
  const config = readConfig({
    APP_ORIGIN: secure ? 'https://example.test' : 'http://localhost:3000',
  });
  return { store, config, app: createApp({ config, store }) };
}
async function login(app: ReturnType<typeof createApp>, origin: string, key: string) {
  const response = await app.request('/api/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  return {
    response,
    cookie: response.headers.get('Set-Cookie')!.split(';')[0],
    data: await response.json(),
  };
}
test('anonymous visitors get no thermostat data or owner configuration and cannot bootstrap', async (t) => {
  const { app } = setup(t);
  assert.equal((await app.request('/healthz')).status, 200);
  assert.deepEqual(await (await app.request('/api/session')).json(), {
    authenticated: false,
    configured: false,
  });
  assert.equal((await app.request('/api/thermostat')).status, 401);
  assert.equal((await app.request('/api/owner/status')).status, 403);
  assert.equal((await app.request('/api/create-owner', { method: 'POST' })).status, 403);
});
test('login requires exact origin and JSON; production cookies are hardened', async (t) => {
  const { app, store, config } = setup(t, true);
  const key = store.createKey('owner', 'Test owner');
  for (const origin of ['https://evil.test', 'null', 'https://example.test.evil.test', ''])
    assert.equal(
      (
        await app.request('/api/login', {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: key.token }),
        })
      ).status,
      403,
    );
  const logged = await login(app, config.origin, key.token);
  assert.equal(logged.response.status, 200);
  const cookie = logged.response.headers.get('Set-Cookie')!;
  for (const part of ['__Host-neighbor-session=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/'])
    assert.ok(cookie.includes(part));
  assert.ok(!cookie.includes(key.token));
  assert.ok(!JSON.stringify(logged.data).includes(key.token));
  assert.equal(logged.response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(logged.response.headers.get('Content-Security-Policy')!, /frame-ancestors 'none'/);
});
test('neighbor cannot connect Google; mutations require session CSRF; revocation is immediate', async (t) => {
  const { app, store, config } = setup(t);
  const key = store.createKey('neighbor', 'Neighbor');
  const logged = await login(app, config.origin, key.token);
  const headers = {
    Origin: config.origin,
    'Content-Type': 'application/json',
    Cookie: logged.cookie,
  };
  assert.equal(
    (await app.request('/api/logout', { method: 'POST', headers, body: '{}' })).status,
    403,
  );
  const authorized = { ...headers, 'X-CSRF-Token': logged.data.csrfToken };
  assert.equal(
    (
      await app.request('/api/owner/google/connect', {
        method: 'POST',
        headers: authorized,
        body: '{}',
      })
    ).status,
    403,
  );
  const status = await (
    await app.request('/api/thermostat', { headers: { Cookie: logged.cookie } })
  ).json();
  assert.equal(status.connected, false);
  assert.equal(status.snapshot, undefined);
  store.revokeKey(key.id);
  assert.equal(
    (await app.request('/api/thermostat', { headers: { Cookie: logged.cookie } })).status,
    401,
  );
});
test('bounded request bodies and login throttling fail safely', async (t) => {
  const { app, config } = setup(t);
  const headers = { Origin: config.origin, 'Content-Type': 'application/json' };
  assert.equal(
    (
      await app.request('/api/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ key: 'x'.repeat(5000) }),
      })
    ).status,
    413,
  );
  for (let i = 0; i < 20; i++)
    await app.request('/api/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'invalid' }),
    });
  const response = await app.request('/api/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ key: 'invalid' }),
  });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('Retry-After')) > 0);
});
test('owner can view setup readiness but Google OAuth stays disabled without configuration', async (t) => {
  const { app, store, config } = setup(t);
  const key = store.createKey('owner', 'Owner');
  const logged = await login(app, config.origin, key.token);
  const data = await (
    await app.request('/api/owner/status', { headers: { Cookie: logged.cookie } })
  ).json();
  assert.equal(data.googleConfigured, false);
  assert.equal(data.googleConnected, false);
  assert.equal(data.accessKeys[0].id, key.id);
  assert.ok(!JSON.stringify(data).includes(key.token));
  assert.equal(
    (
      await app.request('/api/owner/google/connect', {
        method: 'POST',
        headers: {
          Origin: config.origin,
          Cookie: logged.cookie,
          'Content-Type': 'application/json',
          'X-CSRF-Token': logged.data.csrfToken,
        },
        body: '{}',
      })
    ).status,
    503,
  );
});
test('default HTTP service uses only numeric policy and confirms a real mocked command path', async (t) => {
  const { randomBytes } = await import('node:crypto');
  const { encryptSecret } = await import('../src/crypto.ts');
  const { GoogleConnection } = await import('../src/google/connection.ts');
  const { store } = setup(t);
  const config = readConfig({
    GOOGLE_CLIENT_ID: 'fake',
    GOOGLE_CLIENT_SECRET: 'fake',
    GOOGLE_DEVICE_ACCESS_PROJECT_ID: 'fake',
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  });
  store.set(
    'google-refresh',
    encryptSecret('fake-refresh', config.encryptionKey!, 'google-refresh'),
  );
  store.set('google-device-resource', 'enterprises/fake/devices/fake');
  const connection = new GoogleConnection(config, store);
  connection.cached = { token: 'fake-access', expiresAt: Date.now() + 3600000 };
  let heat = 20;
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    assert.ok(
      String(input).startsWith(
        'https://smartdevicemanagement.googleapis.com/v1/enterprises/fake/devices/fake',
      ),
    );
    if (init.method === 'POST') {
      writes++;
      heat = JSON.parse(init.body as string).params.heatCelsius;
      return Response.json({});
    }
    const p = 'sdm.devices.traits.';
    return Response.json({
      name: 'enterprises/fake/devices/fake',
      type: 'sdm.devices.types.THERMOSTAT',
      traits: {
        [p + 'Connectivity']: { status: 'ONLINE' },
        [p + 'ThermostatMode']: { mode: 'HEAT', availableModes: ['HEAT', 'OFF'] },
        [p + 'ThermostatEco']: { mode: 'OFF', availableModes: ['MANUAL_ECO', 'OFF'] },
        [p + 'ThermostatTemperatureSetpoint']: { heatCelsius: heat },
      },
    });
  });
  const app = createApp({ config, store, connection });
  const owner = store.createKey('owner', 'Owner');
  const signed = await login(app, config.origin, owner.token);
  const headers = {
    Origin: config.origin,
    Cookie: signed.cookie,
    'Content-Type': 'application/json',
    'X-CSRF-Token': signed.data.csrfToken,
  };
  const response = await app.request('/api/commands', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      command: { type: 'heat', heatCelsius: 22 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.confirmed, true);
  assert.equal(writes, 1);
  assert.equal(result.snapshot.heatCelsius, 22);
});
test('first Google connection can start without an already discovered device', async (t) => {
  const { randomBytes } = await import('node:crypto');
  const { store } = setup(t);
  const config = readConfig({
    GOOGLE_CLIENT_ID: 'fake',
    GOOGLE_CLIENT_SECRET: 'fake',
    GOOGLE_DEVICE_ACCESS_PROJECT_ID: 'fake',
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  });
  const app = createApp({ config, store });
  const owner = store.createKey('owner', 'Owner');
  const signed = await login(app, config.origin, owner.token);
  const response = await app.request('/api/owner/google/connect', {
    method: 'POST',
    headers: {
      Origin: config.origin,
      Cookie: signed.cookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': signed.data.csrfToken,
    },
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal(new URL((await response.json()).url).hostname, 'nestservices.google.com');
});
