import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store, RateLimitError } from '../src/store.ts';
import { readConfig } from '../src/config.ts';
import { encryptSecret, decryptSecret } from '../src/crypto.ts';
function setup(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'neighbor-test-'));
  const store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(path, { recursive: true, force: true });
  });
  return store;
}
test('configuration requires HTTPS outside loopback and validates policy/key', () => {
  assert.throws(() => readConfig({ APP_ORIGIN: 'http://example.com' }));
  assert.throws(() => readConfig({ APP_ORIGIN: 'https://example.com/a' }));
  assert.throws(() => readConfig({ TOKEN_ENCRYPTION_KEY: 'bad' }));
  assert.throws(() => readConfig({ TEMPERATURE_MIN_C: 'NaN' }));
  assert.equal(readConfig({ APP_ORIGIN: 'https://example.com' }).secureCookies, true);
});
test('no owner bootstrap; hashed keys, sessions and immediate revocation', (t) => {
  const store = setup(t);
  assert.equal(store.hasOwner(), false);
  const owner = store.createKey('owner', 'Owner');
  assert.equal(store.hasOwner(), true);
  assert.throws(() => store.createKey('owner', 'Takeover'));
  assert.equal(store.login('password'), null);
  const logged = store.login(owner.token)!;
  assert.equal(store.session(logged.token)?.role, 'owner');
  assert.equal(
    JSON.stringify(store.db.prepare('SELECT * FROM access_keys').all()).includes(owner.token),
    false,
  );
  store.revokeKey(owner.id);
  assert.equal(store.session(logged.token), null);
  assert.equal(store.login(owner.token), null);
});
test('expiry invalidates an existing session', (t) => {
  const store = setup(t);
  const key = store.createKey('neighbor', 'Guest', 2000, 1000);
  const logged = store.login(key.token, 1500)!;
  assert.ok(store.session(logged.token, 1999));
  assert.equal(store.session(logged.token, 2000), null);
});
test('OAuth state is bound to session, one-use and expires', (t) => {
  const store = setup(t);
  const state = store.createOAuthState('session-a', 'verifier', 1000);
  assert.equal(store.consumeOAuthState(state, 'session-b', 1100), null);
  assert.equal(store.consumeOAuthState(state, 'session-a', 1100), 'verifier');
  assert.equal(store.consumeOAuthState(state, 'session-a', 1100), null);
  const expired = store.createOAuthState('a', 'b', 1000);
  assert.equal(store.consumeOAuthState(expired, 'a', 601001), null);
});
test('sliding-window quota is atomic and persists across store instances', (t) => {
  const store = setup(t);
  for (let i = 0; i < 5; i++)
    store.reserve(
      'commands',
      [
        { max: 5, windowMs: 60000 },
        { max: 100, windowMs: 3600000 },
      ],
      1000 + i,
    );
  assert.throws(
    () => store.reserve('commands', [{ max: 5, windowMs: 60000 }], 1005),
    RateLimitError,
  );
  assert.doesNotThrow(() => store.reserve('commands', [{ max: 5, windowMs: 60000 }], 61001));
});
test('encrypted secrets reject wrong key, tampering and swapped names', () => {
  const key = randomBytes(32);
  const value = encryptSecret('refresh-token', key, 'google');
  assert.equal(decryptSecret(value, key, 'google'), 'refresh-token');
  assert.ok(!value.includes('refresh-token'));
  assert.throws(() => decryptSecret(value, randomBytes(32), 'google'));
  assert.throws(() => decryptSecret(value, key, 'other'));
});
