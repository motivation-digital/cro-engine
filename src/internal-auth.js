// ─── Internal-only routes (AGI-9000590) ─────────────────────────────
// /server-event and /purchase write conversions into GA4 (and through it Google Ads), so only our own
// workers may call them: stripe-payments (CRO_COLLECTOR) and dbc-site (CRO) send X-Internal-Auth =
// Secrets Store key cro_internal_key, bound here as CRO_INTERNAL_KEY. Fails closed when the key is bound
// but unreadable. The same internal boundary protects funnel/measurement reads and CRO analysis;
// Console forwards the credential only on the server after its staff session gate. /events (browser)
// and /health remain public; measurement POST retains its separate X-Admin-Key contract.

export async function internalAllowed(req, env) {
  if (!env.CRO_INTERNAL_KEY) return false;
  let key = '';
  try { key = await env.CRO_INTERNAL_KEY.get(); } catch { return false; }
  const got = req.headers.get('X-Internal-Auth') || '';
  if (!key || got.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

export function unauthorized() {
  return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
