import assert from 'node:assert/strict';
const base = process.env.CRO_HOST || 'https://cro-engine.launchpad.workers.dev';
const health = await fetch(base + '/health').then(r => r.json());
assert.ok(process.env.GITHUB_SHA);
assert.equal(health.build_sha, process.env.GITHUB_SHA, 'Deployed SHA must match');
assert.equal(health.checks.typeform_retired, true);
const legacy = await fetch(base + '/typeform', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
assert.equal(legacy.status, 410);
for (const route of ['/purchase', '/server-event']) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 401);
}
for (const [route, method] of [
  ['/funnel/audit-invalid-tenant', 'GET'], ['/measurement/audit-invalid-tenant', 'GET'],
  ['/operator/audit-invalid-tenant/recommend', 'GET'], ['/cro/audit-invalid-tenant/report', 'GET'],
  ['/cro/audit-invalid-tenant/run', 'POST'],
]) {
  const response = await fetch(base + route, { method });
  assert.equal(response.status, 401, route);
}
console.log('PASS: retired webhook rejects requests; conversions and reporting require authentication.');
