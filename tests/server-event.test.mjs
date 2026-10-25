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

test('subscribe (first paid membership invoice) carries the purchase params under its own name', () => {
  const { payload } = buildServerEvent({ tenant_id: 'dbc', event_name: 'subscribe', client_id: '123.456', transaction_id: 'in_1', value: 19.95, currency: 'gbp', item_id: 'membership_start_monthly' });
  const p = payload.events[0].params;
  assert.equal(payload.events[0].name, 'subscribe');
  assert.equal(p.transaction_id, 'in_1'); assert.equal(p.value, 19.95); assert.equal(p.currency, 'GBP'); assert.equal(p.items[0].item_id, 'membership_start_monthly');
  assert.ok(buildServerEvent({ tenant_id: 'dbc', event_name: 'subscribe', fallback_id: 'x', value: 19.95, currency: 'GBP' }).error, 'needs a transaction id');
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

test('begin_checkout carries value, currency and item, no transaction id', () => {
  const { payload } = buildServerEvent({ tenant_id: 'dbc', event_name: 'begin_checkout', client_id: '123.456', value: 19.95, currency: 'gbp', item_id: 'membership_start_monthly' });
  const p = payload.events[0].params;
  assert.equal(payload.events[0].name, 'begin_checkout');
  assert.equal(p.value, 19.95); assert.equal(p.currency, 'GBP'); assert.equal(p.items[0].item_id, 'membership_start_monthly');
  assert.equal(p.transaction_id, undefined); assert.equal(p.method, undefined);
  assert.ok(buildServerEvent({ tenant_id: 'dbc', event_name: 'begin_checkout', fallback_id: 'x' }).error);
});

test('chat events carry only cleaned label params', () => {
  const { payload } = buildServerEvent({ tenant_id: 'dbc', event_name: 'chat_open', fallback_id: 'chat:p1', trigger: 'Exit', chat_page: 'start_pay', topic: '<b>x</b>' });
  const p = payload.events[0].params;
  assert.equal(payload.events[0].name, 'chat_open');
  assert.equal(p.trigger, 'exit'); assert.equal(p.chat_page, 'start_pay'); assert.equal(p.topic, 'bxb');
  assert.equal(p.method, undefined); assert.equal(p.value, undefined);
  for (const e of ['chat_topic', 'chat_question', 'chat_checkout']) assert.ok(buildServerEvent({ tenant_id: 'dbc', event_name: e, fallback_id: 'x' }).payload);
});

test('outbound_click carries the link and its short-code labels', () => {
  const p = buildServerEvent({ tenant_id: 'dbc', event_name: 'outbound_click', fallback_id: 'go:1', link_id: 'ig', link_domain: 'www.instagram.com', click_source: 'youtube', click_placement: 'video_description', click_content: '70w9Hrhfg9U<x>' }).payload;
  assert.equal(p.events[0].name, 'outbound_click');
  assert.deepEqual({ ...p.events[0].params, engagement_time_msec: undefined }, { engagement_time_msec: undefined, outbound: true, link_id: 'ig', link_domain: 'www.instagram.com', click_source: 'youtube', click_placement: 'video_description', click_content: '70w9Hrhfg9Ux' });
  assert.ok(buildServerEvent({ tenant_id: 'dbc', event_name: 'outbound_click', fallback_id: 'go:2' }).error);
});

test('calendar events carry the day (1..30) and the page label only', () => {
  const p = buildServerEvent({ tenant_id: 'dbc', event_name: 'calendar_day_done', fallback_id: 'cal:p1', calendar_day: 7, calendar_page: 'Day<x>' }).payload;
  assert.equal(p.events[0].name, 'calendar_day_done');
  assert.equal(p.events[0].params.calendar_day, 7);
  assert.equal(p.events[0].params.calendar_page, 'dayx');
  const q = buildServerEvent({ tenant_id: 'dbc', event_name: 'calendar_start_click', fallback_id: 'cal:p2', calendar_day: 31 }).payload;
  assert.equal(q.events[0].params.calendar_day, undefined);
  assert.ok(buildServerEvent({ tenant_id: 'dbc', event_name: 'calendar_day_open', fallback_id: 'cal:p3' }).payload);
});

test('calendar events carry the day (1..30) and the page label only', () => {
  const p = buildServerEvent({ tenant_id: 'dbc', event_name: 'calendar_day_done', fallback_id: 'cal:p1', calendar_day: 7, calendar_page: 'Day<x>' }).payload;
  assert.equal(p.events[0].name, 'calendar_day_done');
  assert.equal(p.events[0].params.calendar_day, 7);
  assert.equal(p.events[0].params.calendar_page, 'dayx');
  const q = buildServerEvent({ tenant_id: 'dbc', event_name: 'calendar_start_click', fallback_id: 'cal:p2', calendar_day: 31 }).payload;
  assert.equal(q.events[0].params.calendar_day, undefined);
  assert.ok(buildServerEvent({ tenant_id: 'dbc', event_name: 'calendar_day_open', fallback_id: 'cal:p3' }).payload);
});
