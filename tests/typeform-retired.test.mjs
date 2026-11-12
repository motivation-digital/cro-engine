import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.js';

test('retired Typeform route never reads credentials or calls a service', async () => {
  const env = new Proxy({}, { get() { throw new Error('Retired route touched a binding'); } });
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    const response = await worker.fetch(new Request('https://example.invalid/typeform', {
      method, ...(method === 'GET' ? {} : { body: 'malformed, unsigned legacy input' }),
    }), env);
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { error: 'typeform_retired' });
  }
});
test('native conversion endpoints still reject missing internal authentication', async () => {
  for (const endpoint of ['purchase', 'server-event']) {
    const response = await worker.fetch(new Request(`https://example.invalid/${endpoint}`, { method: 'POST', body: '{}' }), {});
    assert.equal(response.status, 401);
  }
});
