// ─── cro-engine — CRO measurement pipeline ──────────────────────────────────
// Collects front-end funnel events + server-side purchase events.
// Forwards to GA4 Measurement Protocol.
// Multi-tenant by brand key (payment_tenants.tenant_id or sites.clients.id).
// AGI-9000437

import { getTenant } from './tenants.js';

// ─── GA4 Measurement Protocol ───────────────────────────────────────────────

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

// ─── Consent check ─────────────────────────────────────────────────────────
// TODO: Wire TrustCentre signal when available (AGI-9000260).
// Zaraz fallback: check zaraz-consent cookie if no TrustCentre binding.

async function checkConsent(req, tenant_id, env) {
  // Placeholder: always allow for now.
  // Phase 1: Check TrustCentre module if env.TRUST_CENTER binding available
  // Phase 2: Fallback to Zaraz consent cookie parsing
  // Phase 3: Block if no consent OR consent.analytics === false

  const cookieHeader = req.headers.get('Cookie') || '';
  // Zaraz pattern: zaraz-consent={...} — would parse analytics flag if implemented
  // For now: return true (all events fire, pre-consent gate)
  return true;
}

// ─── Front-end event handler ────────────────────────────────────────────────
// POST /events — receives thin first-party signals from the frontend

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

  // Check consent before firing (AGI-9000074 / AGI-9000260 / AGI-9000131)
  const hasConsent = await checkConsent(req, tenant_id, env);
  if (!hasConsent) {
    return new Response(JSON.stringify({ success: false, reason: 'no_consent' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Build GA4 event
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

  // Forward to GA4
  const success = await forwardToGA4(gaEvent, env);

  return new Response(JSON.stringify({ success }), {
    status: success ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Server-side purchase event from stripe-payments ───────────────────────
// POST /purchase — fired after a successful payment is recorded

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

  const {
    tenant_id,
    email,
    price_amount,     // minor units (pence for GBP)
    currency,         // gbp, usd, etc.
    session_id,
    token,
  } = body;

  if (!tenant_id || !email || !price_amount || !currency) {
    return new Response(
      JSON.stringify({ error: 'tenant_id, email, price_amount, currency required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Convert pence to pounds for GA4 (which expects major units)
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

// ─── Health check ──────────────────────────────────────────────────────────

async function handleHealth(env) {
  const checks = {
    ga4_measurement_id: !!env.GA4_MEASUREMENT_ID,
    ga4_secret_store: !!env.GA4_API_SECRET,
    db_sites: !!env.DB_SITES,
  };

  const ok = Object.values(checks).every(v => v);

  return new Response(JSON.stringify({ ok, checks }), {
    status: ok ? 200 : 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Main router ───────────────────────────────────────────────────────────

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

      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('Uncaught error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
