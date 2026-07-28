// ─── cro-engine — CRO measurement pipeline + engine ─────────────────────────
// Collector: front-end funnel events + server-side purchase -> GA4 Measurement Protocol (AGI-9000437).
// Engine v1 (read-only): Measure/Diagnose/Hypothesise per tenant -> DB_SITES cro_* tables (AGI-9000326).
// Multi-tenant by brand key.

import { getTenant } from './tenants.js';
import { runCro, readReport, TENANTS } from './cro.js';
import { recommend } from './operator.js';
import { funnel } from './funnel.js';
import { ensureKeyEvent, eventCounts, measurementConfig } from './ga4.js';

// ─── GA4 Measurement Protocol ──────────────────────

function hashId(value) {
  let hash = 2166136261;
  for (const ch of String(value || '')) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return String((hash >>> 0) || 1);
}

function gaClientId(value) {
  const raw = String(value || '');
  const cookie = raw.match(/(?:GA\d+\.\d+\.)?(\d+\.\d+)$/);
  if (cookie) return cookie[1];
  const seed = raw || crypto.randomUUID();
  return hashId(seed) + '.' + hashId(seed + ':ga4');
}

function gaSessionId(value) {
  const raw = String(value || '');
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}

// Measurement Protocol accepts credentials in the request URL, not the JSON payload. A 2xx from
// /mp/collect only means Google received the request, so setup also uses the validation endpoint.
async function forwardToGA4(event, env, clientId) {
  if (!env.GA4_MEASUREMENT_ID) {
    console.warn('GA4_MEASUREMENT_ID not set');
    return;
  }

  const secret = await env.GA4_API_SECRET.get();
  if (!secret) {
    console.error('GA4_API_SECRET not found in Secrets Store');
    return;
  }

  const payload = { client_id: gaClientId(clientId), events: [event] };
  const query =
    '?measurement_id=' + encodeURIComponent(env.GA4_MEASUREMENT_ID) +
    '&api_secret=' + encodeURIComponent(secret);

  try {
    const response = await fetch('https://region1.google-analytics.com/mp/collect' + query, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`GA4 forward failed: HTTP ${response.status}`, await response.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error('GA4 forward error:', error.message);
    return false;
  }
}

async function validateGA4(env, eventName) {
  const secret = await env.GA4_API_SECRET.get();
  const query =
    '?measurement_id=' + encodeURIComponent(env.GA4_MEASUREMENT_ID) +
    '&api_secret=' + encodeURIComponent(secret);
  const res = await fetch('https://region1.google-analytics.com/debug/mp/collect' + query, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: '9000575.9000575',
      validation_behavior: 'ENFORCE_RECOMMENDATIONS',
      events: [{ name: eventName, params: { engagement_time_msec: 100 } }],
    }),
  });
  if (!res.ok) throw new Error('GA4 validation ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.json();
}

async function ga4ServiceAccount(env) {
  const raw = typeof env.GA4_SA === 'string' ? env.GA4_SA : await env.GA4_SA.get();
  return JSON.parse(raw);
}

async function measurementStatus(env, tenant) {
  const cfg = TENANTS[tenant];
  if (!cfg) return { ok: false, reason: 'unknown_tenant' };
  const sa = await ga4ServiceAccount(env);
  const [config, counts7d, counts30d, validation] = await Promise.all([
    measurementConfig(sa, cfg.ga4_property),
    eventCounts(sa, cfg.ga4_property, 7),
    eventCounts(sa, cfg.ga4_property, 30),
    validateGA4(env, 'health_index_complete'),
  ]);
  const keyEvent = config.keyEvents.find((k) => k.eventName === 'health_index_complete') || null;
  const adsLink = config.googleAdsLinks.find((l) => String(l.customerId) === '5740015733') || null;
  return {
    ok: true,
    tenant,
    propertyId: cfg.ga4_property,
    measurementId: env.GA4_MEASUREMENT_ID,
    healthIndex: {
      keyEvent,
      eventCount7d: counts7d.health_index_complete || 0,
      eventCount30d: counts30d.health_index_complete || 0,
      payloadValid: !(validation.validationMessages || []).length,
      validationMessages: validation.validationMessages || [],
    },
    purchase: {
      eventCount7d: counts7d.purchase || 0,
      eventCount30d: counts30d.purchase || 0,
    },
    googleAds: {
      linked: !!adsLink,
      link: adsLink,
    },
    requirements: [
      ...(!keyEvent ? ['Create health_index_complete as a GA4 key event'] : []),
      ...(!adsLink ? ['Link GA4 property ' + cfg.ga4_property + ' to Google Ads 5740015733'] : []),
      ...((validation.validationMessages || []).length ? ['Correct the GA4 Measurement Protocol payload'] : []),
    ],
  };
}

async function setupMeasurement(req, env, tenant) {
  const key = await env.GADS_ADMIN_KEY.get();
  if (!key || req.headers.get('x-admin-key') !== key) return json({ error: 'unauthorized' }, 401);
  const cfg = TENANTS[tenant];
  if (!cfg) return json({ error: 'unknown_tenant' }, 404);
  const sa = await ga4ServiceAccount(env);
  const keyEvent = await ensureKeyEvent(sa, cfg.ga4_property, 'health_index_complete');
  return json({ ok: true, keyEvent, status: await measurementStatus(env, tenant) });
}

// ─── Consent check ───────────────────────────
// Zaraz Consent (AGI-9000440) is the primary gate on the browser — when analytics consent is
// denied the tag never fires, so /events is a belt-and-braces backstop. Block ONLY on an
// explicit denial signal (body field or cookie); absence = allow, so legitimate live analytics
// (which today carry no signal) keep flowing. Server-side /purchase is first-party transactional
// and never calls this. TODO: wire TrustCentre signal when available (AGI-9000260).

function isDenied(value) {
  const v = String(value || '').toLowerCase();
  return v === 'denied' || v === 'false' || v === '0' || v === 'deny';
}

async function checkConsent(req, tenant_id, env, body) {
  // Explicit body signal from the page takes precedence.
  if (body && body.consent !== undefined) {
    return !isDenied(body.consent);
  }
  // Fallback: a consent cookie if the CMP sets one on this origin.
  const cookieHeader = req.headers.get('Cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)(?:cf_consent|consent)=([^;]+)/i);
  if (match) {
    return !isDenied(decodeURIComponent(match[1]));
  }
  // No signal present -> allow (Zaraz already gated upstream).
  return true;
}

// ─── Front-end event handler ────────────────────────

async function handleFrontendEvent(req, env) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { tenant_id, client_id, session_id, user_id, event_name, event_params } = body;

  if (!tenant_id || !event_name) {
    return new Response(JSON.stringify({ error: 'tenant_id and event_name required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const hasConsent = await checkConsent(req, tenant_id, env, body);
  if (!hasConsent) {
    return new Response(JSON.stringify({ success: false, reason: 'no_consent' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const params = {
    ...(event_params || {}),
    engagement_time_msec: Number(event_params?.engagement_time_msec || 100),
  };
  const numericSessionId = gaSessionId(session_id);
  if (numericSessionId) params.session_id = numericSessionId;
  const gaEvent = { name: event_name, params };

  if (user_id) {
    gaEvent.user_id = user_id;
  }

  const success = await forwardToGA4(gaEvent, env, client_id || user_id || session_id);

  return new Response(JSON.stringify({ success }), {
    status: success ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Server-side purchase event from stripe-payments ────────────────

async function handleServerPurchase(req, env) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { tenant_id, email, price_amount, currency, session_id, token } = body;

  if (!tenant_id || !email || !price_amount || !currency) {
    return new Response(
      JSON.stringify({ error: 'tenant_id, email, price_amount, currency required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const valueInMajorUnits = price_amount / 100;

  const params = {
    transaction_id: token || `stripe-${Date.now()}`,
    affiliation: tenant_id,
    value: Number(valueInMajorUnits),
    currency: currency.toUpperCase(),
    engagement_time_msec: 100,
  };
  const numericSessionId = gaSessionId(session_id);
  if (numericSessionId) params.session_id = numericSessionId;
  const gaEvent = {
    name: 'purchase',
    params,
  };

  const success = await forwardToGA4(gaEvent, env, session_id || token);

  return new Response(JSON.stringify({ success }), {
    status: success ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Typeform webhook (completion diagnostic) ────────────────────
// The DBC health-index quiz is a Typeform popup (form nwPP4TfP). Typeform Plus keeps webhooks
// (the native GA4 connector is gated behind Business). This webhook is a reliable server-side
// completion diagnostic, but it cannot carry the visitor's GA identity. The primary attributed
// health_index_complete lead is emitted once by dbc-index when the results data is read.
// Signature: if TYPEFORM_WEBHOOK_SECRET is bound, verify the `Typeform-Signature` header
// (sha256=base64(HMAC-SHA256(secret, rawBody))); if unset, accept (turn on verification later).

async function hmacSha256Base64(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const bytes = new Uint8Array(sig);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function handleTypeform(req, env) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  const raw = await req.text();

  const secret = env.TYPEFORM_WEBHOOK_SECRET; // secret_text string, optional
  if (secret) {
    const provided = req.headers.get('typeform-signature') || '';
    const expected = 'sha256=' + (await hmacSha256Base64(secret, raw));
    if (provided !== expected) {
      return new Response(JSON.stringify({ success: false, reason: 'bad_signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  let body;
  try { body = JSON.parse(raw); } catch { return new Response('Invalid JSON', { status: 400 }); }

  const fr = (body && body.form_response) || {};
  const clientId = fr.token || crypto.randomUUID();
  const gaEvent = {
    name: 'health_index_complete_server',
    params: {
      form_id: fr.form_id || '',
      engagement_time_msec: 100,
    },
  };

  const success = await forwardToGA4(gaEvent, env, clientId);
  return new Response(JSON.stringify({ success, verified: !!secret }), {
    status: success ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Health check ───────────────────────────

async function handleHealth(env) {
  const checks = {
    ga4_measurement_id: !!env.GA4_MEASUREMENT_ID,
    ga4_secret_store: !!env.GA4_API_SECRET,
    db_sites: !!env.DB_SITES,
    ga4_data_api: !!env.GA4_SA, // Measure organ credential (GA4_SA_JSON) — optional until provisioned
    typeform_verify: !!env.TYPEFORM_WEBHOOK_SECRET, // webhook HMAC verification on/off (optional)
    gads_operator: !!env.GADS && !!env.GADS_ADMIN_KEY, // CRO Operator -> gads-service (recommend)
  };
  // ga4_data_api / typeform_verify are not required for the collector to be healthy.
  const ok = checks.ga4_measurement_id && checks.ga4_secret_store && checks.db_sites;

  return new Response(JSON.stringify({ ok, service: 'cro-engine', checks }), {
    status: ok ? 200 : 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── CRO engine endpoints (read-only) ───────────────────

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// ─── Main router ─────────────────────────

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === '/events' && req.method === 'POST') {
        return await handleFrontendEvent(req, env);
      }

      if (path === '/purchase' && req.method === 'POST') {
        return await handleServerPurchase(req, env);
      }

      if (path === '/typeform' && req.method === 'POST') {
        return await handleTypeform(req, env);
      }

      if (path === '/health') {
        return await handleHealth(env);
      }

      const measurement = path.match(/^\/measurement\/([^/]+)$/);
      if (measurement) {
        const tenant = decodeURIComponent(measurement[1]);
        if (req.method === 'GET') return json(await measurementStatus(env, tenant));
        if (req.method === 'POST') return setupMeasurement(req, env, tenant);
        return new Response('Method not allowed', { status: 405 });
      }

      // Funnel KPIs (read-only): /funnel/:tenant (GET) — one front-to-back view from every source.
      if (path.startsWith('/funnel/') && req.method === 'GET') {
        return json(await funnel(env, decodeURIComponent(path.slice('/funnel/'.length))));
      }

      // CRO Operator (read-only recommend): /operator/:tenant/recommend?cid= (GET)
      if (path.startsWith('/operator/') && path.endsWith('/recommend') && req.method === 'GET') {
        const tenant = decodeURIComponent(path.slice('/operator/'.length, -('/recommend'.length)));
        return json(await recommend(env, tenant, url.searchParams.get('cid')));
      }

      // CRO engine (read-only): /cro/:tenant/report (GET) | /cro/:tenant/run (POST)
      const cro = path.match(/^\/cro\/([^/]+)\/(report|run)$/);
      if (cro) {
        const tenant = decodeURIComponent(cro[1]);
        if (cro[2] === 'report' && req.method === 'GET') {
          return json(await readReport(env, tenant));
        }
        if (cro[2] === 'run' && req.method === 'POST') {
          return json(await runCro(env, tenant));
        }
        return new Response('Method not allowed', { status: 405 });
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('Uncaught error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },

  // Daily CRO run per tenant (Measure/Diagnose/Hypothesise). No-ops gracefully until GA4_SA is provisioned.
  async scheduled(event, env, ctx) {
    for (const tenant of Object.keys(TENANTS)) {
      ctx.waitUntil(runCro(env, tenant).catch((e) => console.error('cro cron', tenant, e && e.message)));
    }
  },
};
