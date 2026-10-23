// ─── Server-side conversions for the new DBC funnel (AGI-9000826 / AGI-9000590) ─────────────
// POST /server-event  { tenant_id, event_name, client_id?, session_id?, fallback_id, transaction_id?,
//                       value?, currency?, ad_consent?, debug? }
//
// signup_verified comes from dbc-site when the email code is proven; purchase comes from
// stripe-payments when a Start payment is fulfilled; begin_checkout from stripe-payments when a Start or membership
// checkout opens (value + currency + item, no transaction id); chat_open / chat_topic / chat_question /
// chat_checkout from dbc-site when the Start funnel chat is used (params trigger, topic, chat_page). All carry the visitor's own GA client id
// (the _ga cookie captured at signup), so GA4 joins the conversion to the session that carried the
// gclid/UTMs. Without it the event still counts, under a stable id derived from fallback_id.
// ad_consent mirrors the visitor's Consent Mode choice (ad_user_data + ad_personalization).
// debug=true sends to GA4's validation endpoint instead: nothing is recorded, the validation
// messages come back. The test lanes always set it, so test traffic never reaches live GA4.

export const CHAT_EVENTS = new Set(['chat_open', 'chat_topic', 'chat_question', 'chat_checkout']);
export const SERVER_EVENTS = new Set(['signup_verified', 'begin_checkout', 'purchase', ...CHAT_EVENTS]);
// Chat params are short labels chosen by our own page code (exit, idle, price, start_pay...), never free text.
const chatParam = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);

function hashId(value) {
  let hash = 2166136261;
  for (const ch of String(value || '')) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return String((hash >>> 0) || 1);
}

export function buildServerEvent(body) {
  const b = body || {};
  if (!b.tenant_id || !SERVER_EVENTS.has(b.event_name)) return { error: 'tenant_id and a supported event_name required' };
  const cid = String(b.client_id || '').match(/^(?:GA\d+\.\d+\.)?(\d+\.\d+)$/);
  const seed = String(b.fallback_id || b.transaction_id || '');
  if (!cid && !seed) return { error: 'client_id or fallback_id required' };
  const params = { engagement_time_msec: 100 };
  const sid = String(b.session_id || '');
  if (/^\d+$/.test(sid) && Number(sid) > 0) params.session_id = Number(sid);
  if (b.event_name === 'purchase') {
    const value = Number(b.value);
    if (!b.transaction_id || !(value > 0) || !/^[A-Za-z]{3}$/.test(String(b.currency || ''))) {
      return { error: 'purchase needs transaction_id, value and currency' };
    }
    params.transaction_id = String(b.transaction_id);
    params.value = value;
    params.currency = String(b.currency).toUpperCase();
    params.affiliation = String(b.tenant_id);
    if (b.item_id) params.items = [{ item_id: String(b.item_id), item_name: String(b.item_name || b.item_id), price: value, quantity: 1 }];
  } else if (b.event_name === 'begin_checkout') {
    const value = Number(b.value);
    if (!(value > 0) || !/^[A-Za-z]{3}$/.test(String(b.currency || ''))) return { error: 'begin_checkout needs value and currency' };
    params.value = value;
    params.currency = String(b.currency).toUpperCase();
    if (b.item_id) params.items = [{ item_id: String(b.item_id), item_name: String(b.item_name || b.item_id), price: value, quantity: 1 }];
  } else if (CHAT_EVENTS.has(b.event_name)) {
    for (const k of ['trigger', 'topic', 'chat_page']) { const v = chatParam(b[k]); if (v) params[k] = v; }
  } else {
    params.method = 'email_code';
  }
  const consent = b.ad_consent ? 'GRANTED' : 'DENIED';
  return {
    payload: {
      client_id: cid ? cid[1] : hashId(seed) + '.' + hashId(seed + ':ga4'),
      consent: { ad_user_data: consent, ad_personalization: consent },
      events: [{ name: b.event_name, params }],
    },
  };
}

export async function handleServerEvent(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const built = buildServerEvent(body);
  if (built.error) return json({ error: built.error }, 400);
  if (!env.GA4_MEASUREMENT_ID) return json({ error: 'ga4_not_configured' }, 503);
  const secret = await env.GA4_API_SECRET.get();
  if (!secret) return json({ error: 'ga4_secret_missing' }, 503);
  const debug = body.debug === true;
  const url = 'https://region1.google-analytics.com/' + (debug ? 'debug/mp/collect' : 'mp/collect') +
    '?measurement_id=' + encodeURIComponent(env.GA4_MEASUREMENT_ID) + '&api_secret=' + encodeURIComponent(secret);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(built.payload) });
    if (!r.ok) {
      console.error(`GA4 server-event failed: HTTP ${r.status}`);
      return json({ success: false, status: r.status }, 502);
    }
    if (debug) {
      const v = await r.json().catch(() => ({}));
      const messages = v.validationMessages || [];
      return json({ success: messages.length === 0, debug: true, validation: messages, event: built.payload.events[0] });
    }
    return json({ success: true });
  } catch (e) {
    console.error('GA4 server-event error:', e?.message || e);
    return json({ success: false }, 502);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
