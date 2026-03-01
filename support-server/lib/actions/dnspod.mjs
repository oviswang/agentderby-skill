import https from 'node:https';
import { tc3Sign } from '../tc3.mjs';

function reqJson({ hostname, headers, payload, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'POST',
        hostname,
        path: '/',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = body ? JSON.parse(body) : null; } catch {}
          resolve({ status: res.statusCode || 0, headers: res.headers, body, json });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    req.write(payload);
    req.end();
  });
}

export async function dnspodCall({
  secretId,
  secretKey,
  region = '',
  action,
  version = '2021-03-23',
  payloadObj,
  requestId,
}) {
  const service = 'dnspod';
  const host = 'dnspod.tencentcloudapi.com';

  const { headers, payload } = tc3Sign({
    secretId,
    secretKey,
    service,
    host,
    region,
    action,
    version,
    payloadObj,
  });

  if (requestId) headers['X-Request-Id'] = String(requestId);

  const r = await reqJson({ hostname: host, headers, payload });
  return r;
}

export async function dnspodDescribeDomainList({ secretId, secretKey, offset = 0, limit = 20 }) {
  return dnspodCall({
    secretId,
    secretKey,
    region: '',
    action: 'DescribeDomainList',
    payloadObj: { Offset: offset, Limit: limit },
  });
}

export async function dnspodDescribeRecordList({ secretId, secretKey, domain, offset = 0, limit = 100 }) {
  return dnspodCall({
    secretId,
    secretKey,
    region: '',
    action: 'DescribeRecordList',
    payloadObj: { Domain: domain, Offset: offset, Limit: limit },
  });
}

export async function dnspodUpsertRecord({
  secretId,
  secretKey,
  domain,
  subDomain,
  recordType,
  recordLine = '默认',
  value,
  ttl = 600,
}) {
  // Simplest approach: list records, find exact match (subDomain+type+line), then ModifyRecord or CreateRecord.
  const list = await dnspodDescribeRecordList({ secretId, secretKey, domain, offset: 0, limit: 200 });
  const records = list?.json?.Response?.RecordList || [];
  const match = records.find((r) => (
    String(r?.Name || '') === String(subDomain || '')
    && String(r?.Type || '').toUpperCase() === String(recordType || '').toUpperCase()
    && String(r?.Line || '') === String(recordLine || '')
  ));

  if (match && match.RecordId) {
    const old = { RecordId: match.RecordId, Value: match.Value, TTL: match.TTL, Line: match.Line, Type: match.Type, Name: match.Name };
    const mod = await dnspodCall({
      secretId,
      secretKey,
      region: '',
      action: 'ModifyRecord',
      payloadObj: {
        Domain: domain,
        RecordId: match.RecordId,
        SubDomain: subDomain,
        RecordType: recordType,
        RecordLine: recordLine,
        Value: value,
        TTL: ttl,
      },
    });
    return { mode: 'modify', old, result: mod };
  }

  const create = await dnspodCall({
    secretId,
    secretKey,
    region: '',
    action: 'CreateRecord',
    payloadObj: {
      Domain: domain,
      SubDomain: subDomain,
      RecordType: recordType,
      RecordLine: recordLine,
      Value: value,
      TTL: ttl,
    },
  });
  return { mode: 'create', old: null, result: create };
}
