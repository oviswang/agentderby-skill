#!/usr/bin/env node
/**
 * Clone the existing SG desktop search campaign into a US-only campaign for A/B comparison.
 *
 * Creates:
 * - new campaign budget
 * - new campaign (SEARCH, MANUAL_CPC)
 * - location criterion: United States
 * - one ad group cloned from source ad group
 * - enabled keywords + negative keywords cloned from source ad group
 * - one enabled RSA cloned from source ad group (create new; do NOT mutate existing)
 *
 * Usage:
 *   node scripts/gaql_campaign_clone_us.mjs \
 *     --sourceCampaign 23607928260 \
 *     --sourceAdGroup 194116886055 \
 *     --name 'BH-US-DESKTOP Search v0.1' \
 *     --budgetSgd 10 \
 *     --enable
 */

import fs from 'node:fs';

function readEnvFile(p) {
  const t = fs.readFileSync(p, 'utf8');
  const e = {};
  for (const l of t.split(/\r?\n/)) {
    if (!l || l.trim().startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i < 0) continue;
    e[l.slice(0, i)] = l.slice(i + 1);
  }
  return e;
}

function parseArgs(argv) {
  const out = {
    sourceCampaignId: null,
    sourceAdGroupId: null,
    name: 'BH-US-DESKTOP Search v0.1',
    budgetSgd: 10,
    enable: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sourceCampaign') out.sourceCampaignId = String(argv[++i]);
    else if (a === '--sourceAdGroup') out.sourceAdGroupId = String(argv[++i]);
    else if (a === '--name') out.name = String(argv[++i]);
    else if (a === '--budgetSgd') out.budgetSgd = Number(argv[++i]);
    else if (a === '--enable') out.enable = true;
  }
  return out;
}

async function oauthMintAccessToken({ client_id, client_secret, refresh_token }) {
  const params = new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: params });
  const j = await res.json();
  if (!res.ok) throw new Error(`oauth token error: ${j?.error || res.status}`);
  return j.access_token;
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

function flat(stream) {
  const out = [];
  for (const c of (stream || [])) for (const r of (c.results || [])) out.push(r);
  return out;
}

async function googleAdsSearchStream({ accessToken, developerToken, customerId, loginCustomerId, query }) {
  const url = `https://googleads.googleapis.com/v20/customers/${customerId}/googleAds:searchStream`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json',
  };
  if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId);
  return await httpJson('POST', url, { headers, body: { query }, timeoutMs: 30000 });
}

async function mutate({ accessToken, developerToken, customerId, loginCustomerId, service, operations }) {
  const url = `https://googleads.googleapis.com/v20/customers/${customerId}/${service}:mutate`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json',
  };
  if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId);
  return await httpJson('POST', url, { headers, body: { operations }, timeoutMs: 30000 });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.sourceCampaignId) throw new Error('missing --sourceCampaign <id>');
  if (!args.sourceAdGroupId) throw new Error('missing --sourceAdGroup <id>');
  if (!Number.isFinite(args.budgetSgd) || args.budgetSgd <= 0) throw new Error('bad --budgetSgd');

  const policy = JSON.parse(fs.readFileSync('growth/ads_policy_v0.1.json', 'utf8'));
  const creds = readEnvFile('/home/ubuntu/.openclaw/credentials/google_ads.env');

  const accessToken = await oauthMintAccessToken({
    client_id: creds.GOOGLE_ADS_CLIENT_ID,
    client_secret: creds.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: creds.GOOGLE_ADS_REFRESH_TOKEN,
  });

  const developerToken = creds.GOOGLE_ADS_DEVELOPER_TOKEN;
  const mcc = policy.googleAds.mccCustomerId;
  const customerId = policy.googleAds.clientCustomerId;

  // 1) Resolve US geo target.
  const geoQ = `SELECT geo_target_constant.resource_name, geo_target_constant.id, geo_target_constant.name, geo_target_constant.country_code, geo_target_constant.target_type
FROM geo_target_constant
WHERE geo_target_constant.country_code = 'US'
  AND geo_target_constant.target_type IN ('Country','Region')
ORDER BY geo_target_constant.target_type
LIMIT 10`;
  const geoS = await googleAdsSearchStream({ accessToken, developerToken, customerId, loginCustomerId: mcc, query: geoQ });
  const geoRows = flat(geoS).map(r => r.geoTargetConstant).filter(Boolean);
  const usGeo = geoRows.find(x => x.countryCode === 'US' && x.targetType === 'Country') || geoRows[0];
  if (!usGeo?.resourceName) throw new Error('US geo_target_constant not found');

  // 2) Create new budget.
  const budgetName = `${args.name} budget`;
  const budgetMicros = Math.round(args.budgetSgd * 1_000_000);
  const budRes = await mutate({
    accessToken, developerToken, customerId, loginCustomerId: mcc,
    service: 'campaignBudgets',
    operations: [{
      create: {
        name: budgetName,
        amountMicros: budgetMicros,
        deliveryMethod: 'STANDARD',
        explicitlyShared: false,
      }
    }]
  });
  const budgetResourceName = budRes?.results?.[0]?.resourceName;
  if (!budgetResourceName) throw new Error('budget create failed');

  // 3) Create new campaign.
  const campRes = await mutate({
    accessToken, developerToken, customerId, loginCustomerId: mcc,
    service: 'campaigns',
    operations: [{
      create: {
        name: args.name,
        status: args.enable ? 'ENABLED' : 'PAUSED',
        advertisingChannelType: 'SEARCH',
        campaignBudget: budgetResourceName,
        manualCpc: {},
        containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        networkSettings: {
          targetGoogleSearch: true,
          targetSearchNetwork: true,
          targetContentNetwork: false,
          targetPartnerSearchNetwork: false,
        }
      }
    }]
  });
  const campaignResourceName = campRes?.results?.[0]?.resourceName;
  if (!campaignResourceName) throw new Error('campaign create failed');
  const newCampaignId = String(campaignResourceName.split('/').pop());

  // 4) Add US location criterion.
  await mutate({
    accessToken, developerToken, customerId, loginCustomerId: mcc,
    service: 'campaignCriteria',
    operations: [{
      create: {
        campaign: campaignResourceName,
        location: { geoTargetConstant: usGeo.resourceName },
        negative: false
      }
    }]
  });

  // 5) Create an ad group.
  const agRes = await mutate({
    accessToken, developerToken, customerId, loginCustomerId: mcc,
    service: 'adGroups',
    operations: [{
      create: {
        name: 'BH-US Ad Group 1',
        campaign: campaignResourceName,
        status: args.enable ? 'ENABLED' : 'PAUSED',
        type: 'SEARCH_STANDARD'
      }
    }]
  });
  const adGroupResourceName = agRes?.results?.[0]?.resourceName;
  if (!adGroupResourceName) throw new Error('ad group create failed');
  const newAdGroupId = String(adGroupResourceName.split('/').pop());

  // 6) Clone enabled keywords + negatives from source ad group.
  const kwQ = `SELECT ad_group_criterion.criterion_id, ad_group_criterion.status, ad_group_criterion.negative,
  ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
FROM ad_group_criterion
WHERE ad_group.id = ${args.sourceAdGroupId}
  AND ad_group_criterion.type = KEYWORD
  AND ad_group_criterion.status != 'REMOVED'
LIMIT 1000`;
  const kwS = await googleAdsSearchStream({ accessToken, developerToken, customerId, loginCustomerId: mcc, query: kwQ });
  const kwRows = flat(kwS).map(r => r.adGroupCriterion).filter(Boolean);

  const kwOps = [];
  for (const k of kwRows) {
    if (!k.keyword?.text || !k.keyword?.matchType) continue;
    kwOps.push({
      create: {
        adGroup: adGroupResourceName,
        status: (k.status === 'ENABLED') ? (args.enable ? 'ENABLED' : 'PAUSED') : k.status,
        negative: Boolean(k.negative),
        keyword: { text: k.keyword.text, matchType: k.keyword.matchType }
      }
    });
  }
  // chunk mutate
  for (let i = 0; i < kwOps.length; i += 2000) {
    await mutate({ accessToken, developerToken, customerId, loginCustomerId: mcc, service: 'adGroupCriteria', operations: kwOps.slice(i, i + 2000) });
  }

  // 7) Clone one enabled RSA from source ad group.
  const adQ = `SELECT ad_group_ad.status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
  ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2
FROM ad_group_ad
WHERE ad_group.id = ${args.sourceAdGroupId}
  AND ad_group_ad.status = 'ENABLED'
  AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
LIMIT 5`;
  const adS = await googleAdsSearchStream({ accessToken, developerToken, customerId, loginCustomerId: mcc, query: adQ });
  const adRows = flat(adS).map(r => r.adGroupAd).filter(Boolean);
  const src = adRows[0];
  if (src?.ad?.responsiveSearchAd?.headlines?.length && src?.ad?.responsiveSearchAd?.descriptions?.length) {
    const rsa = src.ad.responsiveSearchAd;
    const finalUrls = (src.ad.finalUrls || []).slice(0, 5);
    const op = {
      create: {
        adGroup: adGroupResourceName,
        status: args.enable ? 'ENABLED' : 'PAUSED',
        ad: {
          finalUrls,
          responsiveSearchAd: {
            headlines: rsa.headlines,
            descriptions: rsa.descriptions,
            path1: rsa.path1 || undefined,
            path2: rsa.path2 || undefined,
          }
        }
      }
    };
    await mutate({ accessToken, developerToken, customerId, loginCustomerId: mcc, service: 'adGroupAds', operations: [op] });
  }

  console.log(JSON.stringify({
    ok: true,
    created: {
      campaignId: newCampaignId,
      campaignResourceName,
      budgetResourceName,
      adGroupId: newAdGroupId,
      adGroupResourceName,
      location: { usGeo }
    },
    source: { campaignId: args.sourceCampaignId, adGroupId: args.sourceAdGroupId },
  }, null, 2));
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, error: String(err?.message || err), status: err?.status, payload: err?.payload }, null, 2));
  process.exit(1);
});
