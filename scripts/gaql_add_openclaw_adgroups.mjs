#!/usr/bin/env node
/**
 * gaql_add_openclaw_adgroups.mjs
 *
 * Create "OpenClaw Intent" ad groups in one or more campaigns.
 * - Creates a new SEARCH_STANDARD ad group
 * - Adds a curated set of OpenClaw-related keywords (PHRASE + EXACT)
 * - Clones one enabled RSA from the same campaign into the new ad group
 *
 * Usage:
 *   node scripts/gaql_add_openclaw_adgroups.mjs --campaign 23607928260 --campaign 23623939429 \
 *     --name 'BH-OpenClaw Intent' --cpcSgd 3.0 --enable
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
  const out = { campaigns: [], name: 'BH-OpenClaw Intent', cpcSgd: 3.0, enable: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--campaign') out.campaigns.push(String(argv[++i]));
    else if (a === '--name') out.name = String(argv[++i]);
    else if (a === '--cpcSgd') out.cpcSgd = Number(argv[++i]);
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

const KEYWORDS = [
  // Brand + product intent
  { text: 'openclaw', matchType: 'PHRASE' },
  { text: 'openclaw', matchType: 'EXACT' },
  { text: 'openclaw ai', matchType: 'PHRASE' },
  { text: 'openclaw agent', matchType: 'PHRASE' },
  { text: 'openclaw automation', matchType: 'PHRASE' },
  { text: 'openclaw whatsapp', matchType: 'PHRASE' },
  { text: 'openclaw gateway', matchType: 'PHRASE' },
  { text: 'openclaw bot', matchType: 'PHRASE' },
  { text: 'openclaw assistant', matchType: 'PHRASE' },
  { text: 'openclaw docs', matchType: 'PHRASE' },
  { text: 'openclaw pricing', matchType: 'PHRASE' },
  { text: 'openclaw setup', matchType: 'PHRASE' },
  { text: 'setup openclaw', matchType: 'PHRASE' },
];

async function getOneEnabledRsa({ accessToken, developerToken, customerId, loginCustomerId, campaignId }) {
  const q = `
SELECT
  ad_group.id,
  ad_group_ad.ad.id,
  ad_group_ad.ad.responsive_search_ad.headlines,
  ad_group_ad.ad.responsive_search_ad.descriptions,
  ad_group_ad.ad.final_urls,
  ad_group_ad.status
FROM ad_group_ad
WHERE campaign.id = ${campaignId}
  AND ad_group_ad.status = 'ENABLED'
  AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
LIMIT 1
`;
  const rows = flat(await googleAdsSearchStream({ accessToken, developerToken, customerId, loginCustomerId, query: q }));
  const r = rows[0];
  if (!r) throw new Error(`no enabled RSA found in campaign ${campaignId}`);
  const rsa = r.adGroupAd?.ad?.responsiveSearchAd;
  const finalUrls = r.adGroupAd?.ad?.finalUrls || ['https://bothook.me/'];
  if (!rsa?.headlines?.length || !rsa?.descriptions?.length) throw new Error(`RSA missing assets in campaign ${campaignId}`);
  return { headlines: rsa.headlines, descriptions: rsa.descriptions, finalUrls };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.campaigns.length) throw new Error('missing --campaign <id>');
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

  const cpcBidMicros = Math.round(args.cpcSgd * 1_000_000);

  const out = { ok: true, name: args.name, cpcSgd: args.cpcSgd, enable: args.enable, campaigns: [] };

  for (const campaignId of args.campaigns) {
    const cloned = await getOneEnabledRsa({ accessToken, developerToken, customerId, loginCustomerId, campaignId });

    // 1) Create ad group.
    const adGroupRes = await mutate({
      accessToken,
      developerToken,
      customerId,
      loginCustomerId,
      service: 'adGroups',
      operations: [{
        create: {
          name: args.name,
          campaign: `customers/${customerId}/campaigns/${campaignId}`,
          status: args.enable ? 'ENABLED' : 'PAUSED',
          type: 'SEARCH_STANDARD',
          cpcBidMicros: String(cpcBidMicros),
        }
      }]
    });
    const adGroupResourceName = adGroupRes?.results?.[0]?.resourceName;
    const newAdGroupId = String(adGroupResourceName?.split('/').pop() || '');
    if (!newAdGroupId) throw new Error(`ad group create failed for campaign ${campaignId}`);

    // 2) Add keywords.
    const keywordOps = KEYWORDS.map(k => ({
      create: {
        adGroup: adGroupResourceName,
        status: args.enable ? 'ENABLED' : 'PAUSED',
        keyword: { text: k.text, matchType: k.matchType },
      }
    }));
    const kwRes = await mutate({
      accessToken,
      developerToken,
      customerId,
      loginCustomerId,
      service: 'adGroupCriteria',
      operations: keywordOps,
    });

    // 3) Create one RSA in the new ad group (clone assets).
    const rsaRes = await mutate({
      accessToken,
      developerToken,
      customerId,
      loginCustomerId,
      service: 'adGroupAds',
      operations: [{
        create: {
          adGroup: adGroupResourceName,
          status: args.enable ? 'ENABLED' : 'PAUSED',
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

    out.campaigns.push({
      campaignId,
      adGroupId: newAdGroupId,
      adGroupResourceName,
      keywordCreates: kwRes?.results?.length || 0,
      rsaCreateResourceName: rsaRes?.results?.[0]?.resourceName || null,
    });
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch(e => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e), payload: e?.payload || null }, null, 2));
  process.exit(1);
});
