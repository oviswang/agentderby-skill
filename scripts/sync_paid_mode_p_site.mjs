#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || path.join(process.cwd(), 'p-site');

function patch(html){
  let changed=false;

  // 1) CSS: add kv styles once
  if (!html.includes('.kv{display:grid')) {
    html = html.replace(
      /@media \(max-width:860px\)\{\.row\{grid-template-columns:1fr\}\}\n  <\/style>/,
      (m)=>{
        changed=true;
        return `@media (max-width:860px){.row{grid-template-columns:1fr}}
    .kv{display:grid;grid-template-columns:140px minmax(0,1fr);gap:8px 12px;margin-top:10px}
    .kv .k{color:rgba(169,182,214,.85);font-size:12px;letter-spacing:.14em;text-transform:uppercase}
    .kv .v{color:rgba(232,238,252,.95);font-size:13px;overflow-wrap:anywhere;word-break:normal}
  </style>`;
      }
    );
  }

  // 2) HTML: insert paid cards after intro
  if (!html.includes('id="paidCard"')) {
    const insert = `

    <div class="card" id="paidCard" style="margin-top:12px; display:none;">
      <div class="hint" style="color:rgba(232,238,252,.92); font-weight:700;">Subscription</div>
      <p><strong>✅ Subscription active.</strong></p>
      <p class="hint">You can relink WhatsApp here. For billing actions (cancel / payment method), please contact support.</p>
      <div class="btns" style="margin-top:10px;">
        <button class="primary" id="paidRelinkBtn" type="button">Relink device</button>
        <button id="paidUpgradeBtn" type="button" disabled>Upgrade (coming soon)</button>
      </div>
    </div>

    <div class="row" id="paidInfoGrid" style="display:none;">
      <div class="card">
        <div class="hint" style="color:rgba(232,238,252,.92); font-weight:700;">Your server</div>
        <div class="kv" id="paidServerKv"></div>
      </div>
      <div class="card">
        <div class="hint" style="color:rgba(232,238,252,.92); font-weight:700;">Account & delivery</div>
        <div class="kv" id="paidAccountKv"></div>
      </div>
    </div>
`;
    html = html.replace(/<p id="pageIntro">([\s\S]*?)<\/p>/, (m)=>{changed=true; return m+insert;});
  }

  // 3) Add IDs so we can hide unpaid top card and next-step card
  if (!html.includes('id="linkingCard"')) {
    html = html.replace(
      /<div class="card" style="margin-top:12px;">\n      <div class="hint" id="importantTitle"/,
      (m)=>{changed=true; return '<div class="card" id="linkingCard" style="margin-top:12px;">\n      <div class="hint" id="importantTitle"';}
    );
  }
  if (!html.includes('id="nextStepCard"')) {
    html = html.replace(
      /<div class="card">\n        <div class="hint" id="nextStepTitle">Next step<\/div>/,
      (m)=>{changed=true; return '<div class="card" id="nextStepCard">\n        <div class="hint" id="nextStepTitle">Next step</div>';}
    );
  }

  // 4) JS: add paid mode handling (fetchState already exists)
  if (!html.includes('function setPaidInfo')) {
    html = html.replace(
      /\/\/ If backend reports busy,[\s\S]*?fetchState\(\)\.then\(\(st\)=>\{[\s\S]*?\}\);/,
      (block)=>{
        changed=true;
        return block + `

      function renderKv(elBox, pairs){
        if (!elBox) return;
        elBox.innerHTML = '';
        for (const [k,v] of pairs) {
          const kEl = document.createElement('div');
          kEl.className='k';
          kEl.textContent=String(k);
          const vEl = document.createElement('div');
          vEl.className='v';
          vEl.textContent = (v === null || v === undefined || v === '') ? '—' : String(v);
          elBox.appendChild(kEl);
          elBox.appendChild(vEl);
        }
      }

      function setPaidInfo(st){
        try {
          const inst = st.instance || null;
          const sub = st.subscription || null;
          const del = st.delivery || null;
          const serverBox = document.getElementById('paidServerKv');
          const acctBox = document.getElementById('paidAccountKv');

          const cfg = inst && inst.config ? inst.config : null;

          const serverPairs = [];
          serverPairs.push(['Public IP', inst && inst.public_ip]);
          serverPairs.push(['Region/Zone', inst ? ((String(inst.region||'') + ' ' + String(inst.zone||'')).trim()) : '']);
          serverPairs.push(['Config', cfg ? (String(cfg.cpu||'—') + ' vCPU · ' + String(cfg.memory_gb||'—') + ' GB RAM') : '—']);
          serverPairs.push(['Egress bandwidth', (cfg && cfg.internet_max_bw_out_mbps) ? (String(cfg.internet_max_bw_out_mbps) + ' Mbps') : '—']);
          serverPairs.push(['Health', inst && inst.health_status]);
          serverPairs.push(['Lifecycle', inst && inst.lifecycle_status]);

          const acctPairs = [];
          acctPairs.push(['UUID', st.uuid]);
          acctPairs.push(['Subscription', sub && sub.status]);
          acctPairs.push(['Plan', sub && sub.plan]);
          acctPairs.push(['Ends at', sub && sub.cancel_at]);
          acctPairs.push(['Delivery status', del && del.status]);
          acctPairs.push(['Bound WhatsApp', del && del.wa_jid ? '(bound)' : '(unknown)']);
          acctPairs.push(['Bound at', del && del.bound_at]);

          renderKv(serverBox, serverPairs);
          renderKv(acctBox, acctPairs);
        } catch {}
      }

      // Paid mode: show paid UI and hide unpaid guidance
      fetchState().then((st)=>{
        if (!st || !st.ok) return;
        if (st.state === 'PAID_ACTIVE') {
          const paidCard = document.getElementById('paidCard');
          const paidInfoGrid = document.getElementById('paidInfoGrid');
          const linkingCard = document.getElementById('linkingCard');
          const nextStepCard = document.getElementById('nextStepCard');
          if (paidCard) paidCard.style.display = 'block';
          if (paidInfoGrid) paidInfoGrid.style.display = 'grid';
          if (linkingCard) linkingCard.style.display = 'none';
          if (nextStepCard) nextStepCard.style.display = 'none';
          setPaidInfo(st);

          const relinkBtn = document.getElementById('paidRelinkBtn');
          if (relinkBtn) {
            relinkBtn.addEventListener('click', () => {
              // Use existing restart flow (force=true)
              verifyCard.style.display = 'block';
              verifyCard.scrollIntoView({behavior:'smooth', block:'start'});
              restartBtn.style.display = 'inline-block';
              restartBtn.disabled = false;
              getQrBtn.style.display = 'none';
              const s = window.__bothook_i18n || {};
              qrStatus.textContent = s.verifyFirst || 'Complete verification first, then refresh QR.';
            });
          }
        }
      });
`;
      }
    );
  }

  // 5) Update saveHint: remove subscription management mention (if still present)
  html = html.replace(
    /Save it — you can use it later to relink, check status, or manage your subscription\./,
    () => { changed=true; return 'Save it — you can use it later to relink or check status.'; }
  );

  return { html, changed };
}

function main(){
  const pages=[];
  pages.push(path.join(root,'index.html'));
  for (const d of fs.readdirSync(root, {withFileTypes:true})){
    if (!d.isDirectory()) continue;
    const p = path.join(root,d.name,'index.html');
    if (fs.existsSync(p)) pages.push(p);
  }

  let touched=0;
  for (const p of pages){
    const src=fs.readFileSync(p,'utf8');
    const {html,changed}=patch(src);
    if (changed){
      fs.writeFileSync(p, html, 'utf8');
      touched++;
      console.log('[patched]', path.relative(process.cwd(), p));
    }
  }
  console.log(JSON.stringify({ok:true,touched},null,2));
}

main();
