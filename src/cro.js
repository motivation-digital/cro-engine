// CRO Engine v1 (read-only) — Measure / Diagnose / Hypothesise. AGI-9000326.
// Reads GA4 -> funnel signal -> ranked leaks -> ranked hypotheses, stored in DB_SITES (cro_* tables).
// No power to change any site (that is v1.1: Experiment/Decide/Apply/Learn).

import { eventCounts } from './ga4.js';

const WINDOW_DAYS = 28;

// Tenant registry (tenant-zero). Mirrors brands/{tenant}/convert-profile.md in the lifecycle repo.
export const TENANTS = {
  'dreambody.club': {
    ga4_property: '542615107',
    funnel: ['page_view', 'health_index_start', 'health_index_complete', 'begin_checkout', 'purchase', 'member_activate'],
  },
};

function hypothesesFor(l) {
  const ideas = {
    'page_view->health_index_start': ['Make the primary CTA above the fold and single-purpose', 'State the value + time-to-complete next to the CTA'],
    'health_index_start->health_index_complete': ['Shorten the quiz / add a progress bar', 'Reduce required fields; defer optional questions'],
    'health_index_complete->begin_checkout': ['Tighten results->offer; restate the personalised value', 'Add social proof + risk-reversal near the offer'],
    'begin_checkout->purchase': ['Reduce checkout friction (fewer fields, wallet pay)', 'Surface trust signals + clear price at checkout'],
    'purchase->member_activate': ['Stronger post-purchase onboarding / first-session nudge', 'Email + in-app prompt to complete activation'],
  };
  const key = l.from + '->' + l.to;
  const list = ideas[key] || ['Investigate this step — largest unexplained drop'];
  const cvrPct = l.cvr != null ? (l.cvr * 100).toFixed(0) : '?';
  return list.map((h, i) => ({
    from: l.from, to: l.to, hypothesis: h,
    rationale: cvrPct + '% step CVR, ~' + l.lost + ' lost in ' + WINDOW_DAYS + 'd (leak rank ' + l.rank + ')',
    rank: l.rank * 10 + i,
  }));
}

// Measure -> Diagnose -> Hypothesise for one tenant. Gated on the GA4 Data API credential.
export async function runCro(env, tenant) {
  const cfg = TENANTS[tenant];
  if (!cfg) return { ok: false, reason: 'unknown_tenant' };
  if (!env.GA4_SA) return { ok: false, reason: 'awaiting GA4 Data API credential (Secrets Store: cro-engine-ga4-read)' };

  let sa;
  try { sa = JSON.parse(await env.GA4_SA.get()); } catch { return { ok: false, reason: 'GA4_SA secret unreadable' }; }

  // ── Measure ──
  let counts;
  try { counts = await eventCounts(sa, cfg.ga4_property, WINDOW_DAYS); }
  catch (e) { return { ok: false, reason: 'measure_failed', error: String(e) }; }

  const funnel = cfg.funnel.map((step, i) => {
    const count = counts[step] || 0;
    const prev = i ? (counts[cfg.funnel[i - 1]] || 0) : null;
    const cvr = prev != null && prev > 0 ? count / prev : null;
    return { step, count, cvr_from_prev: cvr };
  });
  const nowIso = new Date().toISOString();
  const startIso = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  const sig = await env.DB_SITES.prepare(
    'INSERT INTO cro_signals(tenant,window_start,window_end,funnel_json) VALUES(?,?,?,?)'
  ).bind(tenant, startIso, nowIso, JSON.stringify(funnel)).run();
  const signalId = sig.meta && sig.meta.last_row_id;

  // ── Diagnose ── rank leaks by absolute lost, weighted by low step-CVR
  const leaks = [];
  for (let i = 1; i < funnel.length; i++) {
    const from = funnel[i - 1], to = funnel[i];
    if (from.count > 0) {
      const lost = from.count - to.count;
      const cvr = to.cvr_from_prev == null ? 0 : to.cvr_from_prev;
      leaks.push({ from: from.step, to: to.step, cvr, lost, score: lost * (1 - cvr) });
    }
  }
  leaks.sort((a, b) => b.score - a.score);
  leaks.forEach((l, i) => { l.rank = i + 1; });
  await env.DB_SITES.prepare(
    'INSERT INTO cro_diagnoses(tenant,signal_id,leaks_json) VALUES(?,?,?)'
  ).bind(tenant, signalId || null, JSON.stringify(leaks)).run();

  // ── Hypothesise ── deterministic v1 (templated for the top leaks); model enrichment is a later pass
  const hyps = leaks.slice(0, 3).flatMap(hypothesesFor);
  for (const h of hyps) {
    await env.DB_SITES.prepare(
      "INSERT INTO cro_hypotheses(tenant,leak,hypothesis,rationale,rank,status) VALUES(?,?,?,?,?,'proposed')"
    ).bind(tenant, h.from + '->' + h.to, h.hypothesis, h.rationale, h.rank).run();
  }

  return { ok: true, tenant, funnel, leaks: leaks.slice(0, 5), hypotheses: hyps };
}

// Read the latest report for the Console CRO panel.
export async function readReport(env, tenant) {
  if (!TENANTS[tenant]) return { tenant, error: 'unknown_tenant' };
  const sig = await env.DB_SITES.prepare('SELECT * FROM cro_signals WHERE tenant=? ORDER BY id DESC LIMIT 1').bind(tenant).first();
  const diag = await env.DB_SITES.prepare('SELECT * FROM cro_diagnoses WHERE tenant=? ORDER BY id DESC LIMIT 1').bind(tenant).first();
  const hyps = await env.DB_SITES.prepare('SELECT leak,hypothesis,rationale,rank,status FROM cro_hypotheses WHERE tenant=? ORDER BY rank ASC LIMIT 10').bind(tenant).all();
  return {
    tenant,
    measured_at: sig ? sig.created_at : null,
    funnel: sig ? JSON.parse(sig.funnel_json) : null,
    leaks: diag ? JSON.parse(diag.leaks_json) : [],
    hypotheses: (hyps && hyps.results) || [],
  };
}
