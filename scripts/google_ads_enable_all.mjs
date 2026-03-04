#!/usr/bin/env node
import fs from 'node:fs';

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

async function httpJson(method, urlStr, { headers = {}, body = null, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(urlStr, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 800)}`);
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
  for (const chunk of (stream || [])) for (const r of (chunk.results || [])) out.push(r);
  return out;
}

async function googleAdsSearchStream({ developerToken, accessToken, customerId, loginCustomerId, query }) {
  const url = `https://googleads.googleapis.com/v20/customers/${customerId}/googleAds:searchStream`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json'
  };
  if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId);
  return await httpJson('POST', url, { headers, body: { query }, timeoutMs: 60000 });
}

async function googleAdsMutate({ developerToken, accessToken, customerId, loginCustomerId, path, body }) {
  const url = `https://googleads.googleapis.com/v20/customers/${customerId}/${path}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json'
  };
  if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId);
  return await httpJson('POST', url, { headers, body, timeoutMs: 60000 });
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function setEnabledFor({ kind, selectQuery, resourceNamePath, mutatePath, updateField }) {
  const stream = await googleAdsSearchStream({ developerToken, accessToken, customerId, loginCustomerId: mcc, query: selectQuery });
  const rows = gaqlRows(stream);
  const rns = rows.map(r => {
    // r is nested object; walk dotted path.
    let cur = r;
    for (const part of resourceNamePath.split('.')) cur = cur?.[part];
    return String(cur || '').trim();
  }).filter(Boolean);

  if (!rns.length) return { kind, found: 0, enabled: 0 };

  let enabled = 0;
  for (const batch of chunk(rns, 1000)) {
    const ops = batch.map(rn => ({
      update: { resourceName: rn, status: 'ENABLED' },
      updateMask: updateField
    }));
    await googleAdsMutate({
      developerToken,
      accessToken,
      customerId,
      loginCustomerId: mcc,
      path: mutatePath,
      body: { operations: ops, partialFailure: false, validateOnly: false }
    });
    enabled += batch.length;
  }

  return { kind, found: rns.length, enabled };
}

const policy = JSON.parse(fs.readFileSync('/home/ubuntu/.openclaw/workspace/growth/ads_policy_v0.1.json', 'utf8'));
const creds = readEnvFile('/home/ubuntu/.openclaw/credentials/google_ads.env');
const accessToken = await oauthMintAccessToken({
  client_id: creds.GOOGLE_ADS_CLIENT_ID,
  client_secret: creds.GOOGLE_ADS_CLIENT_SECRET,
  refresh_token: creds.GOOGLE_ADS_REFRESH_TOKEN
});
const developerToken = creds.GOOGLE_ADS_DEVELOPER_TOKEN;
const mcc = policy.googleAds.mccCustomerId;
const customerId = policy.googleAds.clientCustomerId;

const out = [];

// Campaigns
out.push(await setEnabledFor({
  kind: 'campaign',
  selectQuery: "SELECT campaign.resource_name FROM campaign WHERE campaign.status = 'PAUSED'",
  resourceNamePath: 'campaign.resourceName',
  mutatePath: 'campaigns:mutate',
  updateField: 'status'
}));

// Ad groups
out.push(await setEnabledFor({
  kind: 'ad_group',
  selectQuery: "SELECT ad_group.resource_name FROM ad_group WHERE ad_group.status = 'PAUSED'",
  resourceNamePath: 'adGroup.resourceName',
  mutatePath: 'adGroups:mutate',
  updateField: 'status'
}));

// Ads (ad_group_ad)
out.push(await setEnabledFor({
  kind: 'ad_group_ad',
  selectQuery: "SELECT ad_group_ad.resource_name FROM ad_group_ad WHERE ad_group_ad.status = 'PAUSED'",
  resourceNamePath: 'adGroupAd.resourceName',
  mutatePath: 'adGroupAds:mutate',
  updateField: 'status'
}));

// Keywords / criteria
out.push(await setEnabledFor({
  kind: 'ad_group_criterion',
  selectQuery: "SELECT ad_group_criterion.resource_name FROM ad_group_criterion WHERE ad_group_criterion.status = 'PAUSED'",
  resourceNamePath: 'adGroupCriterion.resourceName',
  mutatePath: 'adGroupCriteria:mutate',
  updateField: 'status'
}));

console.log(JSON.stringify({ ok: true, customerId, results: out }, null, 2));
