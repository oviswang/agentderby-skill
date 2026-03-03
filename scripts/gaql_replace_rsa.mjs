#!/usr/bin/env node
/**
 * Replace an RSA by creating a new ad_group_ad (with new RSA assets) and pausing the old one.
 *
 * Usage:
 *   node scripts/gaql_replace_rsa.mjs --adgroup 194116886055 --oldAdGroupAd 194116886055~798865165652 \
 *     --finalUrl https://bothook.me/ --assets growth/rsa_assets_en_v0.1.json
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
  const out = { adGroupId: null, oldAdGroupAd: null, finalUrl: 'https://bothook.me/', assetsPath: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--adgroup') out.adGroupId = String(argv[++i]);
    else if (a === '--oldAdGroupAd') out.oldAdGroupAd = String(argv[++i]);
    else if (a === '--finalUrl') out.finalUrl = String(argv[++i]);
    else if (a === '--assets') out.assetsPath = String(argv[++i]);
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

function ensureLen(s, max, label) {
  const t = String(s || '').trim();
  if (!t) throw new Error(`${label} empty`);
  if (t.length > max) throw new Error(`${label} too long (${t.length}>${max}): ${t}`);
  return t;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.adGroupId) throw new Error('missing --adgroup <id>');
  if (!args.oldAdGroupAd) throw new Error('missing --oldAdGroupAd <adGroupId~adId>');
  if (!args.assetsPath) throw new Error('missing --assets <path>');

  const assets = JSON.parse(fs.readFileSync(args.assetsPath, 'utf8'));
  const headlines = (assets.headlines || []).map((t, i) => ensureLen(t, 30, `headline[${i}]`));
  const descriptions = (assets.descriptions || []).map((t, i) => ensureLen(t, 90, `description[${i}]`));
  const path1 = assets.path1 ? ensureLen(assets.path1, 15, 'path1') : null;
  const path2 = assets.path2 ? ensureLen(assets.path2, 15, 'path2') : null;

  if (headlines.length < 8) throw new Error('need at least 8 headlines');
  if (descriptions.length < 2) throw new Error('need at least 2 descriptions');

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

  const adGroupRes = `customers/${customerId}/adGroups/${args.adGroupId}`;
  const oldRes = `customers/${customerId}/adGroupAds/${args.oldAdGroupAd}`;

  const createOp = {
    create: {
      adGroup: adGroupRes,
      status: 'ENABLED',
      ad: {
        finalUrls: [args.finalUrl],
        responsiveSearchAd: {
          headlines: headlines.map(text => ({ text })),
          descriptions: descriptions.map(text => ({ text })),
          path1: path1 || undefined,
          path2: path2 || undefined
        }
      }
    }
  };

  const pauseOldOp = {
    update: {
      resourceName: oldRes,
      status: 'PAUSED'
    },
    updateMask: 'status'
  };

  const url = `https://googleads.googleapis.com/v20/customers/${customerId}/adGroupAds:mutate`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json',
    'login-customer-id': String(mcc)
  };

  const res = await httpJson('POST', url, { headers, body: { operations: [createOp, pauseOldOp], partialFailure: false }, timeoutMs: 30000 });
  console.log(JSON.stringify({ ok: true, created_and_paused_old: true, result: res }, null, 2));
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, error: String(err?.message || err), status: err?.status, payload: err?.payload }, null, 2));
  process.exit(1);
});
