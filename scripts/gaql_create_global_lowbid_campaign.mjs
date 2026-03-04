#!/usr/bin/env node
/**
 * gaql_create_global_lowbid_campaign.mjs
 *
 * Create a global (all countries) low-bid Search campaign for comparison.
 * - Budget: configurable (SGD)
 * - Manual CPC
 * - No explicit LOCATION criteria (defaults to all countries/territories)
 * - One ad group with low CPC bid
 * - Adds a mixed keyword set (OpenClaw + WhatsApp assistant intent)
 * - Clones one enabled RSA from a source campaign
 *
 * Usage:
 *   node scripts/gaql_create_global_lowbid_campaign.mjs \
 *     --name 'BH-GLOBAL-LOWBID Search v0.1' \
 *     --budgetSgd 5 --cpcSgd 0.2 \
 *     --sourceCampaign 23607928260 \
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
    name: 'BH-GLOBAL-LOWBID Search v0.1',
    budgetSgd: 5,
    cpcSgd: 0.2,
    sourceCampaignId: null,
    enable: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') out.name = String(argv[++i]);
    else if (a === '--budgetSgd') out.budgetSgd = Number(argv[++i]);
    else if (a === '--cpcSgd') out.cpcSgd = Number(argv[++i]);
    else if (a === '--sourceCampaign') out.sourceCampaignId = String(argv[++i]);
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

function yyyyMMdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${dd}`;
}

async function getOneEnabledRsa({ accessToken, developerToken, customerId, loginCustomerId, campaignId }) {
  const q = `
SELECT
  ad_group_ad.ad.responsive_search_ad.headlines,
  ad_group_ad.ad.responsive_search_ad.descriptions,
  ad_group_ad.ad.final_urls
FROM ad_group_ad
WHERE campaign.id = ${campaignId}
  AND ad_group_ad.status = 'ENABLED'
  AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
LIMIT 1
`;
  const rows = flat(await googleAdsSearchStream({ accessToken, developerToken, customerId, loginCustomerId, query: q }));
  const r = rows[0];
  if (!r) throw new Error(`no enabled RSA found in source campaign ${campaignId}`);
  const rsa = r.adGroupAd?.ad?.responsiveSearchAd;
  const finalUrls = r.adGroupAd?.ad?.finalUrls || ['https://bothook.me/'];
  if (!rsa?.headlines?.length || !rsa?.descriptions?.length) throw new Error('RSA missing assets');
  return { headlines: rsa.headlines, descriptions: rsa.descriptions, finalUrls };
}

const MIX_KEYWORDS = [
  // OpenClaw intent
  { text: 'openclaw', matchType: 'PHRASE' },
  { text: 'openclaw', matchType: 'EXACT' },
  { text: 'openclaw ai', matchType: 'PHRASE' },
  { text: 'openclaw agent', matchType: 'PHRASE' },
  { text: 'openclaw whatsapp', matchType: 'PHRASE' },

  // WhatsApp assistant intent (global)
  { text: 'whatsapp assistant', matchType: 'PHRASE' },
  { text: 'whatsapp ai assistant', matchType: 'PHRASE' },
  { text: 'ai assistant whatsapp', matchType: 'PHRASE' },
  { text: 'whatsapp auto reply', matchType: 'PHRASE' },
  { text: 'whatsapp reminders', matchType: 'PHRASE' },
  { text: 'whatsapp summary', matchType: 'PHRASE' },
  { text: 'summarize whatsapp', matchType: 'PHRASE' },
  { text: 'translate whatsapp messages', matchType: 'PHRASE' },
];

async function main() {
  const args = parseArgs(process.argv);
  if (!args.sourceCampaignId) throw new Error('missing --sourceCampaign <id>');
  if (!Number.isFinite(args.budgetSgd) || args.budgetSgd <= 0) throw new Error('bad --budgetSgd');
  if (!Number.isFinite(args.cpcSgd) || args.cpcSgd <= 0) throw new Error('bad --cpcSgd');

  const creds = readEnvFile('/home/ubuntu/.openclaw/credentials/google_ads.env');
  const accessToken = await oauthMintAccessToken({
    client_id: creds.GOOGLE_ADS_CLIENT_ID,
    client_secret: creds.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: creds.GOOGLE_ADS_REFRESH_TOKEN,
  });

  const developerToken = creds.GOOGLE_ADS_DEVELOPER_TOKEN;
  const customerId = String(creds.GOOGLE_ADS_CLIENT_CUSTOMER_ID || '1577191627');
  const loginCustomerId = String(creds.GOOGLE_ADS_MCC_CUSTOMER_ID || '9776571037');

  const budgetMicros = String(Math.round(args.budgetSgd * 1_000_000));
  const cpcBidMicros = String(Math.round(args.cpcSgd * 1_000_000));
  const status = args.enable ? 'ENABLED' : 'PAUSED';

  const cloned = await getOneEnabledRsa({ accessToken, developerToken, customerId, loginCustomerId, campaignId: args.sourceCampaignId });

  // 1) Create budget.
  const budgetName = `${args.name} Budget ${yyyyMMdd(new Date())}-${Date.now().toString().slice(-6)}`;
  const budRes = await mutate({
    accessToken,
    developerToken,
    customerId,
    loginCustomerId,
    service: 'campaignBudgets',
    operations: [{
      create: {
        name: budgetName,
        amountMicros: budgetMicros,
        deliveryMethod: 'STANDARD',
      }
    }]
  });
  const budgetResourceName = budRes?.results?.[0]?.resourceName;
  if (!budgetResourceName) throw new Error('budget create failed');

  // 2) Create campaign (no location criteria => global default).
  const today = new Date();
  const startDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const endDate = '2037-12-30';

  const campRes = await mutate({
    accessToken,
    developerToken,
    customerId,
    loginCustomerId,
    service: 'campaigns',
    operations: [{
      create: {
        name: args.name,
        advertisingChannelType: 'SEARCH',
        status,
        // Google Ads now requires this enum field on campaign create in some accounts.
        containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        campaignBudget: budgetResourceName,
        manualCpc: {},
        networkSettings: {
          targetGoogleSearch: true,
          targetSearchNetwork: true,
          targetContentNetwork: false,
          targetPartnerSearchNetwork: false,
        },
        startDate,
        endDate,
      }
    }]
  });

  const campaignResourceName = campRes?.results?.[0]?.resourceName;
  const newCampaignId = String(campaignResourceName?.split('/').pop() || '');
  if (!newCampaignId) throw new Error('campaign create failed');

  // 3) Create one ad group.
  const agRes = await mutate({
    accessToken,
    developerToken,
    customerId,
    loginCustomerId,
    service: 'adGroups',
    operations: [{
      create: {
        name: 'BH-Global LowBid Mix',
        campaign: campaignResourceName,
        status,
        type: 'SEARCH_STANDARD',
        cpcBidMicros,
      }
    }]
  });
  const adGroupResourceName = agRes?.results?.[0]?.resourceName;
  const adGroupId = String(adGroupResourceName?.split('/').pop() || '');
  if (!adGroupId) throw new Error('ad group create failed');

  // 4) Keywords.
  const kwOps = MIX_KEYWORDS.map(k => ({
    create: {
      adGroup: adGroupResourceName,
      status,
      keyword: { text: k.text, matchType: k.matchType },
    }
  }));
  const kwRes = await mutate({
    accessToken,
    developerToken,
    customerId,
    loginCustomerId,
    service: 'adGroupCriteria',
    operations: kwOps,
  });

  // 5) RSA.
  const rsaRes = await mutate({
    accessToken,
    developerToken,
    customerId,
    loginCustomerId,
    service: 'adGroupAds',
    operations: [{
      create: {
        adGroup: adGroupResourceName,
        status,
        ad: {
          finalUrls: cloned.finalUrls,
          responsiveSearchAd: {
            headlines: cloned.headlines,
            descriptions: cloned.descriptions,
          }
        }
      }
    }]
  });

  console.log(JSON.stringify({
    ok: true,
    created: {
      campaignId: newCampaignId,
      campaignResourceName,
      budgetResourceName,
      budgetSgd: args.budgetSgd,
      adGroupId,
      adGroupResourceName,
      cpcSgd: args.cpcSgd,
      keywordCreates: kwRes?.results?.length || 0,
      rsaResourceName: rsaRes?.results?.[0]?.resourceName || null,
    }
  }, null, 2));
}

main().catch(e => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e), payload: e?.payload || null }, null, 2));
  process.exit(1);
});
