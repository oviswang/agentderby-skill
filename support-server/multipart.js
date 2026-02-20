// Minimal multipart/form-data parser (no external deps)
// - extracts text fields only
// - ignores files
// NOTE: not a full RFC parser; sufficient for SendGrid Inbound Parse.

function parseHeaders(headerBlock) {
  const headers = {};
  for (const line of headerBlock.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    headers[k] = v;
  }
  return headers;
}

function parseContentDisposition(v) {
  const out = {};
  const parts = String(v || '').split(';').map(s => s.trim()).filter(Boolean);
  out.type = (parts.shift() || '').toLowerCase();
  for (const p of parts) {
    const m = p.match(/^([a-zA-Z0-9_-]+)=(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[m[1].toLowerCase()] = val;
  }
  return out;
}

function parseMultipart(buffer, boundary) {
  const out = {};
  const sep = Buffer.from(`--${boundary}`);
  let start = buffer.indexOf(sep);
  if (start === -1) return out;

  while (start !== -1) {
    // move to after boundary
    start += sep.length;
    // end marker
    if (buffer.slice(start, start + 2).toString() === '--') break;
    // skip CRLF
    if (buffer.slice(start, start + 2).toString() === '\r\n') start += 2;

    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd === -1) break;
    const headerBlock = buffer.slice(start, headerEnd).toString('utf8');
    const headers = parseHeaders(headerBlock);

    const bodyStart = headerEnd + 4;
    let next = buffer.indexOf(sep, bodyStart);
    if (next === -1) break;
    // body ends with CRLF before boundary
    let bodyEnd = next;
    if (buffer.slice(bodyEnd - 2, bodyEnd).toString() === '\r\n') bodyEnd -= 2;

    const cd = parseContentDisposition(headers['content-disposition']);
    const fieldName = cd.name;
    const filename = cd.filename;

    if (fieldName && !filename) {
      out[fieldName] = buffer.slice(bodyStart, bodyEnd).toString('utf8');
    }

    start = next;
  }

  return out;
}

module.exports = { parseMultipart };
