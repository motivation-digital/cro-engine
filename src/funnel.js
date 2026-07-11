// Funnel KPI assembler (AGI-9000326) — one front-to-back view of the DBC funnel from every source,
// so decisions are made on real numbers, not guesses. Read-only. Each source is wrapped so one
// failure never blanks the whole view. Benchmark bands are the verified research (deep-research
// 2026-07-11): hold each stage against these as a SANITY CHECK, never as an A/B-tested target until
// volume is real (~a few thousand completions/month + ~100 conversions per variation).

import { eventCounts } from './ga4.js';

const DBC_CID = '5740015733';
const GA4_PROPERTY = '542615107';

// Verified benchmark bands (directional; generic-ecommerce ones are the loosest sanity checks).
const BENCHMARKS = {
  quiz_completion: '25-45% for a long (16+ Q) quiz; DBC runs ~65% on 65 Q, which is above band — a genuine strength, do not touch it',
  checkout_abandonment: '~70% desktop / ~83% mobile is NORMAL (Baymard, 50-study avg) — high abandonment is the baseline, not a broken checkout',
  offer_to_checkout: '~6.8-7.5% add-to-cart, generic ecommerce, directional only',
  test_readiness: 'A/B testing needs ~a few thousand completions/month + ~100 conversions per variation; below that use qualitative (session recordings, user testing), not conversion deltas',
};

async function gads(env, path) {
  const key = await env.GADS_ADMIN_KEY.get();
  const r = await env.GADS.fetch('https://gads.local' + path, { headers: { 'X-Admin-Key': key } });
  if (!r.ok) throw new Error('gads ' + r.status);
  return r.json();
}

async function row(db, sql) {
  try { return (await db.prepare(sql).first()) || {}; } catch (e) { return { _error: String(e && e.message) }; }
}

export async function funnel(env, tenant) {
  if (tenant !== 'dreambody.club') return { ok: false, reason: 'only dreambody.club instrumented' };
  const out = { ok: true, tenant, benchmarks: BENCHMARKS, stages: {}, gaps: [] };

  // ── Quiz completions (dbc-index D1) — the real leads ──
  if (env.DB_INDEX) {
    const c = await row(env.DB_INDEX,
      "SELECT COUNT(*) total, " +
      "SUM(CASE WHEN datetime(submitted_at)>datetime('now','-24 hours') THEN 1 ELSE 0 END) d1, " +
      "SUM(CASE WHEN datetime(submitted_at)>datetime('now','-7 days') THEN 1 ELSE 0 END) d7, " +
      "SUM(CASE WHEN datetime(submitted_at)>datetime('now','-30 days') THEN 1 ELSE 0 END) d30, " +
      "MAX(submitted_at) latest FROM health_index_results");
    out.stages.quiz_completions = { total: c.total, last24h: c.d1, last7d: c.d7, last30d: c.d30, most_recent: c.latest, _error: c._error };
  }

  // ── Checkouts + buyers (payments D1); test transactions excluded from buyers ──
  if (env.DB_PAYMENTS) {
    const co = await row(env.DB_PAYMENTS,
      "SELECT COUNT(DISTINCT email) started_distinct, " +
      "SUM(CASE WHEN datetime(created_at)>datetime('now','-7 days') THEN 1 ELSE 0 END) started_7d FROM payments");
    const b = await row(env.DB_PAYMENTS,
      "SELECT COUNT(*) total, " +
      "SUM(CASE WHEN datetime(created_at)>datetime('now','-7 days') THEN 1 ELSE 0 END) d7, " +
      "SUM(price_amount) rev_pence FROM payments WHERE status='succeeded' " +
      "AND email NOT LIKE '%@motivation.digital' AND email NOT LIKE '%baranenko%'");
    out.stages.checkout_starts = { distinct_people: co.started_distinct, last7d: co.started_7d, _error: co._error };
    out.stages.buyers = { total: b.total || 0, last7d: b.d7 || 0, revenue_gbp: (b.rev_pence || 0) / 100, note: 'test transactions (motivation.digital / baranenko) excluded', _error: b._error };
  }

  // ── Paid engagement (Google Ads, 7d) ──
  try {
    const camp = await gads(env, `/accounts/${DBC_CID}/campaigns?days=7`);
    const cs = camp.campaigns || [];
    const imp = cs.reduce((s, c) => s + (c.impressions || 0), 0);
    const clk = cs.reduce((s, c) => s + (c.clicks || 0), 0);
    const cost = cs.reduce((s, c) => s + (c.cost || 0), 0);
    out.stages.paid_7d = { impressions: imp, clicks: clk, ctr_pct: imp ? +(clk / imp * 100).toFixed(2) : 0, spend_gbp: +cost.toFixed(2), avg_cpc_gbp: clk ? +(cost / clk).toFixed(2) : 0 };
  } catch (e) { out.stages.paid_7d = { error: String(e && e.message) }; }

  // ── Traffic (GA4 page_view + session + form events, 7d) ──
  try {
    const sa = JSON.parse(typeof env.GA4_SA === 'string' ? env.GA4_SA : await env.GA4_SA.get());
    const c = await eventCounts(sa, GA4_PROPERTY, 7);
    out.stages.traffic_7d = { page_views: c.page_view || 0, sessions: c.session_start || 0, form_start: c.form_start || 0, form_submit: c.form_submit || 0 };
  } catch (e) { out.stages.traffic_7d = { error: String(e && e.message) }; }

  // ── Known measurement gaps (be honest about what we cannot yet see) ──
  out.gaps.push('offer_section_visibility — not instrumented; cannot see if a completer reaches the paid offer on /results (the NOOM hinge)');
  out.gaps.push('video_to_site linkage — cannot tie YouTube views to landing visits or completions');
  out.gaps.push('quiz_start — completions are known (D1) but quiz-starts are not captured, so completion RATE is unmeasured here');

  return out;
}
