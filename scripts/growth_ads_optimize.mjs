#!/usr/bin/env node
/**
 * growth_ads_optimize.mjs (v0.1)
 *
 * Daily optimizer. v0.1 is conservative: it only reports candidate negative keywords
 * unless explicitly enabled in policy + run mode --apply.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { mode: 'dry-run', policy: path.resolve(__dirname, '../growth/ads_policy_v0.1.json') };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.mode = 'apply';
    else if (a === '--dry-run') out.mode = 'dry-run';
    else if (a === '--policy') out.policy = argv[++i];
  }
  return out;
}

function nowIso() { return new Date().toISOString(); }

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

function sqlScalar(dbPath, query) {
  const out = execFileSync('sqlite3', [dbPath, query], { encoding: 'utf8' }).trim();
  if (!out) return 0;
  const n = Number(out);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const args = parseArgs(process.argv);
  const ts = nowIso();
  const policy = JSON.parse(fs.readFileSync(args.policy, 'utf8'));

  const dbPath = '/home/ubuntu/.openclaw/workspace/control-plane/data/bothook.sqlite';

  const creds = readEnvFile('/home/ubuntu/.openclaw/credentials/google_ads.env');
  const accessToken = await oauthMintAccessToken({
    client_id: creds.GOOGLE_ADS_CLIENT_ID,
    client_secret: creds.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: creds.GOOGLE_ADS_REFRESH_TOKEN,
  });

  const mcc = policy.googleAds.mccCustomerId;
  const customerId = policy.googleAds.clientCustomerId;
  const developerToken = creds.GOOGLE_ADS_DEVELOPER_TOKEN;

  // v0.1: compute a very small set of health counters for the last 24h
  const sinceIso = new Date(Date.now() - 24*60*60_000).toISOString();
  const paymentSuccess24h = sqlScalar(dbPath, `SELECT COUNT(*) FROM events WHERE ts >= '${sinceIso}' AND event_type='PAYMENT_SUCCESS';`);

  // Candidate negatives from search terms by cost
  const q = `
SELECT
  search_term_view.search_term,
  metrics.clicks,
  metrics.impressions,
  metrics.cost_micros
FROM search_term_view
WHERE segments.date DURING LAST_1_DAY
ORDER BY metrics.cost_micros DESC
LIMIT 50
`;

  let terms = [];
  try {
    const stream = await googleAdsSearchStream({ developerToken, accessToken, customerId, loginCustomerId: mcc, query: q });
    terms = gaqlRows(stream).map(r => ({
      term: r.searchTermView?.searchTerm,
      cost_sgd: Number((Number(r.metrics?.costMicros || 0) / 1e6).toFixed(4)),
      clicks: Number(r.metrics?.clicks || 0),
      impressions: Number(r.metrics?.impressions || 0)
    })).filter(x => x.term);
  } catch {
    terms = [];
  }

  const out = {
    ok: true,
    ts,
    mode: args.mode,
    policy_version: policy.version,
    optimize_enabled: Boolean(policy.optimize?.enabled),
    customer: { mcc, customerId },
    facts_24h: { payment_success_events: paymentSuccess24h },
    search_terms_top_50: terms,
    actions: { planned: 0, applied: 0, note: 'v0.1 does not mutate by default' }
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, ts: nowIso(), error: String(err?.message || err) }, null, 2));
  process.exit(1);
});
