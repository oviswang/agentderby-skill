#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || path.join(process.cwd(), 'p-site');

function patch(html){
  let changed=false;

  // 1) Add forceRelink flag once (for non-zh pages; safe if already present)
  if (!html.includes('let forceRelink')) {
    // Insert near the paid relink section marker if present, otherwise near top of script.
    const marker = '// Paid mode: show paid UI and hide unpaid guidance';
    if (html.includes(marker)) {
      html = html.replace(marker, `// Paid-mode relink flag\n      let forceRelink = false;\n\n      ${marker}`);
      changed=true;
    }
  }

  // 2) Make paidRelinkBtn actually open the verification flow (Turnstile) and set forceRelink
  // Replace the current handler body if it matches the simplified version inserted earlier.
  const relinkBlockRe = /const relinkBtn = document\.getElementById\('paidRelinkBtn'\);[\s\S]*?relinkBtn\.addEventListener\('click', \(\) => \{[\s\S]*?\}\);\n\s*\}/m;
  if (relinkBlockRe.test(html)) {
    html = html.replace(relinkBlockRe, (m)=>{
      changed=true;
      return `const relinkBtn = document.getElementById('paidRelinkBtn');
          if (relinkBtn) {
            relinkBtn.addEventListener('click', () => {
              // Paid relink: require Turnstile verification and then force a fresh QR session.
              forceRelink = true;
              try { hasOtherDevice.checked = true; } catch {}
              try { continueBtn.disabled = false; } catch {}
              // Reuse existing verification flow (continue button handler loads Turnstile).
              try { continueBtn.click(); } catch {}
              const s = window.__bothook_i18n || {};
              qrStatus.textContent = (s.verifyFirst || 'Complete verification first. After it passes, click “Get QR code”.') + ' (Relink)';
            });
          }`;
    });
  }

  // 3) Force getQrBtn to use forceRelink when starting provision
  if (html.includes('await startProvision(uuid);') && !html.includes('startProvision(uuid, forceRelink)')) {
    html = html.replace('await startProvision(uuid);', 'await startProvision(uuid, forceRelink);\n          forceRelink = false;');
    changed=true;
  }

  // 4) Help/contact link should follow locale (not always English)
  // Add after computing best language (best) where mainHome/backLink are set.
  if (!html.includes('helpLink.href') && html.includes('const mainHome')) {
    html = html.replace(
      /try \{\n        const mainHome[\s\S]*?\} catch \{\}/m,
      (block)=>{
        changed=true;
        return block + `\n\n      // Help link: follow the same-language contact page\n      try {\n        const helpLink = document.getElementById('helpLink');\n        if (helpLink) {\n          const contactUrl = (best && best !== 'en') ? (\`https://bothook.me/\${best}/contact.html\`) : 'https://bothook.me/contact.html';\n          helpLink.href = contactUrl;\n        }\n      } catch {}`;
      }
    );
  }

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
