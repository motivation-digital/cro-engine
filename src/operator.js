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

  const [camp, terms, ads, cfg] = await Promise.all([
    gads(env, `/accounts/${cid}/campaigns?days=30`).catch(() => ({ campaigns: [] })),
    gads(env, `/accounts/${cid}/search-terms?days=30`).catch(() => ({ searchTerms: [] })),
    gads(env, `/accounts/${cid}/ads`).catch(() => ({ ads: [] })),
    gads(env, `/accounts/${cid}/config`).catch(() => null),
  ]);
  const campaigns = camp.campaigns || [];
  const searchTerms = terms.searchTerms || [];
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

  return {
    ok: true,
    tenant,
    cid,
    generated_days: 30,
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
