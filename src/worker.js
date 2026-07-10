// ─── cro-engine — CRO measurement pipeline + engine ─────────────────────────
// Collector: front-end funnel events + server-side purchase -> GA4 Measurement Protocol (AGI-9000437).
// Engine v1 (read-only): Measure/Diagnose/Hypothesise per tenant -> DB_SITES cro_* tables (AGI-9000326).
// Multi-tenant by brand key.

import { getTenant } from './tenants.js';
import { runCro, readReport, TENANTS } from './cro.js';
import { recommend } from './operator.js';

// ─── GA4 Measurement Protocol ──────────────────────

// clientId: GA4 MP drops events without a client_id. Callers pass a stable id (e.g. a Typeform
// token or Stripe session) so related events attribute together; otherwise a random id is used
// so the event still lands.
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

  const payload = {
    measurement_id: env.GA4_MEASUREMENT_ID,
    api_secret: secret,
    client_id: clientId || crypto.randomUUID(),
    events: [event],
  };

  try {
    const response = await fetch('https://www.google-analytics.com/mp/collect', {
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

  const { tenant_id, session_id, user_id, event_name, event_params } = body;

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

  const gaEvent = {
    name: event_name,
    params: {
      session_id: session_id || '',
      engagement_time_msec: String(event_params?.engagement_time_msec || 100),
      ...(event_params || {}),
    },
  };

  if (user_id) {
    gaEvent.user_id = user_id;
  }

  const success = await forwardToGA4(gaEvent, env, session_id || user_id);

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

  const gaEvent = {
    name: 'purchase',
    params: {
      transaction_id: token || `stripe-${Date.now()}`,
      affiliation: tenant_id,
      value: String(valueInMajorUnits),
      currency: currency.toUpperCase(),
      session_id: session_id || '',
      engagement_time_msec: String(100),
    },
  };

  const success = await forwardToGA4(gaEvent, env, session_id || token);

  return new Response(JSON.stringify({ success }), {
    status: success ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Typeform webhook (health_index_complete) ────────────────────
// The DBC health-index quiz is a Typeform popup (form nwPP4TfP). Typeform Plus keeps webhooks
// (the native GA4 connector is gated behind Business) — so on submit Typeform POSTs here and we
// forward a health_index_complete conversion to GA4 server-side. Reliable (fires even if the tab
// closes), no client JS, no CSP change, no plan upgrade.
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
    name: 'health_index_complete',
    params: {
      form_id: fr.form_id || '',
      session_id: fr.token || '',
      engagement_time_msec: String(100),
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

      // CRO Operator (read-only recommend): /operator/:tenant/recommend?cid= (GET)
      const op = path.match(/^/operator/([^/]+)/recommend$/);
      if (op && req.method === 'GET') {
        return json(await recommend(env, decodeURIComponent(op[1]), url.searchParams.get('cid')));
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
