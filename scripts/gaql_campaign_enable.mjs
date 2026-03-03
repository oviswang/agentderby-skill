#!/usr/bin/env node
/**
 * gaql_campaign_enable.mjs
 * Enable (set status=ENABLED) one or more Google Ads campaigns.
 *
 * Usage:
 *   node scripts/gaql_campaign_enable.mjs --campaign 23607928260 [--policy growth/ads_policy_v0.1.json]
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { policy: path.resolve(__dirname, '../growth/ads_policy_v0.1.json'), campaigns: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--policy') out.policy = argv[++i];
    else if (a === '--campaign') out.campaigns.push(String(argv[++i]));
  }
  return out;
}

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

async function googleAdsMutateCampaigns({ developerToken, accessToken, customerId, loginCustomerId, operations, validateOnly }) {
  const url = `https://googleads.googleapis.com/v20/customers/${customerId}/campaigns:mutate`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json'
  };
  if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId);
  const body = { operations };
  if (validateOnly) body.validateOnly = true;
  return await httpJson('POST', url, { headers, body, timeoutMs: 30000 });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.campaigns.length) throw new Error('missing --campaign <id>');

  const policy = JSON.parse(fs.readFileSync(args.policy, 'utf8'));
  const creds = readEnvFile('/home/ubuntu/.openclaw/credentials/google_ads.env');
  const developerToken = creds.GOOGLE_ADS_DEVELOPER_TOKEN;
  const accessToken = await oauthMintAccessToken({
    client_id: creds.GOOGLE_ADS_CLIENT_ID,
    client_secret: creds.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: creds.GOOGLE_ADS_REFRESH_TOKEN,
  });

  const mcc = policy.googleAds.mccCustomerId;
  const customerId = policy.googleAds.clientCustomerId;

  const operations = args.campaigns.map(id => ({
    update: {
      resourceName: `customers/${customerId}/campaigns/${id}`,
      status: 'ENABLED'
    },
    updateMask: 'status'
  }));

  const res = await googleAdsMutateCampaigns({ developerToken, accessToken, customerId, loginCustomerId: mcc, operations, validateOnly: false });
  console.log(JSON.stringify({ ok: true, enabled: args.campaigns, result: res }, null, 2));
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, error: String(err?.message || err), status: err?.status, payload: err?.payload }, null, 2));
  process.exit(1);
});
