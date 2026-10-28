import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.ts';
import { codeMatches, createSession, readSession } from '../src/crypto.ts';
import { Store, RateLimitError } from '../src/store.ts';

const ADMIN = 'correct-horse-battery-staple';
const codes = { admin: ADMIN, user: 'prancer' };

test('config requires HTTPS outside localhost and a strong, distinct admin code', () => {
  assert.throws(() => readConfig({ APP_ORIGIN: 'http://example.com' }), /HTTPS/);
  assert.equal(readConfig({ URL: 'https://site.netlify.app' }).origin, 'https://site.netlify.app');
  assert.throws(() => readConfig({ ADMIN_CODE: 'short' }), /12 characters/);
  assert.throws(() => readConfig({ ADMIN_CODE: ADMIN, USER_CODE: ADMIN }), /different/);
  assert.throws(() => readConfig({ USER_CODE: 'prancer' }), /ADMIN_CODE/);
  assert.throws(() => readConfig({ TEMPERATURE_MIN_C: '2' }), /5–35/);
  assert.throws(() => readConfig({ GOOGLE_DEVICE_ID: '../other' }), /invalid characters/);
  const config = readConfig({ ADMIN_CODE: ADMIN, USER_CODE: 'prancer' });
  assert.notEqual(config.sessionSecret, readConfig({ ADMIN_CODE: `${ADMIN}!` }).sessionSecret);
});

test('signed sessions reject tampering, expiry, role swaps and changed codes', () => {
  const secret = 'test-secret';
  const now = Date.now();
  const cookie = createSession(secret, 'user', 'prancer', now);
  assert.equal(readSession(secret, cookie, codes, now)?.role, 'user');
  assert.equal(readSession('other-secret', cookie, codes, now), null);
  assert.equal(readSession(secret, cookie.replace(/^user/, 'admin'), codes, now), null);
  assert.equal(readSession(secret, `${cookie}x`, codes, now), null);
  assert.equal(readSession(secret, cookie, codes, now + 31 * 86_400_000), null, 'expired');
  assert.equal(readSession(secret, cookie, { ...codes, user: 'new-code' }, now), null);
  assert.equal(readSession(secret, cookie, { ...codes, user: undefined }, now), null);
  assert.equal(readSession(secret, undefined, codes, now), null);
  const first = readSession(secret, cookie, codes, now)!;
  const other = readSession(secret, createSession(secret, 'user', 'prancer', now + 1), codes, now)!;
  assert.notEqual(first.csrfToken, other.csrfToken, 'CSRF token is bound to the session');
});

test('code comparison is exact and never matches an unset code', () => {
  assert.equal(codeMatches('s', 'prancer', 'prancer'), true);
  assert.equal(codeMatches('s', 'Prancer', 'prancer'), false);
  assert.equal(codeMatches('s', 'prance', 'prancer'), false);
  assert.equal(codeMatches('s', '', undefined), false);
});

test('rate limits use a sliding window', () => {
  const store = new Store();
  const limits = [{ max: 2, windowMs: 1000 }];
  store.reserve('x', limits, 0);
  store.reserve('x', limits, 100);
  assert.throws(() => store.reserve('x', limits, 200), RateLimitError);
  store.reserve('x', limits, 1001);
});
