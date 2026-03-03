#!/usr/bin/env node
/**
 * Disable ad group keywords whose text starts with a single quote.
 * This fixes accidental injection of quotes into keyword text.
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

async function googleAdsMutateAdGroupCriteria({ accessToken, developerToken, customerId, loginCustomerId, operations }) {
  const url = `https://googleads.googleapis.com/v20/customers/${customerId}/adGroupCriteria:mutate`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json',
  };
  if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId);
  return await httpJson('POST', url, { headers, body: { operations, partialFailure: true }, timeoutMs: 30000 });
}

async function main() {
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

  const adGroupId = '194116886055';
  const q = `SELECT ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.status
FROM ad_group_criterion
WHERE ad_group.id=${adGroupId}
  AND ad_group_criterion.type='KEYWORD'
  AND ad_group_criterion.negative = false
  AND ad_group_criterion.status = 'ENABLED'
LIMIT 500`;

  const s = await googleAdsSearchStream({ accessToken, developerToken, customerId, loginCustomerId: mcc, query: q });
  const rows = flat(s).map(r => r.adGroupCriterion).filter(Boolean);
  const bad = rows.filter(r => String(r.keyword?.text || '').startsWith("'"));

  const ops = bad.map(r => ({
    update: { resourceName: r.resourceName, status: 'PAUSED' },
    updateMask: 'status'
  }));

  const res = ops.length ? await googleAdsMutateAdGroupCriteria({ accessToken, developerToken, customerId, loginCustomerId: mcc, operations: ops }) : null;
  console.log(JSON.stringify({ ok: true, found: bad.length, paused: ops.length, bad: bad.map(x => ({ resourceName: x.resourceName, text: x.keyword?.text })), result: res }, null, 2));
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, error: String(err?.message || err), status: err?.status, payload: err?.payload }, null, 2));
  process.exit(1);
});
