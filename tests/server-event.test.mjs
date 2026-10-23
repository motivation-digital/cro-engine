import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServerEvent } from '../src/server-event.js';

test('purchase keeps the visitor GA client id, value and consent', () => {
  const { payload } = buildServerEvent({ tenant_id: 'dbc', event_name: 'purchase', client_id: 'GA1.1.123.456', session_id: '1700000000',
    transaction_id: 'pi_1', value: 9.97, currency: 'gbp', item_id: 'start', ad_consent: true });
  assert.equal(payload.client_id, '123.456');
  assert.deepEqual(payload.consent, { ad_user_data: 'GRANTED', ad_personalization: 'GRANTED' });
  const p = payload.events[0].params;
  assert.equal(payload.events[0].name, 'purchase');
  assert.equal(p.transaction_id, 'pi_1');
  assert.equal(p.value, 9.97);
  assert.equal(p.currency, 'GBP');
  assert.equal(p.session_id, 1700000000);
  assert.equal(p.items[0].item_id, 'start');
});

test('signup without a GA cookie gets a stable fallback id and denied ad consent', () => {
  const a = buildServerEvent({ tenant_id: 'dbc', event_name: 'signup_verified', fallback_id: 'sig-1' }).payload;
  const b = buildServerEvent({ tenant_id: 'dbc', event_name: 'signup_verified', fallback_id: 'sig-1' }).payload;
  assert.equal(a.client_id, b.client_id);
  assert.match(a.client_id, /^\d+\.\d+$/);
  assert.equal(a.consent.ad_user_data, 'DENIED');
  assert.equal(a.events[0].params.method, 'email_code');
});

test('rejects unknown events and incomplete purchases', () => {
  assert.ok(buildServerEvent({ tenant_id: 'dbc', event_name: 'page_view', fallback_id: 'x' }).error);
  assert.ok(buildServerEvent({ tenant_id: 'dbc', event_name: 'purchase', fallback_id: 'x', value: 9.97, currency: 'GBP' }).error);
  assert.ok(buildServerEvent({ tenant_id: 'dbc', event_name: 'signup_verified' }).error);
});
