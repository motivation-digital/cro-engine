import assert from 'node:assert/strict';
import test from 'node:test';
import { internalAllowed } from '../src/internal-auth.js';

const req = (h) => new Request('https://cro-engine.example/server-event', { method: 'POST', headers: h });
const env = { CRO_INTERNAL_KEY: { get: async () => 'secret-key-123' } };

test('only the shared internal key is accepted', async () => {
  assert.equal(await internalAllowed(req({ 'X-Internal-Auth': 'secret-key-123' }), env), true);
  assert.equal(await internalAllowed(req({ 'X-Internal-Auth': 'secret-key-124' }), env), false);
  assert.equal(await internalAllowed(req({}), env), false);
});

test('fails closed without a readable key', async () => {
  assert.equal(await internalAllowed(req({ 'X-Internal-Auth': 'x' }), {}), false);
  assert.equal(await internalAllowed(req({ 'X-Internal-Auth': 'x' }), { CRO_INTERNAL_KEY: { get: async () => { throw new Error('no'); } } }), false);
});
