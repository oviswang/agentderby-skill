#!/usr/bin/env node
/**
 * growth_ads_optimize.mjs (v0.2)
 *
 * Daily optimizer.
 * v0.2 implements two safe automations (owner-approved):
 * 1) Ensure RSA assets are sufficiently filled by creating a new RSA (and pausing the old) when needed.
 * 2) Triage keywords marked as rarely served (primary_status NOT_ELIGIBLE w/ AD_GROUP_CRITERION_RARELY_SERVED): pause them, and add a small set of broader, still-personal-intent keywords.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { mode: 'dry-run', policy: path.resolve(__dirname, '../growth/ads_policy_v0.1.json') };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.mode = 'apply';
    else if (a === '--dry-run') out.mode = 'dry-run';
    else if (a === '--policy') out.policy = argv[++i];
  }
  return out;
}

function nowIso() { return new Date().toISOString(); }

function readEnvFile(envPath) {
  const txt = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    env[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return env;
}

async function httpJson(method, urlStr, { headers = {}, body = null, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(urlStr, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function oauthMintAccessToken({ client_id, client_secret, refresh_token }) {
  const params = new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: params });
  const j = await res.json();
  if (!res.ok) throw new Error(`oauth token error: ${j?.error || res.status}`);
  return j.access_token;
}

function gaqlRows(stream) {
  const out = [];
  for (const chunk of (stream || [])) {
    for (const r of (chunk.results || [])) out.push(r);
  }
  return out;
}

async function googleAdsSearchStream({ developerToken, accessToken, customerId, loginCustomerId, query }) {
  const url = `https://googleads.googleapis.com/v20/customers/${customerId}/googleAds:searchStream`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json'
  };
  if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId);
  return await httpJson('POST', url, { headers, body: { query }, timeoutMs: 30000 });
}

function sqlScalar(dbPath, query) {
  const out = execFileSync('sqlite3', [dbPath, query], { encoding: 'utf8' }).trim();
  if (!out) return 0;
  const n = Number(out);
  return Number.isFinite(n) ? n : 0;
}

async function googleAdsMutateAdGroupAds({ developerToken, accessToken, customerId, loginCustomerId, operations }) {
  const url = `https://googleads.googleapis.com/v20/customers/${customerId}/adGroupAds:mutate`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json'
  };
  if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId);
  return await httpJson('POST', url, { headers, body: { operations, partialFailure: false }, timeoutMs: 30000 });
}

async function googleAdsMutateAdGroupCriteria({ developerToken, accessToken, customerId, loginCustomerId, operations, partialFailure = true }) {
  const url = `https://googleads.googleapis.com/v20/customers/${customerId}/adGroupCriteria:mutate`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json'
  };
  if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId);
  return await httpJson('POST', url, { headers, body: { operations, partialFailure }, timeoutMs: 30000 });
}

function loadKeywordLines(p) {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    return txt.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  } catch { return []; }
}

async function main() {
  const args = parseArgs(process.argv);
  const ts = nowIso();
  const policy = JSON.parse(fs.readFileSync(args.policy, 'utf8'));

  const dbPath = '/home/ubuntu/.openclaw/workspace/control-plane/data/bothook.sqlite';

  const creds = readEnvFile('/home/ubuntu/.openclaw/credentials/google_ads.env');
  const accessToken = await oauthMintAccessToken({
    client_id: creds.GOOGLE_ADS_CLIENT_ID,
    client_secret: creds.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: creds.GOOGLE_ADS_REFRESH_TOKEN,
  });

  const mcc = policy.googleAds.mccCustomerId;
  const customerId = policy.googleAds.clientCustomerId;
  const developerToken = creds.GOOGLE_ADS_DEVELOPER_TOKEN;

  const scope = policy.googleAds.scopes.sgDesktop;
  const campaignId = String((scope.campaignIds || [])[0] || '').trim();
  const adGroupId = String((scope.adGroupIds || [])[0] || '194116886055').trim();

  // Health counters (last 24h)
  const sinceIso = new Date(Date.now() - 24*60*60_000).toISOString();
  const paymentSuccess24h = sqlScalar(dbPath, `SELECT COUNT(*) FROM events WHERE ts >= '${sinceIso}' AND event_type='PAYMENT_SUCCESS';`);

  // ------------- (2) Keyword triage: pause rarely-served keywords -------------
  const rareQ = `
SELECT ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
       ad_group_criterion.primary_status, ad_group_criterion.primary_status_reasons
FROM ad_group_criterion
WHERE ad_group.id=${adGroupId}
  AND ad_group_criterion.type='KEYWORD'
  AND ad_group_criterion.negative=false
  AND ad_group_criterion.status='ENABLED'
  AND ad_group_criterion.primary_status='NOT_ELIGIBLE'
LIMIT 500
`;

  let rare = [];
  try {
    const stream = await googleAdsSearchStream({ developerToken, accessToken, customerId, loginCustomerId: mcc, query: rareQ });
    rare = gaqlRows(stream).map(r => r.adGroupCriterion).filter(Boolean)
      .filter(c => (c.primaryStatusReasons || []).includes('AD_GROUP_CRITERION_RARELY_SERVED'))
      .map(c => ({ resourceName: c.resourceName, text: c.keyword?.text, matchType: c.keyword?.matchType, reasons: c.primaryStatusReasons || [] }));
  } catch { rare = []; }

  const MAX_PAUSE_PER_RUN = Number(policy.optimize?.safety?.maxPauseKeywordsPerRun || 25);
  const toPause = rare.slice(0, MAX_PAUSE_PER_RUN);
  const pauseOps = toPause.map(k => ({ update: { resourceName: k.resourceName, status: 'PAUSED' }, updateMask: 'status' }));

  // Add broader personal-intent keywords to keep volume (phrase only)
  const moreKws = loadKeywordLines('/home/ubuntu/.openclaw/workspace/growth/personal_keywords_v0.2_more_volume.txt');
  const MAX_ADD_PER_RUN = Number(policy.optimize?.safety?.maxAddKeywordsPerRun || 20);
  const addOps = moreKws.slice(0, MAX_ADD_PER_RUN).map(text => ({
    create: {
      adGroup: `customers/${customerId}/adGroups/${adGroupId}`,
      status: 'ENABLED',
      keyword: { text, matchType: 'PHRASE' }
    }
  }));

  // ------------- (1) RSA assets: ensure enough headlines/descriptions -------------
  const rsaQ = `
SELECT ad_group_ad.resource_name, ad_group_ad.status,
       ad_group_ad.policy_summary.review_status, ad_group_ad.policy_summary.approval_status,
       ad_group_ad.ad.id, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions
FROM ad_group_ad
WHERE ad_group.id=${adGroupId}
LIMIT 50
`;

  let rsaRows = [];
  try {
    const stream = await googleAdsSearchStream({ developerToken, accessToken, customerId, loginCustomerId: mcc, query: rsaQ });
    rsaRows = gaqlRows(stream).map(r => r.adGroupAd).filter(Boolean);
  } catch { rsaRows = []; }

  function assetCount(x){
    const h = x?.ad?.responsiveSearchAd?.headlines || [];
    const d = x?.ad?.responsiveSearchAd?.descriptions || [];
    return { headlines: h.length, descriptions: d.length };
  }

  const enabledRsa = rsaRows.filter(r => r.status === 'ENABLED');
  const best = enabledRsa[0] || null;
  const counts = best ? assetCount(best) : { headlines: 0, descriptions: 0 };

  const MIN_HEADLINES = Number(policy.optimize?.rsa?.minHeadlines || 12);
  const MIN_DESCRIPTIONS = Number(policy.optimize?.rsa?.minDescriptions || 3);
  const needRsa = !best || counts.headlines < MIN_HEADLINES || counts.descriptions < MIN_DESCRIPTIONS;

  let rsaOps = [];
  let rsaPlan = null;
  if (needRsa) {
    const assets = JSON.parse(fs.readFileSync('/home/ubuntu/.openclaw/workspace/growth/rsa_assets_en_v0.1.json', 'utf8'));
    const headlines = (assets.headlines || []).slice(0, 15);
    const descriptions = (assets.descriptions || []).slice(0, 4);

    const createOp = {
      create: {
        adGroup: `customers/${customerId}/adGroups/${adGroupId}`,
        status: 'ENABLED',
        ad: {
          finalUrls: ['https://bothook.me/'],
          responsiveSearchAd: {
            headlines: headlines.map(text => ({ text })),
            descriptions: descriptions.map(text => ({ text })),
            path1: assets.path1 || undefined,
            path2: assets.path2 || undefined
          }
        }
      }
    };

    // Pause only one old enabled RSA to keep account tidy.
    const pauseOldOp = best ? { update: { resourceName: best.resourceName, status: 'PAUSED' }, updateMask: 'status' } : null;

    rsaOps = pauseOldOp ? [createOp, pauseOldOp] : [createOp];
    rsaPlan = { create_new: true, pause_old: Boolean(pauseOldOp), old: best?.resourceName || null, old_counts: counts };
  }

  // Apply if requested
  let applied = { paused_keywords: 0, added_keywords: 0, rsa_replaced: false, rsa_result: null, kw_pause_result: null, kw_add_result: null };
  let planned = { pause_keywords: pauseOps.length, add_keywords: addOps.length, rsa_ops: rsaOps.length, need_rsa: needRsa, rsa_plan: rsaPlan };

  if (args.mode === 'apply') {
    if (pauseOps.length) {
      const r = await googleAdsMutateAdGroupCriteria({ developerToken, accessToken, customerId, loginCustomerId: mcc, operations: pauseOps, partialFailure: true });
      applied.paused_keywords = pauseOps.length;
      applied.kw_pause_result = r;
    }
    if (addOps.length) {
      const r = await googleAdsMutateAdGroupCriteria({ developerToken, accessToken, customerId, loginCustomerId: mcc, operations: addOps, partialFailure: true });
      applied.added_keywords = addOps.length;
      applied.kw_add_result = r;
    }
    if (rsaOps.length) {
      const r = await googleAdsMutateAdGroupAds({ developerToken, accessToken, customerId, loginCustomerId: mcc, operations: rsaOps });
      applied.rsa_replaced = true;
      applied.rsa_result = r;
    }
  }

  // Keep existing v0.1 output: top search terms by cost (diagnostic only)
  const qTerms = `
SELECT search_term_view.search_term, metrics.clicks, metrics.impressions, metrics.cost_micros
FROM search_term_view
WHERE segments.date DURING LAST_1_DAY
ORDER BY metrics.cost_micros DESC
LIMIT 50
`;
  let terms = [];
  try {
    const stream = await googleAdsSearchStream({ developerToken, accessToken, customerId, loginCustomerId: mcc, query: qTerms });
    terms = gaqlRows(stream).map(r => ({
      term: r.searchTermView?.searchTerm,
      cost_sgd: Number((Number(r.metrics?.costMicros || 0) / 1e6).toFixed(4)),
      clicks: Number(r.metrics?.clicks || 0),
      impressions: Number(r.metrics?.impressions || 0)
    })).filter(x => x.term);
  } catch { terms = []; }

  const out = {
    ok: true,
    ts,
    mode: args.mode,
    policy_version: policy.version,
    optimize_enabled: true,
    scope: { campaignId, adGroupId },
    customer: { mcc, customerId },
    facts_24h: { payment_success_events: paymentSuccess24h },
    rsa: { enabled_count: enabledRsa.length, enabled_counts: counts, need_rsa: needRsa, plan: planned.rsa_plan },
    keywords: { rarely_served_enabled: rare.length, pause_planned: pauseOps.length, add_planned: addOps.length },
    search_terms_top_50: terms,
    actions: { planned, applied }
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, ts: nowIso(), error: String(err?.message || err) }, null, 2));
  process.exit(1);
});
