import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.js';

const key = 'test-only-cro-service-credential';
const routes = [
  ['/funnel/dreambody.club', 'GET'],
  ['/measurement/dreambody.club', 'GET'],
  ['/operator/dreambody.club/recommend?cid=1234567890', 'GET'],
  ['/cro/dreambody.club/report', 'GET'],
  ['/cro/dreambody.club/run', 'POST'],
];
const request = (path, method, credential) => new Request('https://example.invalid' + path, {
  method, headers: credential ? { 'X-Internal-Auth': credential } : {},
});

test('reporting and analysis reject absent/wrong/unreadable credentials before any data or service access', async () => {
  for (const binding of [undefined, { get: async () => key }, { get: async () => { throw new Error('unavailable'); } }]) {
    const touched = [];
    const env = new Proxy({}, { get(_, name) {
      if (name === 'CRO_INTERNAL_KEY') return binding;
      touched.push(name);
      throw new Error('Unauthorized access to a data binding');
    } });
    for (const [path, method] of routes) for (const credential of [undefined, 'wrong-cro-service-credential']) {
      const response = await worker.fetch(request(path, method, credential), env);
      assert.equal(response.status, 401, path);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
    }
    assert.deepEqual(touched, []);
  }
});

test('authorized reporting keeps existing unknown-tenant responses without data access', async () => {
  const env = { CRO_INTERNAL_KEY: { get: async () => key } };
  for (const [path, method] of routes.filter(([path]) => !path.startsWith('/operator/'))) {
    const response = await worker.fetch(request(path.replace('dreambody.club', 'audit-invalid-tenant'), method, key), env);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.reason || body.error, /unknown_tenant|only dreambody.club instrumented/);
  }
});

test('authorized operator can use the existing GADS service contract', async () => {
  const calls = [];
  const env = {
    CRO_INTERNAL_KEY: { get: async () => key },
    GADS_ADMIN_KEY: { get: async () => 'test-only-advertising-credential' },
    GADS: { async fetch(url, init) {
      calls.push(url);
      assert.equal(init.headers['X-Admin-Key'], 'test-only-advertising-credential');
      return Response.json({ accounts: [] });
    } },
  };
  const response = await worker.fetch(request('/operator/dreambody.club/recommend', 'GET', key), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).need_cid, true);
  assert.deepEqual(calls, ['https://gads.local/accounts']);
});

test('measurement setup retains its distinct admin credential', async () => {
  const env = { GADS_ADMIN_KEY: { get: async () => 'test-only-admin-credential' } };
  const missing = await worker.fetch(request('/measurement/audit-invalid-tenant', 'POST', key), env);
  assert.equal(missing.status, 401);
  const valid = await worker.fetch(new Request('https://example.invalid/measurement/audit-invalid-tenant', {
    method: 'POST', headers: { 'X-Admin-Key': 'test-only-admin-credential' },
  }), env);
  assert.equal(valid.status, 404);
  assert.equal((await valid.json()).error, 'unknown_tenant');
});
