// ─── Tenant resolution from sites.clients ──────────────────────────────────
// Multi-tenant support: resolve tenant config from D1 registry.

export async function getTenant(env, tenantId) {
  if (!env.DB_SITES) {
    console.error('DB_SITES binding not available');
    return null;
  }

  try {
    const row = await env.DB_SITES.prepare(
      'SELECT id, active FROM clients WHERE id = ?'
    ).bind(tenantId).first();

    if (!row || row.active !== 1) {
      console.warn(`Tenant not found or inactive: ${tenantId}`);
      return null;
    }

    return { tenant_id: row.id };
  } catch (error) {
    console.error('getTenant error:', error.message);
    return null;
  }
}
