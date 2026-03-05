#!/usr/bin/env node
/**
 * Add negative keywords at CAMPAIGN level (campaign_criterion).
 * Usage:
 *   node scripts/gaql_campaign_add_negative_keywords.mjs --campaign 23607928260 --match PHRASE --kw "docker" --kw "install"
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
  const out = { campaignId: null, match: 'PHRASE', kws: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--campaign') out.campaignId = String(argv[++i]);
    else if (a === '--match') out.match = String(argv[++i]).toUpperCase();
    else if (a === '--kw') out.kws.push(String(argv[++i]));
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

async function googleAdsMutateCampaignCriteria({ accessToken, developerToken, customerId, loginCustomerId, operations, partialFailure = true }) {
  const url = `https://googleads.googleapis.com/v20/customers/${customerId}/campaignCriteria:mutate`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json',
  };
  if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId);
  const body = { operations, partialFailure };
  return await httpJson('POST', url, { headers, body, timeoutMs: 30000 });
}

function normKw(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.campaignId) throw new Error('missing --campaign <id>');
  if (!['PHRASE', 'EXACT', 'BROAD'].includes(args.match)) throw new Error('bad --match (PHRASE|EXACT|BROAD)');

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

  const campRes = `customers/${customerId}/campaigns/${args.campaignId}`;
  const kws = args.kws.map(normKw).filter(Boolean);
  const uniq = Array.from(new Set(kws));

  const operations = uniq.map(text => ({
    create: {
      campaign: campRes,
      negative: true,
      status: 'ENABLED',
      keyword: { text, matchType: args.match }
    }
  }));

  const result = await googleAdsMutateCampaignCriteria({ accessToken, developerToken, customerId, loginCustomerId: mcc, operations, partialFailure: true });
  console.log(JSON.stringify({ ok: true, campaignId: args.campaignId, match: args.match, added_attempted: uniq.length, result }, null, 2));
}

main().catch(e => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e), status: e?.status || null, payload: e?.payload || null }, null, 2));
  process.exit(1);
});
