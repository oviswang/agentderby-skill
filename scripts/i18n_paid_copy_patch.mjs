#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || path.join(process.cwd(), 'p-site');

function patchHtml(html){
  let changed=false;

  // Ensure paid hint paragraph has an id for localization.
  if (html.includes('You can relink WhatsApp here.') && !html.includes('id="paidHint"')) {
    html = html.replace(
      /<p class="hint">You can relink WhatsApp here\.[^<]*<\/p>/,
      (m)=>{ changed=true; return '<p class="hint" id="paidHint">'+m.replace(/<\/?p[^>]*>/g,'').trim()+'</p>'; }
    );
  }

  // Ensure paid section title has id
  if (html.includes('>Subscription</div>') && !html.includes('id="paidTitle"')) {
    html = html.replace(
      /<div class="hint" style="color:rgba\(232,238,252,\.92\); font-weight:700;">Subscription<\/div>/,
      (m)=>{ changed=true; return '<div class="hint" id="paidTitle" style="color:rgba(232,238,252,.92); font-weight:700;">Subscription</div>'; }
    );
  }

  // Ensure paid active line has id
  if (html.includes('✅ Subscription active.') && !html.includes('id="paidActiveLine"')) {
    html = html.replace(
      /<p><strong>✅ Subscription active\.<\/strong><\/p>/,
      (m)=>{ changed=true; return '<p id="paidActiveLine"><strong>✅ Subscription active.</strong></p>'; }
    );
  }

  // Patch applyStrings to set paid texts
  if (html.includes('function applyStrings(s){') && !html.includes("setText('paidHint'")) {
    html = html.replace(
      /setText\('saveHint', s\.saveHint\);\n/,
      (m)=>{
        changed=true;
        return m + "\n        // Paid mode copy (optional)\n        setText('paidTitle', s.paidTitle);\n        setText('paidActiveLine', s.paidActiveLine);\n        setText('paidHint', s.paidHint);\n        setText('paidRelinkBtn', s.paidRelink);\n        setText('paidUpgradeBtn', s.paidUpgradeComing);\n";
      }
    );
  }

  return { html, changed };
}

function main(){
  const pages=[path.join(root,'index.html')];
  for (const d of fs.readdirSync(root,{withFileTypes:true})){
    if (!d.isDirectory()) continue;
    const p = path.join(root,d.name,'index.html');
    if (fs.existsSync(p)) pages.push(p);
  }

  let touched=0;
  for (const p of pages){
    const src=fs.readFileSync(p,'utf8');
    const {html,changed}=patchHtml(src);
    if (changed){
      fs.writeFileSync(p, html, 'utf8');
      touched++;
      console.log('[patched]', path.relative(process.cwd(), p));
    }
  }
  console.log(JSON.stringify({ok:true,touched},null,2));
}

main();
