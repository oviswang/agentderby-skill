// Tencent Cloud TC3-HMAC-SHA256 signing (minimal)
// Ref: https://www.tencentcloud.com/document/product/1278/84301

import crypto from 'node:crypto';

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function hmacSha256(key, msg, enc = null) {
  const h = crypto.createHmac('sha256', key).update(msg, 'utf8');
  return enc ? h.digest(enc) : h.digest();
}

export function tc3Sign({
  secretId,
  secretKey,
  service,
  host,
  region,
  action,
  version,
  payloadObj,
  timestamp,
}) {
  const t = timestamp || Math.floor(Date.now() / 1000);
  const date = new Date(t * 1000).toISOString().slice(0, 10);

  const payload = JSON.stringify(payloadObj || {});
  const hashedPayload = sha256Hex(payload);

  // Canonical request
  const httpRequestMethod = 'POST';
  const canonicalUri = '/';
  const canonicalQueryString = '';
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    httpRequestMethod,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  // String to sign
  const algorithm = 'TC3-HMAC-SHA256';
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign = [
    algorithm,
    String(t),
    credentialScope,
    hashedCanonicalRequest,
  ].join('\n');

  // Signature
  const secretDate = hmacSha256('TC3' + secretKey, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, 'tc3_request');
  const signature = hmacSha256(secretSigning, stringToSign, 'hex');

  const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Host': host,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Region': region,
    'X-TC-Timestamp': String(t),
    'Authorization': authorization,
  };

  return { headers, payload, timestamp: t, date };
}
