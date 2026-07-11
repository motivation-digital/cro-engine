// CRO Operator v1 (read-only "recommend") — AGI-9000326 / AGI-9000575.
// The brain reads gads-service (live Ads COST data — no GA4-conversion dependency) + the CRO funnel,
// and returns ranked, human-approve recommendations. It NEVER writes: each recommendation carries the
// exact gads-service call to apply it, which a human (Console) executes. gads-service enforces its own
// guardrails (PAUSED-by-default, ceiling-guarded budgets, audit log) regardless.

const MCC_ID = '4083624137';

async function gads(env, path) {
  const key = await env.GADS_ADMIN_KEY.get();
  const res = await env.GADS.fetch('https://gads.local' + path, {
    headers: { 'X-Admin-Key': key },
  });
  if (!res.ok) throw new Error('gads ' + path + ' -> ' + res.status);
  return res.json();
}

const digits = (x) => String(x || '').replace(/\D/g, '');

export async function recommend(env, tenant, cid) {
  if (!env.GADS || !env.GADS_ADMIN_KEY) return { ok: false, reason: 'gads binding not configured' };

  // Resolve the account. listAccessibleCustomers returns IDs only (no names), so if there is
  // more than one child under the MCC we ask the caller for ?cid=.
  if (!cid) {
    let accounts;
    try { accounts = await gads(env, '/accounts'); }
    catch (e) { return { ok: false, reason: 'accounts_failed', error: String(e) }; }
    const list = Array.isArray(accounts) ? accounts : (accounts.accounts || accounts.customers || accounts.resourceNames || []);
    const children = list.map(digits).filter((x) => x && x !== MCC_ID);
    if (children.length === 1) cid = children[0];
    else return { ok: true, need_cid: true, accounts: list, note: 'multiple/zero accounts — call again with ?cid=<10-digit id>' };
  }
  cid = digits(cid);

  const [camp, terms, ads, cfg, kw, conv] = await Promise.all([
    gads(env, `/accounts/${cid}/campaigns?days=30`).catch(() => ({ campaigns: [] })),
    gads(env, `/accounts/${cid}/search-terms?days=30`).catch(() => ({ searchTerms: [] })),
    gads(env, `/accounts/${cid}/ads`).catch(() => ({ ads: [] })),
    gads(env, `/accounts/${cid}/config`).catch(() => null),
    gads(env, `/accounts/${cid}/keywords?days=30`).catch(() => ({ keywords: [] })),
    gads(env, `/accounts/${cid}/conversions`).catch(() => ({ conversions: [] })),
  ]);
  const campaigns = camp.campaigns || [];
  const searchTerms = terms.searchTerms || [];
  const keywords = kw.keywords || [];
  const convActions = conv.conversions || [];
  const adList = (ads.ads || []).filter((a) => a.status !== 'REMOVED');
  const nameToId = {};
  campaigns.forEach((c) => { if (c.name) nameToId[c.name] = c.id; });

  const recs = [];

  // Rule 1 — wasteful search terms → campaign negatives (cost with clicks but no conversion).
  searchTerms
    .filter((t) => t.cost > 0 && (t.conversions || 0) === 0 && (t.clicks || 0) >= 2)
    .slice(0, 15)
    .forEach((t) => recs.push({
      type: 'add_negative',
      priority: 'high',
      target: t.term,
      rationale: `£${(t.cost || 0).toFixed(2)} · ${t.clicks} clicks · 0 conv in 30d${t.termEn ? ` ("${t.termEn}")` : ''}`,
      apply: { method: 'POST', path: `/accounts/${cid}/negatives`, body: { campaignId: nameToId[t.campaign], text: t.term, matchType: 'PHRASE' } },
      score: t.cost || 0,
    }));

  // Rule 2 — weak RSAs (Ad Strength): aim for 8+ headlines and 4 descriptions.
  adList.forEach((a) => {
    const h = (a.headlines || []).length, d = (a.descriptions || []).length;
    if (h < 8 || d < 3) recs.push({
      type: 'strengthen_rsa',
      priority: 'medium',
      target: `${a.campaign} / ${a.adGroup}`,
      rationale: `RSA has ${h}/15 headlines, ${d}/4 descriptions — below strength; add assets (Kate copy)`,
      apply: { method: 'POST', path: `/accounts/${cid}/ads`, body: { adGroupId: a.adGroupId, headlines: '[8-15 headlines]', descriptions: '[4 descriptions]', finalUrl: (a.finalUrls || [])[0] || '' } },
      score: (8 - h) + (3 - d) + 1,
    });
  });

  // Budget / spend rollup.
  const enabledBudget = campaigns.filter((c) => c.status === 'ENABLED').reduce((s, c) => s + (c.dailyBudget || 0), 0);
  const ceiling = cfg ? (cfg.dailyCeilingGbp ?? cfg.daily_ceiling_gbp ?? null) : null;
  const spend30 = campaigns.reduce((s, c) => s + (c.cost || 0), 0);
  const conv30 = campaigns.reduce((s, c) => s + (c.conversions || 0), 0);

  // Rule 3 — CPC bid ceiling choking delivery: a max-CPC cap well below the market average CPC
  // means bids rarely win the auction, so spend/impressions stall regardless of budget.
  campaigns.forEach((c) => {
    if (c.status === 'ENABLED' && c.cpcBidCeiling && c.avgCpc && c.cpcBidCeiling < c.avgCpc) {
      recs.push({
        type: 'raise_cpc_ceiling',
        priority: 'high',
        target: c.name,
        rationale: `Max-CPC ceiling £${c.cpcBidCeiling.toFixed(2)} vs market avg CPC £${c.avgCpc.toFixed(2)} (${(c.avgCpc / c.cpcBidCeiling).toFixed(1)}×) — bids can't win auctions, delivery is choked. Raise the CPC ceiling (stays within the £${ceiling ?? '?'} daily-budget guard) or move to conversion bidding once #2 lands.`,
        apply: { method: 'MANUAL', path: `campaign ${c.id} bidding — Google Ads console (no CPC-ceiling API endpoint yet)`, body: null },
        score: 5e8,
      });
    }
  });

  // Rule 4 — the gating priority: no conversions imported means bidding optimises to clicks, not leads.
  if (conv30 === 0 && spend30 > 0) recs.unshift({
    type: 'wire_conversions',
    priority: 'critical',
    target: 'GA4 → Google Ads conversion import',
    rationale: `£${spend30.toFixed(2)} spent / 0 conversions in 30d — link GA4 (${'542615107'}) + import purchase & health_index_complete so bidding targets leads (AGI-9000577 step #2). Everything below is capped in value until this is done.`,
    apply: { method: 'MANUAL', path: 'Google Ads console (help@)', body: null },
    score: 1e9,
  });

  recs.sort((a, b) => (b.score || 0) - (a.score || 0));

  // ── DBC ads doctrine check (brands/dreambody/ads.md DO-NOT table) ─────────────
  // The engine enforces the framework so no session has to remember it. DBC-specific
  // (tenant dreambody.club); other tenants skip until they have their own table.
  const doctrine = [];
  if (tenant === 'dreambody.club') {
    const MEDICAL = /кров|разрыв|орган(?!изм)|гормон|витамин|спрей|боль|болит|лечени|врач|таблетк|мигрен|головн|первые дни/i;
    const INFORMATIONAL = /^\s*(как|сколько|что|почему|зачем)\b|влияет ли/i;
    const flag = (row, severity, detail, fix) => doctrine.push({ row, severity, detail, fix });

    // Row 12 — max CPC must stay £0.15 until survey_start is visible in Ads.
    campaigns.filter((c) => c.cpcBidCeiling && c.cpcBidCeiling > 0.15).forEach((c) =>
      flag(12, 'high', `${c.name}: max CPC £${c.cpcBidCeiling.toFixed(2)} exceeds the held £0.15`, 'revert to £0.15 unless Christopher raised it after survey_start is visible'));
    // Row 13 — never Maximize Clicks uncapped.
    campaigns.filter((c) => c.biddingStrategy === 'TARGET_SPEND' && !c.cpcBidCeiling).forEach((c) =>
      flag(13, 'critical', `${c.name}: Maximize Clicks with no CPC ceiling`, 'set a max CPC bid limit immediately'));
    // Row 5 — phrase/exact only, no broad.
    keywords.filter((k) => /BROAD/i.test(k.matchType || '')).forEach((k) =>
      flag(5, 'high', `broad match keyword "${k.keyword}"`, 'change to phrase or exact'));
    // Row 6 — no medical intent.
    keywords.filter((k) => MEDICAL.test(k.keyword || '')).forEach((k) =>
      flag(6, 'high', `medical-intent keyword "${k.keyword}"`, 'pause; medical intent belongs to content, never ads'));
    // Row 4 — informational queries belong to the article campaign, not main.
    keywords.filter((k) => INFORMATIONAL.test(k.keyword || '')).forEach((k) =>
      flag(4, 'medium', `informational keyword "${k.keyword}"`, 'move to the C0 article campaign (≤£0.15) or organic'));
    // Row 19 — flying blind until survey_start / health_index_complete are imported as Ads conversions.
    // Checked against the actual conversion actions, not a click/conv count (a stray purchase must not mask it).
    const hasSurveyConv = convActions.some((c) => /health_index_complete|survey_start/i.test(c.name || ''));
    if (!hasSurveyConv)
      flag(19, 'critical', `survey_start / health_index_complete not imported to Ads (present: ${convActions.map((c) => c.name).join(', ') || 'none'})`, 'mark them GA4 key events and import; do not scale until survey starts are visible');
    doctrine.sort((a, b) => ({ critical: 0, high: 1, medium: 2 }[a.severity] - { critical: 0, high: 1, medium: 2 }[b.severity]));
  }

  return {
    ok: true,
    tenant,
    cid,
    generated_days: 30,
    doctrine,
    summary: {
      campaigns: campaigns.length,
      enabled_daily_budget_gbp: Number(enabledBudget.toFixed(2)),
      ceiling_gbp: ceiling,
      spend_30d_gbp: Number(spend30.toFixed(2)),
      conversions_30d: conv30,
      search_terms: searchTerms.length,
      recommendations: recs.length,
    },
    bidding: campaigns.map((c) => ({
      campaign: c.name,
      status: c.status,
      strategy: c.biddingStrategy,
      cpc_bid_ceiling_gbp: c.cpcBidCeiling || null,
      target_cpa_gbp: c.targetCpa || null,
      target_roas: c.targetRoas || null,
      avg_cpc_gbp: c.avgCpc || null,
      daily_budget_gbp: c.dailyBudget || null,
    })),
    recommendations: recs.slice(0, 25),
  };
}
