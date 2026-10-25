import test from 'node:test';
import assert from 'node:assert/strict';
test('Node supports Web Crypto for server-side secrets', () => {
  assert.equal(typeof crypto.getRandomValues, 'function');
});
