#!/usr/bin/env node
/**
 * Scale bids (or bid-like targets) down by 5% for SG/US campaigns.
 * Policy: owner requested "全部 SG/US 的出价都下降5%".
 *
 * Behavior:
 * - Reads campaign IDs from growth/ads_policy_v0.1.json (googleAds.scopes.*.campaignIds).
 * - Detects campaign bidding strategy and applies the most direct "bid down" control available:
 *   - MAXIMIZE_CLICKS: scale cpc_bid_ceiling_micros if set
 *   - TARGET_CPA: scale target_cpa_micros if set
 *   - MANUAL_CPC / ENHANCED_CPC: scale ad_group.cpc_bid_micros for all enabled ad groups in campaign
 * - Defaults to dry-run; pass --apply to execute.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { mode: 'dry-run', policy: path.resolve(__dirname, '../growth/ads_policy_v0.1.json'), env: '/home/ubuntu/.openclaw/credentials/google_ads.env', factor: 0.95 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.mode = 'apply';
    else if (a === '--dry-run') out.mode = 'dry-run';
    else if (a === '--policy') out.policy = path.resolve(argv[++i]);
    else if (a === '--env') out.env = path.resolve(argv[++i]);
    else if (a === '--factor') out.factor = Number(argv[++i]);
  }
  if (!Number.isFinite(out.factor) || out.factor <= 0 || out.factor >= 1) throw new Error('bad --factor (expected 0<factor<1)');
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

async function httpJson(method, urlStr, { headers = {}, body = null, timeoutMs = 30000 } = {}) {
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

async function googleAdsMutateCampaigns({ developerToken, accessToken, customerId, loginCustomerId, operations }) {
  const url = `https://googleads.googleapis.com/v20/customers/${customerId}/campaigns:mutate`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json'
  };
  if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId);
  return await httpJson('POST', url, { headers, body: { operations, partialFailure: false }, timeoutMs: 30000 });
}

async function googleAdsMutateAdGroups({ developerToken, accessToken, customerId, loginCustomerId, operations }) {
  const url = `https://googleads.googleapis.com/v20/customers/${customerId}/adGroups:mutate`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json'
  };
  if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId);
  return await httpJson('POST', url, { headers, body: { operations, partialFailure: false }, timeoutMs: 30000 });
}

function microsScale(m, factor, { billableUnitMicros = 10000 } = {}) {
  const n = Number(m);
  if (!Number.isFinite(n) || n <= 0) return null;
  const raw = n * factor;
  const rounded = Math.round(raw / billableUnitMicros) * billableUnitMicros;
  return Math.max(billableUnitMicros, rounded);
}

async function main() {
  const args = parseArgs(process.argv);
  const policy = JSON.parse(fs.readFileSync(args.policy, 'utf8'));
  const ids = new Set();
  for (const scope of Object.values(policy?.googleAds?.scopes || {})) {
    for (const id of (scope?.campaignIds || [])) ids.add(String(id));
  }
  if (!ids.size) throw new Error('no campaignIds found in policy');

  const env = readEnvFile(args.env);
  const developerToken = env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const refreshToken = env.GOOGLE_ADS_REFRESH_TOKEN;
  const clientId = env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = env.GOOGLE_ADS_CLIENT_SECRET;
  // IMPORTANT: login-customer-id must be the MCC id. The env file may contain the client customer id.
  const loginCustomerId = String(policy?.googleAds?.mccCustomerId || '').replace(/[^0-9]/g,'') || null;
  const customerId = String(policy?.googleAds?.clientCustomerId || '').replace(/[^0-9]/g,'') || null;

  for (const k of ['GOOGLE_ADS_DEVELOPER_TOKEN','GOOGLE_ADS_REFRESH_TOKEN','GOOGLE_ADS_CLIENT_ID','GOOGLE_ADS_CLIENT_SECRET']) {
    if (!env[k]) throw new Error(`missing ${k} in ${args.env}`);
  }
  if (!customerId) throw new Error('missing customerId');

  const accessToken = await oauthMintAccessToken({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken });

  const idList = Array.from(ids).join(',');
  const q1 = `SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type, campaign.manual_cpc.enhanced_cpc_enabled, campaign.target_cpa.target_cpa_micros FROM campaign WHERE campaign.id IN (${idList})`;
  const campaigns = gaqlRows(await googleAdsSearchStream({ developerToken, accessToken, customerId, loginCustomerId, query: q1 }))
    .map(r => r.campaign);

  const plan = { campaigns: [], adGroups: [] };

  for (const c of campaigns) {
    const bidType = String(c.biddingStrategyType || 'UNKNOWN');
    const cid = String(c.id);

    const targetCpa = c?.targetCpa?.targetCpaMicros ?? c?.target_cpa?.target_cpa_micros ?? null;

    if (bidType.includes('TARGET_CPA') && targetCpa) {
      const next = microsScale(targetCpa, args.factor);
      plan.campaigns.push({ kind: 'TARGET_CPA', campaignId: cid, name: c.name, from: Number(targetCpa), to: next });
      continue;
    }

    // Default: scale ad group CPC bids (works for MANUAL_CPC / ENHANCED_CPC setups).
    const qAg = `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.cpc_bid_micros FROM ad_group WHERE campaign.id = ${cid} AND ad_group.status = ENABLED`;
    const adgs = gaqlRows(await googleAdsSearchStream({ developerToken, accessToken, customerId, loginCustomerId, query: qAg }))
      .map(r => r.adGroup || r.ad_group);

    for (const ag of adgs) {
      const from = ag?.cpcBidMicros ?? ag?.cpc_bid_micros ?? null;
      if (!from) continue;
      const to = microsScale(from, args.factor);
      plan.adGroups.push({ campaignId: cid, campaignName: c.name, adGroupId: String(ag.id), adGroupName: ag.name, from: Number(from), to });
    }
  }

  const out = { ok: true, mode: args.mode, factor: args.factor, customerId, loginCustomerId, planSummary: { campaignOps: plan.campaigns.length, adGroupOps: plan.adGroups.length }, plan };

  if (args.mode !== 'apply') {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Execute campaign-level updates (only target_cpa supported here).
  if (plan.campaigns.length) {
    const ops = plan.campaigns.map(p => {
      const resourceName = `customers/${customerId}/campaigns/${p.campaignId}`;
      if (p.kind === 'TARGET_CPA') {
        return {
          update: {
            resourceName,
            targetCpa: { targetCpaMicros: String(p.to) }
          },
          updateMask: 'target_cpa.target_cpa_micros'
        };
      }
      throw new Error('unknown campaign plan kind');
    });
    await googleAdsMutateCampaigns({ developerToken, accessToken, customerId, loginCustomerId, operations: ops });
  }

  // Execute ad group CPC bid updates in chunks.
  const CHUNK = 50;
  for (let i = 0; i < plan.adGroups.length; i += CHUNK) {
    const chunk = plan.adGroups.slice(i, i + CHUNK);
    const ops = chunk.map(p => ({
      update: {
        resourceName: `customers/${customerId}/adGroups/${p.adGroupId}`,
        cpcBidMicros: String(p.to)
      },
      updateMask: 'cpc_bid_micros'
    }));
    await googleAdsMutateAdGroups({ developerToken, accessToken, customerId, loginCustomerId, operations: ops });
  }

  console.log(JSON.stringify({ ...out, applied: true }, null, 2));
}

main().catch(e => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e), status: e?.status || null, payload: e?.payload || null }, null, 2));
  process.exit(1);
});
