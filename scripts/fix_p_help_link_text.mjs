#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || path.join(process.cwd(), 'p-site');

function patch(html){
  let changed=false;

  // Find the help link localization block we previously inserted and extend it to set textContent.
  const re = /\/\/ Help link: follow the same-language contact page[\s\S]*?helpLink\.href = contactUrl;[\s\S]*?\n\s*\}\n\s*\} catch \{\}/m;
  if (re.test(html) && !html.includes("helpLink.href = contactUrl;\n          helpLink.textContent")) {
    html = html.replace(re, (block)=>{
      changed=true;
      // Insert setting textContent right after href.
      return block.replace('helpLink.href = contactUrl;', "helpLink.href = contactUrl;\n          helpLink.textContent = contactUrl.replace('https://','');");
    });
  }

  // Also ensure the default HTML anchor isn't hardcoded to English contact.
  html = html.replace(
    /<a href=\"https:\/\/bothook\.me\/contact\.html\" id=\"helpLink\">bothook\.me\/contact\.html<\/a>/g,
    (m)=>{ changed=true; return '<a href="https://bothook.me/contact.html" id="helpLink">bothook.me/contact.html</a>'; }
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
