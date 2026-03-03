#!/usr/bin/env node
/**
 * Add LOCATION campaign criteria to a campaign (country/region) by geo target constant.
 *
 * Usage:
 *   node scripts/gaql_campaign_add_locations.mjs --campaign 23607928260 --country MY --country HK
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
  const out = { campaignId: null, countries: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--campaign') out.campaignId = String(argv[++i]);
    else if (a === '--country') out.countries.push(String(argv[++i]).toUpperCase());
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

async function googleAdsMutateCampaignCriteria({ accessToken, developerToken, customerId, loginCustomerId, operations }) {
  const url = `https://googleads.googleapis.com/v20/customers/${customerId}/campaignCriteria:mutate`;
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
  if (!args.campaignId) throw new Error('missing --campaign <id>');
  if (!args.countries.length) throw new Error('missing --country <CC>');

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

  // Resolve geo target constants for the requested countries.
  const geoByCC = {};
  for (const cc of args.countries) {
    // Some markets (e.g. HK) may not have a Country target_type; allow Region fallback.
    const q = `SELECT geo_target_constant.resource_name, geo_target_constant.id, geo_target_constant.name, geo_target_constant.country_code, geo_target_constant.target_type
FROM geo_target_constant
WHERE geo_target_constant.country_code = '${cc}'
  AND geo_target_constant.target_type IN ('Country','Region')
ORDER BY geo_target_constant.target_type
LIMIT 50`;
    const s = await googleAdsSearchStream({ accessToken, developerToken, customerId, loginCustomerId: mcc, query: q });
    const rows = flat(s).map(r => r.geoTargetConstant).filter(Boolean);
    const prefer = rows.find(x => x.countryCode === cc && x.targetType === 'Country')
      || rows.find(x => x.countryCode === cc && x.targetType === 'Region')
      || rows[0];
    if (!prefer?.resourceName) throw new Error(`geo_target_constant not found for country_code=${cc}`);
    geoByCC[cc] = prefer;
  }

  // Build create operations.
  const operations = args.countries.map(cc => ({
    create: {
      campaign: `customers/${customerId}/campaigns/${args.campaignId}`,
      location: { geoTargetConstant: geoByCC[cc].resourceName },
      negative: false
    }
  }));

  const res = await googleAdsMutateCampaignCriteria({ accessToken, developerToken, customerId, loginCustomerId: mcc, operations });
  console.log(JSON.stringify({ ok: true, campaignId: args.campaignId, added: args.countries.map(cc => ({ cc, geo: geoByCC[cc] })), result: res }, null, 2));
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, error: String(err?.message || err), status: err?.status, payload: err?.payload }, null, 2));
  process.exit(1);
});
