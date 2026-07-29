// Funnel KPI assembler (AGI-9000326) — one front-to-back view of the DBC funnel from every source,
// so decisions are made on real numbers, not guesses. Read-only. Each source is wrapped so one
// failure never blanks the whole view. Benchmark bands are the verified research (deep-research
// 2026-07-11): hold each stage against these as a SANITY CHECK, never as an A/B-tested target until
// volume is real (~a few thousand completions/month + ~100 conversions per variation).

import { eventCounts } from './ga4.js';

const DBC_CID = '5740015733';
const DBC_PAYMENT_TENANT = 'dbc';
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

async function row(db, sql, ...params) {
  try {
    const statement = db.prepare(sql);
    return (await (params.length ? statement.bind(...params) : statement).first()) || {};
  } catch (e) {
    return { _error: String(e && e.message) };
  }
}

export function normalizeRange(range) {
  return ['7', '30', 'all'].includes(String(range)) ? String(range) : '30';
}

function ranged(source, range, allKey, day7Key, day30Key) {
  if (range === '7') return Number(source[day7Key] || 0);
  if (range === '30') return Number(source[day30Key] || 0);
  return Number(source[allKey] || 0);
}

export function paymentStages(p = {}, testSucceeded = {}, requestedRange = '30') {
  const range = normalizeRange(requestedRange);
  const n = (value) => Number(value || 0);
  return {
    checkout_starts: {
      attempts: n(p.attempts),
      distinct_people: n(p.distinct_people),
      last7d: n(p.attempts_7d),
      last30d: n(p.attempts_30d),
      incomplete_attempts: n(p.incomplete_attempts),
      incomplete_people: n(p.incomplete_people),
      incomplete_7d: n(p.incomplete_7d),
      incomplete_30d: n(p.incomplete_30d),
      selected: {
        attempts: ranged(p, range, 'attempts', 'attempts_7d', 'attempts_30d'),
        distinct_people: ranged(p, range, 'distinct_people', 'distinct_people_7d', 'distinct_people_30d'),
        incomplete_attempts: ranged(p, range, 'incomplete_attempts', 'incomplete_7d', 'incomplete_30d'),
        incomplete_people: ranged(p, range, 'incomplete_people', 'incomplete_people_7d', 'incomplete_people_30d'),
      },
      most_recent: p.latest || null,
      note: 'live Stripe checkout attempts; incomplete intents shown separately',
      _error: p._error,
    },
    buyers: {
      total: n(p.buyers),
      last7d: n(p.buyers_7d),
      last30d: n(p.buyers_30d),
      gross_revenue_gbp: n(p.buyer_gross_gbp_pence) / 100,
      revenue_gbp: n(p.buyer_net_gbp_pence) / 100,
      revenue_7d_gbp: n(p.buyer_net_7d_gbp_pence) / 100,
      revenue_30d_gbp: n(p.buyer_net_30d_gbp_pence) / 100,
      selected: {
        total: ranged(p, range, 'buyers', 'buyers_7d', 'buyers_30d'),
        revenue_gbp: ranged(p, range, 'buyer_net_gbp_pence', 'buyer_net_7d_gbp_pence', 'buyer_net_30d_gbp_pence') / 100,
      },
      most_recent: p.latest || null,
      note: 'Health-Index-linked new funnel buyers; ad source is not inferred',
      _error: p._error,
    },
    refunds: {
      total: n(p.refunds),
      last7d: n(p.refunds_7d),
      last30d: n(p.refunds_30d),
      amount_gbp: n(p.refunded_gbp_pence) / 100,
      amount_7d_gbp: n(p.refunded_7d_gbp_pence) / 100,
      amount_30d_gbp: n(p.refunded_30d_gbp_pence) / 100,
      selected: {
        total: ranged(p, range, 'refunds', 'refunds_7d', 'refunds_30d'),
        amount_gbp: ranged(p, range, 'refunded_gbp_pence', 'refunded_7d_gbp_pence', 'refunded_30d_gbp_pence') / 100,
      },
      most_recent: p.latest_refund || null,
      note: 'Stripe refunds; refunded value is excluded from buyer revenue',
      _error: p._error,
    },
    payment_exclusions: {
      operator_tests: n(p.operator_tests),
      existing_customers: n(p.existing_customers),
      off_funnel: n(p.off_funnel),
      total: n(p.operator_tests) + n(p.existing_customers) + n(p.off_funnel),
      test_mode_succeeded: n(testSucceeded.total),
      selected: {
        operator_tests: ranged(p, range, 'operator_tests', 'operator_tests_7d', 'operator_tests_30d'),
        existing_customers: ranged(p, range, 'existing_customers', 'existing_customers_7d', 'existing_customers_30d'),
        off_funnel: ranged(p, range, 'off_funnel', 'off_funnel_7d', 'off_funnel_30d'),
        test_mode_succeeded: ranged(testSucceeded, range, 'total', 'd7', 'd30'),
      },
      note: 'successful payments retained in the ledger but excluded from new funnel buyers',
      _error: p._error || testSucceeded._error,
    },
  };
}

export async function funnel(env, tenant, requestedRange = '30') {
  if (tenant !== 'dreambody.club') return { ok: false, reason: 'only dreambody.club instrumented' };
  const range = normalizeRange(requestedRange);
  const out = {
    ok: true,
    tenant,
    range,
    generated_at: new Date().toISOString(),
    benchmarks: BENCHMARKS,
    stages: {},
    gaps: [],
  };

  // ── Quiz completions (dbc-index D1) — the real leads ──
  if (env.DB_INDEX) {
    const c = await row(env.DB_INDEX,
      "SELECT COUNT(*) total, " +
      "SUM(CASE WHEN datetime(submitted_at)>datetime('now','-24 hours') THEN 1 ELSE 0 END) d1, " +
      "SUM(CASE WHEN datetime(submitted_at)>datetime('now','-7 days') THEN 1 ELSE 0 END) d7, " +
      "SUM(CASE WHEN datetime(submitted_at)>datetime('now','-30 days') THEN 1 ELSE 0 END) d30, " +
      "MAX(submitted_at) latest FROM health_index_results");
    out.stages.quiz_completions = {
      total: c.total,
      last24h: c.d1,
      last7d: c.d7,
      last30d: c.d30,
      selected: range === '7' ? Number(c.d7 || 0) : range === '30' ? Number(c.d30 || 0) : Number(c.total || 0),
      most_recent: c.latest,
      _error: c._error,
    };
  }

  // ── Checkouts + buyers (payments D1) ──
  // `stripe_mode` is payment-environment truth, not attribution truth. The live exclusions
  // registry separates operator tests / known existing customers from new funnel buyers.
  // A non-empty Health Index token is required for funnel eligibility. Refunds and incomplete
  // intents remain visible as their own outcomes. purchased_at is authoritative because
  // created_at is nullable in the live schema.
  if (env.DB_PAYMENTS) {
    const p = await row(env.DB_PAYMENTS, `
      WITH classified AS (
        SELECT p.*,
          COALESCE(p.refunded_amount, 0) AS refund_minor,
          CASE
            WHEN EXISTS (
              SELECT 1 FROM payment_attribution_exclusions e
              WHERE e.tenant_id=p.tenant_id AND e.active=1 AND e.reason='operator_test'
                AND (
                  (e.subject_type='email_like' AND lower(p.email) LIKE lower(e.subject_value))
                  OR (e.subject_type='stripe_customer_id' AND p.stripe_customer_id=e.subject_value)
                )
            ) THEN 'operator_test'
            WHEN EXISTS (
              SELECT 1 FROM payment_attribution_exclusions e
              WHERE e.tenant_id=p.tenant_id AND e.active=1 AND e.reason='existing_customer'
                AND (
                  (e.subject_type='email_like' AND lower(p.email) LIKE lower(e.subject_value))
                  OR (e.subject_type='stripe_customer_id' AND p.stripe_customer_id=e.subject_value)
                )
            ) THEN 'existing_customer'
            WHEN trim(COALESCE(p.token,''))='' THEN 'off_funnel'
            ELSE NULL
          END AS exclusion_reason,
          COALESCE(
            NULLIF(lower(trim(p.email)), ''),
            NULLIF(trim(p.token), ''),
            p.stripe_session_id
          ) AS person_key
        FROM payments p
        WHERE p.tenant_id=? AND p.stripe_mode='live'
      )
      SELECT
        COUNT(*) AS attempts,
        COUNT(DISTINCT person_key) AS distinct_people,
        SUM(CASE WHEN datetime(COALESCE(purchased_at,created_at))>datetime('now','-7 days') THEN 1 ELSE 0 END) AS attempts_7d,
        SUM(CASE WHEN datetime(COALESCE(purchased_at,created_at))>datetime('now','-30 days') THEN 1 ELSE 0 END) AS attempts_30d,
        COUNT(DISTINCT CASE WHEN datetime(COALESCE(purchased_at,created_at))>datetime('now','-7 days') THEN person_key END) AS distinct_people_7d,
        COUNT(DISTINCT CASE WHEN datetime(COALESCE(purchased_at,created_at))>datetime('now','-30 days') THEN person_key END) AS distinct_people_30d,
        SUM(CASE WHEN status NOT IN ('succeeded','partially_refunded','refunded','canceled') THEN 1 ELSE 0 END) AS incomplete_attempts,
        COUNT(DISTINCT CASE WHEN status NOT IN ('succeeded','partially_refunded','refunded','canceled') THEN person_key END) AS incomplete_people,
        SUM(CASE WHEN status NOT IN ('succeeded','partially_refunded','refunded','canceled')
          AND datetime(COALESCE(purchased_at,created_at))>datetime('now','-7 days') THEN 1 ELSE 0 END) AS incomplete_7d,
        SUM(CASE WHEN status NOT IN ('succeeded','partially_refunded','refunded','canceled')
          AND datetime(COALESCE(purchased_at,created_at))>datetime('now','-30 days') THEN 1 ELSE 0 END) AS incomplete_30d,
        COUNT(DISTINCT CASE WHEN status NOT IN ('succeeded','partially_refunded','refunded','canceled')
          AND datetime(COALESCE(purchased_at,created_at))>datetime('now','-7 days') THEN person_key END) AS incomplete_people_7d,
        COUNT(DISTINCT CASE WHEN status NOT IN ('succeeded','partially_refunded','refunded','canceled')
          AND datetime(COALESCE(purchased_at,created_at))>datetime('now','-30 days') THEN person_key END) AS incomplete_people_30d,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason IS NULL THEN 1 ELSE 0 END) AS buyers,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason IS NULL
          AND datetime(COALESCE(purchased_at,created_at))>datetime('now','-7 days') THEN 1 ELSE 0 END) AS buyers_7d,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason IS NULL
          AND datetime(COALESCE(purchased_at,created_at))>datetime('now','-30 days') THEN 1 ELSE 0 END) AS buyers_30d,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason IS NULL
          AND lower(currency)='gbp' THEN price_amount ELSE 0 END) AS buyer_gross_gbp_pence,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason IS NULL
          AND lower(currency)='gbp' THEN price_amount-refund_minor ELSE 0 END) AS buyer_net_gbp_pence,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason IS NULL
          AND lower(currency)='gbp'
          AND datetime(COALESCE(purchased_at,created_at))>datetime('now','-7 days')
          THEN price_amount-refund_minor ELSE 0 END) AS buyer_net_7d_gbp_pence,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason IS NULL
          AND lower(currency)='gbp'
          AND datetime(COALESCE(purchased_at,created_at))>datetime('now','-30 days')
          THEN price_amount-refund_minor ELSE 0 END) AS buyer_net_30d_gbp_pence,
        SUM(CASE WHEN refund_minor>0 THEN 1 ELSE 0 END) AS refunds,
        SUM(CASE WHEN refund_minor>0
          AND datetime(refunded_at)>datetime('now','-7 days') THEN 1 ELSE 0 END) AS refunds_7d,
        SUM(CASE WHEN refund_minor>0
          AND datetime(refunded_at)>datetime('now','-30 days') THEN 1 ELSE 0 END) AS refunds_30d,
        SUM(CASE WHEN refund_minor>0 AND lower(currency)='gbp' THEN refund_minor ELSE 0 END) AS refunded_gbp_pence,
        SUM(CASE WHEN refund_minor>0 AND lower(currency)='gbp'
          AND datetime(refunded_at)>datetime('now','-7 days') THEN refund_minor ELSE 0 END) AS refunded_7d_gbp_pence,
        SUM(CASE WHEN refund_minor>0 AND lower(currency)='gbp'
          AND datetime(refunded_at)>datetime('now','-30 days') THEN refund_minor ELSE 0 END) AS refunded_30d_gbp_pence,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason='operator_test' THEN 1 ELSE 0 END) AS operator_tests,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason='operator_test'
          AND datetime(COALESCE(purchased_at,created_at))>datetime('now','-7 days') THEN 1 ELSE 0 END) AS operator_tests_7d,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason='operator_test'
          AND datetime(COALESCE(purchased_at,created_at))>datetime('now','-30 days') THEN 1 ELSE 0 END) AS operator_tests_30d,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason='existing_customer' THEN 1 ELSE 0 END) AS existing_customers,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason='existing_customer'
          AND datetime(COALESCE(purchased_at,created_at))>datetime('now','-7 days') THEN 1 ELSE 0 END) AS existing_customers_7d,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason='existing_customer'
          AND datetime(COALESCE(purchased_at,created_at))>datetime('now','-30 days') THEN 1 ELSE 0 END) AS existing_customers_30d,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason='off_funnel' THEN 1 ELSE 0 END) AS off_funnel,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason='off_funnel'
          AND datetime(COALESCE(purchased_at,created_at))>datetime('now','-7 days') THEN 1 ELSE 0 END) AS off_funnel_7d,
        SUM(CASE WHEN status IN ('succeeded','partially_refunded') AND exclusion_reason='off_funnel'
          AND datetime(COALESCE(purchased_at,created_at))>datetime('now','-30 days') THEN 1 ELSE 0 END) AS off_funnel_30d,
        MAX(COALESCE(purchased_at,created_at)) AS latest,
        MAX(refunded_at) AS latest_refund
      FROM classified`,
      DBC_PAYMENT_TENANT);
    const testSucceeded = await row(env.DB_PAYMENTS,
      `SELECT COUNT(*) total,
              SUM(CASE WHEN datetime(COALESCE(purchased_at,created_at))>datetime('now','-7 days') THEN 1 ELSE 0 END) d7,
              SUM(CASE WHEN datetime(COALESCE(purchased_at,created_at))>datetime('now','-30 days') THEN 1 ELSE 0 END) d30
       FROM payments WHERE tenant_id=? AND stripe_mode='test' AND status='succeeded'`,
      DBC_PAYMENT_TENANT);
    Object.assign(out.stages, paymentStages(p, testSucceeded, range));
  }

  // ── Paid engagement (Google Ads, selected period) ──
  try {
    const camp = await gads(env, `/accounts/${DBC_CID}/campaigns?days=${range}`);
    const cs = camp.campaigns || [];
    const imp = cs.reduce((s, c) => s + (c.impressions || 0), 0);
    const clk = cs.reduce((s, c) => s + (c.clicks || 0), 0);
    const cost = cs.reduce((s, c) => s + (c.cost || 0), 0);
    out.stages.paid = {
      period: range,
      impressions: imp,
      clicks: clk,
      ctr_pct: imp ? +(clk / imp * 100).toFixed(2) : 0,
      spend_gbp: +cost.toFixed(2),
      avg_cpc_gbp: clk ? +(cost / clk).toFixed(2) : 0,
    };
  } catch (e) { out.stages.paid = { period: range, error: String(e && e.message) }; }

  // ── Traffic (GA4 page_view + session + form events, selected period) ──
  try {
    const sa = JSON.parse(typeof env.GA4_SA === 'string' ? env.GA4_SA : await env.GA4_SA.get());
    const c = await eventCounts(sa, GA4_PROPERTY, range);
    out.stages.traffic = {
      period: range,
      page_views: c.page_view || 0,
      sessions: c.session_start || 0,
      form_start: c.form_start || 0,
      form_submit: c.form_submit || 0,
    };
  } catch (e) { out.stages.traffic = { period: range, error: String(e && e.message) }; }

  // ── Known measurement gaps (be honest about what we cannot yet see) ──
  out.gaps.push('offer_section_visibility — no page-reading tool yet (Microsoft Clarity / Hotjar); cannot see if a completer scrolls to the paid offer on /results (the NOOM hinge)');
  out.gaps.push('video_to_site linkage — cannot tie YouTube views to landing visits or completions');
  out.gaps.push('quiz_start — completions ARE known (D1 contacts, in admin); only quiz STARTS are not here (they live in Typeform analytics — the source of the ~65% completion rate), so completion RATE is not shown in this view');

  return out;
}
