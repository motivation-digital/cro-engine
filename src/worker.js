// ─── cro-engine — CRO measurement pipeline + engine ─────────────────────────
// Collector: front-end funnel events + server-side purchase -> GA4 Measurement Protocol (AGI-9000437).
// Engine v1 (read-only): Measure/Diagnose/Hypothesise per tenant -> DB_SITES cro_* tables (AGI-9000326).
// Multi-tenant by brand key.

import { getTenant } from './tenants.js';
import { runCro, readReport, TENANTS } from './cro.js';

// ─── GA4 Measurement Protocol ───────────────────────────────────────

async function forwardToGA4(event, env) {
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

// ─── Consent check ────────────────────────────────────────
// TODO: Wire TrustCentre signal when available (AGI-9000260).

async function checkConsent(req, tenant_id, env) {
  const cookieHeader = req.headers.get('Cookie') || '';
  return true;
}

// ─── Front-end event handler ────────────────────────────────────

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

  const hasConsent = await checkConsent(req, tenant_id, env);
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

  const success = await forwardToGA4(gaEvent, env);

  return new Response(JSON.stringify({ success }), {
    status: success ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Server-side purchase event from stripe-payments ────────────────────

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

  const success = await forwardToGA4(gaEvent, env);

  return new Response(JSON.stringify({ success }), {
    status: success ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Health check ────────────────────────────────────────

async function handleHealth(env) {
  const checks = {
    ga4_measurement_id: !!env.GA4_MEASUREMENT_ID,
    ga4_secret_store: !!env.GA4_API_SECRET,
    db_sites: !!env.DB_SITES,
    ga4_data_api: !!env.GA4_SA, // Measure organ credential (cro-engine-ga4-read) — optional until provisioned
  };
  // ga4_data_api is not required for the collector to be healthy.
  const ok = checks.ga4_measurement_id && checks.ga4_secret_store && checks.db_sites;

  return new Response(JSON.stringify({ ok, service: 'cro-engine', checks }), {
    status: ok ? 200 : 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── CRO engine endpoints (read-only) ───────────────────────────────

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// ─── Main router ──────────────────────────────────────────

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

      if (path === '/health') {
        return await handleHealth(env);
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
