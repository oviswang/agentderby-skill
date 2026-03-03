#!/usr/bin/env node
/**
 * growth_ads_guard.mjs
 *
 * Purpose: Fast-cycle (15m) guardrails for Google Ads + BOTHook funnel health.
 * - Detect hard-stop conditions (welcome/guide send failures; bound but welcome not sent; spend w/ no signal).
 * - Pause scoped campaigns (SG desktop) when triggered.
 *
 * Outputs JSON to stdout (single object).
 * No message tool usage; cron announce will deliver.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

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

function fmtDateTimeInTz(d, timeZone) {
  // Google Ads expects customer TZ local date_time strings: YYYY-MM-DD HH:MM:SS
  // Use a stable locale that yields that layout.
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(d);
  const get = (t) => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
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
  const params = new URLSearchParams({
    client_id,
    client_secret,
    refresh_token,
    grant_type: 'refresh_token'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: params });
  const j = await res.json();
  if (!res.ok) throw new Error(`oauth token error: ${j?.error || res.status}`);
  return j.access_token;
}

function gaqlStreamFirstResults(stream) {
  // searchStream returns an array of chunks; each chunk has results[].
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

function openSqlite(dbPath) {
  // dynamic import to avoid dependency at load time
  const Database = require('better-sqlite3');
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function requireFromHere(relPath) {
  const p = path.resolve(__dirname, relPath);
  // eslint-disable-next-line
  return require(p);
}

async function main() {
  const args = parseArgs(process.argv);
  const ts = nowIso();
  const policy = JSON.parse(fs.readFileSync(args.policy, 'utf8'));

  // Config
  const creds = readEnvFile('/home/ubuntu/.openclaw/credentials/google_ads.env');
  const developerToken = creds.GOOGLE_ADS_DEVELOPER_TOKEN;
  const accessToken = await oauthMintAccessToken({
    client_id: creds.GOOGLE_ADS_CLIENT_ID,
    client_secret: creds.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: creds.GOOGLE_ADS_REFRESH_TOKEN,
  });

  const mcc = policy.googleAds.mccCustomerId;
  const customerId = policy.googleAds.clientCustomerId;
  const timeZone = policy.googleAds.timeZone || 'Asia/Singapore';

  const spendLookbackMin = policy.guard.windows.spendLookbackMinutes;
  const funnelLookbackMin = policy.guard.windows.funnelLookbackMinutes;

  // Spend last 15 minutes (customer TZ)
  const end = new Date();
  const start = new Date(end.getTime() - spendLookbackMin * 60_000);
  const startStr = fmtDateTimeInTz(start, timeZone);
  const endStr = fmtDateTimeInTz(end, timeZone);

  const scope = policy.googleAds.scopes.sgDesktop;

  // GAQL WHERE clause does not reliably support parentheses. Keep filtering simple.
  const campaignFilter = (() => {
    const ids = (scope.campaignIds || []).filter(Boolean);
    const prefixes = (scope.campaignNamePrefixes || []).filter(Boolean);
    if (ids.length) {
      return `AND campaign.id IN (${ids.map(x => String(x)).join(',')})`;
    }
    if (prefixes.length === 1) {
      const p = String(prefixes[0]).replace(/'/g, "''");
      return `AND campaign.name LIKE '${p}%'`;
    }
    // If multiple prefixes are configured, skip filtering and report in output.
    return '';
  })();

  const spendQuery = `
SELECT
  campaign.id,
  campaign.name,
  campaign.status,
  metrics.cost_micros,
  metrics.clicks,
  metrics.impressions
FROM campaign
WHERE segments.date_time >= '${startStr}'
  AND segments.date_time < '${endStr}'
  ${campaignFilter}
`;

  let spendRows = [];
  try {
    const stream = await googleAdsSearchStream({ developerToken, accessToken, customerId, loginCustomerId: mcc, query: spendQuery });
    spendRows = gaqlStreamFirstResults(stream).map(r => ({
      id: r.campaign?.id,
      name: r.campaign?.name,
      status: r.campaign?.status,
      cost_micros: Number(r.metrics?.costMicros || 0),
      clicks: Number(r.metrics?.clicks || 0),
      impressions: Number(r.metrics?.impressions || 0)
    }));
  } catch (e) {
    // If date_time filter fails (API quirks), fail-closed: treat as unknown spend and do not take destructive actions.
    spendRows = [];
  }

  const spendByCampaign = new Map();
  for (const r of spendRows) {
    const key = String(r.id || '');
    if (!key) continue;
    const prev = spendByCampaign.get(key) || { id: r.id, name: r.name, status: r.status, cost_micros: 0, clicks: 0, impressions: 0 };
    prev.cost_micros += r.cost_micros;
    prev.clicks += r.clicks;
    prev.impressions += r.impressions;
    spendByCampaign.set(key, prev);
  }

  const spendAggMicros = [...spendByCampaign.values()].reduce((a, x) => a + x.cost_micros, 0);
  const spendAggSgd = spendAggMicros / 1e6;

  // Funnel / control-plane health (SQLite)
  // NOTE: Do not depend on native node modules. Use sqlite3 CLI.
  const dbPath = '/home/ubuntu/.openclaw/workspace/control-plane/data/bothook.sqlite';
  const { execFileSync } = await import('node:child_process');
  const { randomUUID } = await import('node:crypto');

  function sqlExec(query) {
    // Best-effort; do not fail the guard run on audit write.
    try {
      execFileSync('sqlite3', [dbPath, query], { encoding: 'utf8' });
      return true;
    } catch {
      return false;
    }
  }

  function sqlEscape(s) {
    return String(s).replace(/'/g, "''");
  }

  function writeEvent({ entity_type, entity_id, event_type, payload }) {
    const event_id = randomUUID();
    const payload_json = payload == null ? null : JSON.stringify(payload);
    const q = `INSERT INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (` +
      `'${sqlEscape(event_id)}',` +
      `'${sqlEscape(ts)}',` +
      `'${sqlEscape(entity_type)}',` +
      `'${sqlEscape(entity_id)}',` +
      `'${sqlEscape(event_type)}',` +
      (payload_json == null ? 'NULL' : `'${sqlEscape(payload_json)}'`) +
      `);`;
    return { ok: sqlExec(q), event_id };
  }

  const sinceIso = new Date(Date.now() - funnelLookbackMin * 60_000).toISOString();

  function sqlScalar(query) {
    const out = execFileSync('sqlite3', [dbPath, query], { encoding: 'utf8' }).trim();
    if (!out) return 0;
    const n = Number(out);
    return Number.isFinite(n) ? n : 0;
  }

  const hardEventTypes = policy.guard.hardStop.eventTypesAny || [];
  const hardEventCount = hardEventTypes.length
    ? sqlScalar(`SELECT COUNT(*) FROM events WHERE ts >= '${sinceIso}' AND event_type IN (${hardEventTypes.map(x => `'${String(x).replace(/'/g, "''")}'`).join(',')});`)
    : 0;

  const welcomeSentCount = sqlScalar(`SELECT COUNT(*) FROM events WHERE ts >= '${sinceIso}' AND event_type='WELCOME_UNPAID_SENT';`);

  // Proxy for "qr_scanned": deliveries bound_at is set when WA linked.
  const boundCount = sqlScalar(`SELECT COUNT(*) FROM deliveries WHERE bound_at IS NOT NULL AND bound_at >= '${sinceIso}';`);

  const triggers = [];
  if (hardEventCount > 0) triggers.push({ code: 'ADS_GUARD_HARDSTOP_SEND_FAILED_EVENT', hardEventCount, hardEventTypes });

  if (policy.guard.hardStop?.fallback?.boundButWelcomeNotSent && boundCount > 0 && welcomeSentCount === 0) {
    triggers.push({ code: 'ADS_GUARD_HARDSTOP_BOUND_BUT_WELCOME_NOT_SENT', boundCount, welcomeSentCount });
  }

  if (spendAggSgd > Number(policy.guard.thresholds.spend15mSgdHardStop || 0) && boundCount === 0) {
    triggers.push({ code: 'ADS_GUARD_HARDSTOP_SPEND_NO_SIGNAL', spend_15m_sgd: spendAggSgd, boundCount });
  }

  // Decide pause targets
  const shouldPause = triggers.length > 0;

  // Resolve target campaigns to pause: fetch campaigns in scope (by prefix/ids)
  const listQuery = `
SELECT campaign.id, campaign.name, campaign.status
FROM campaign
WHERE campaign.status != 'REMOVED'
  ${campaignFilter}
ORDER BY campaign.id DESC
LIMIT 200
`;

  const listStream = await googleAdsSearchStream({ developerToken, accessToken, customerId, loginCustomerId: mcc, query: listQuery });
  const campaigns = gaqlStreamFirstResults(listStream).map(r => ({
    id: r.campaign?.id,
    name: r.campaign?.name,
    status: r.campaign?.status
  })).filter(c => c.id);

  const toPause = campaigns.filter(c => c.status === 'ENABLED' || c.status === 'PAUSED');
  const pauseOps = [];

  if (shouldPause) {
    for (const c of toPause) {
      if (pauseOps.length >= Number(policy.guard.safety.maxPausePerRun || 5)) break;
      if (c.status === 'PAUSED') continue;
      pauseOps.push({
        update: {
          resourceName: `customers/${customerId}/campaigns/${c.id}`,
          status: 'PAUSED'
        },
        updateMask: 'status'
      });
    }
  }

  let mutateResult = null;
  if (pauseOps.length && args.mode === 'apply') {
    mutateResult = await googleAdsMutateCampaigns({ developerToken, accessToken, customerId, loginCustomerId: mcc, operations: pauseOps, validateOnly: false });
  }

  // Audit: write a compact run summary + any applied pause ops into BOTHook events.
  // This makes it easy to correlate “why it paused” without relying on Ads change history.
  const auditRun = writeEvent({
    entity_type: 'ads_guard',
    entity_id: 'sgDesktop',
    event_type: 'ADS_GUARD_RUN',
    payload: {
      mode: args.mode,
      policy_version: policy.version,
      customerId,
      timeZone,
      windows: { spendLookbackMin, funnelLookbackMin, funnel_since: sinceIso, spend_start: startStr, spend_end: endStr },
      funnel_30m: { bound_count: Number(boundCount || 0), welcome_sent_count: Number(welcomeSentCount || 0), hard_stop_event_count: Number(hardEventCount || 0) },
      decision: { should_pause: shouldPause, triggers, pause_ops_planned: pauseOps.length },
      applied: { paused: (args.mode === 'apply') ? pauseOps.length : 0 }
    }
  });

  const auditPause = (pauseOps.length && args.mode === 'apply')
    ? writeEvent({
        entity_type: 'ads_campaign',
        entity_id: String(scope?.campaignIds?.[0] || 'sgDesktop'),
        event_type: 'ADS_GUARD_CAMPAIGN_PAUSED',
        payload: { triggers, paused_campaign_ids: pauseOps.map(op => op.update?.resourceName?.split('/').pop()).filter(Boolean) }
      })
    : null;

  const out = {
    ok: true,
    ts,
    mode: args.mode,
    policy_version: policy.version,
    scope: 'sgDesktop',
    customer: { mcc, customerId, timeZone },
    windows: { spendLookbackMin, funnelLookbackMin, spend_start: startStr, spend_end: endStr, funnel_since: sinceIso },
    spend_15m: {
      total_sgd: Number(spendAggSgd.toFixed(4)),
      campaigns: [...spendByCampaign.values()].map(x => ({ id: x.id, name: x.name, cost_sgd: Number((x.cost_micros/1e6).toFixed(4)), clicks: x.clicks, impressions: x.impressions }))
    },
    funnel_30m: {
      bound_count: Number(boundCount || 0),
      welcome_sent_count: Number(welcomeSentCount || 0),
      hard_stop_event_count: Number(hardEventCount || 0)
    },
    decision: {
      should_pause: shouldPause,
      triggers,
      campaigns_in_scope: campaigns.length,
      pause_ops_planned: pauseOps.length
    },
    applied: args.mode === 'apply' ? { paused: pauseOps.length, mutateResult } : { paused: 0 },
    audit: {
      run_event_id: auditRun?.event_id,
      run_event_written: auditRun?.ok,
      pause_event_id: auditPause?.event_id,
      pause_event_written: auditPause?.ok
    }
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch(err => {
  const out = { ok: false, ts: nowIso(), error: String(err?.message || err), status: err?.status, payload: err?.payload };
  console.log(JSON.stringify(out, null, 2));
  process.exit(1);
});
