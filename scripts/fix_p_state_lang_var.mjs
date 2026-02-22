#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || path.join(process.cwd(), 'p-site');

function patch(html){
  let changed=false;

  // Replace fetchState URL construction that depends on `best` being defined.
  const needle = "const url = `/api/p/state?uuid=${encodeURIComponent(u)}&lang=${encodeURIComponent(best)}`;";
  if (html.includes(needle)) {
    const repl = "const urlLangRaw = (new URLSearchParams(location.search)).get('lang');\n          const pathLangRaw = (location.pathname.match(/^\\/([a-z]{2}(?:-[a-z]{2})?)\\//i) || [null, null])[1];\n          const pref = localStorage.getItem('bothook_lang_pref');\n          const navLang = (navigator.language || '').toLowerCase();\n          const bestLang = (urlLangRaw || pathLangRaw || pref || (navLang.startsWith('zh') ? 'zh' : 'en')).toLowerCase();\n          const url = `/api/p/state?uuid=${encodeURIComponent(u)}&lang=${encodeURIComponent(bestLang)}`;";
    html = html.replace(needle, repl);
    changed=true;
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
