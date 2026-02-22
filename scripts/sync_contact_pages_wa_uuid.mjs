#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || path.join(process.cwd(), 'bothook-site');

function patchContact(html) {
  let changed = false;

  // Insert WA field before UUID field (first occurrence)
  if (!html.includes('id="wa"') && html.includes('for="uuid"')) {
    html = html.replace(
      /\n\s*<label class="label" for="uuid">[\s\S]*?<input id="uuid" name="uuid"[^>]*>\n/s,
      (m) => {
        changed = true;
        const waBlock = `\n          <label class="label" for="wa">WhatsApp phone (for verification)</label>\n          <input id="wa" name="wa" type="tel" placeholder="Required for account actions. Example: +65 8123 4567" class="input" />\n\n          <div style="height:12px"></div>\n\n`;
        // Keep existing UUID block, but adjust placeholder/label later.
        return waBlock + m.trimEnd() + "\n";
      }
    );
  }

  // Adjust UUID label/placeholder to indicate required for account actions (if not already)
  html = html.replace(
    /<label class="label" for="uuid">([^<]*UUID[^<]*)<\/label>/,
    (m) => {
      if (m.includes('Delivery') || m.includes('交付') || m.includes('必填')) return m;
      changed = true;
      return '<label class="label" for="uuid">UUID / Delivery link (for lookup)</label>';
    }
  );
  html = html.replace(
    /<input id="uuid" name="uuid" type="text" placeholder="([^"]*)" class="input" \/>/,
    (m, p1) => {
      if (p1.toLowerCase().includes('required') || p1.includes('必填')) return m;
      changed = true;
      return '<input id="uuid" name="uuid" type="text" placeholder="Required for account actions. UUID or https://p.bothook.me/..." class="input" />';
    }
  );

  // Ensure payload includes wa
  html = html.replace(
    /const payload = \{\n\s*email: form\.email\.value,\n/,
    (m) => {
      if (html.includes('wa: form.wa.value')) return m;
      changed = true;
      return m + '        wa: form.wa.value,\n';
    }
  );

  // Add/adjust top description to mention WA+UUID for account actions
  html = html.replace(
    /<p class="p">([^<]*reply[^<]*email[^<]*\.)<\/p>/i,
    (m, p1) => {
      if (/WhatsApp phone/i.test(m)) return m;
      changed = true;
      return `<p class="p">${p1} For account actions (like cancellation), please include your WhatsApp phone + UUID/delivery link for verification.</p>`;
    }
  );

  return { html, changed };
}

function main(){
  const files = [];
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (dirent.isDirectory()) {
      const p = path.join(root, dirent.name, 'contact.html');
      if (fs.existsSync(p)) files.push(p);
    }
  }
  // also include root contact.html and zh/contact.html if present
  for (const p of [path.join(root,'contact.html'), path.join(root,'zh','contact.html')]) {
    if (fs.existsSync(p) && !files.includes(p)) files.push(p);
  }

  let touched = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const { html, changed } = patchContact(src);
    if (changed) {
      fs.writeFileSync(f, html, 'utf8');
      touched++;
      console.log('[patched]', path.relative(process.cwd(), f));
    }
  }
  console.log(JSON.stringify({ ok:true, touched }, null, 2));
}

main();
