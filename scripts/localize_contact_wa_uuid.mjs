#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || path.join(process.cwd(), 'bothook-site');

const MAP = {
  'ar': {
    waLabel: 'رقم واتساب (للتحقق)',
    waPh: 'مطلوب: رقم واتساب الخاص بك (مثال: +65 8123 4567)',
    uuidLabel: 'UUID / رابط التسليم (للتعرّف)',
    uuidPh: 'مطلوب: UUID أو https://p.bothook.me/...'
  },
  'de': {
    waLabel: 'WhatsApp-Nummer (zur Verifizierung)',
    waPh: 'Pflichtfeld: deine WhatsApp-Nummer (z. B. +65 8123 4567)',
    uuidLabel: 'UUID / Auslieferungslink (zur Zuordnung)',
    uuidPh: 'Pflichtfeld: UUID oder https://p.bothook.me/...'
  },
  'es': {
    waLabel: 'Número de WhatsApp (para verificación)',
    waPh: 'Obligatorio: tu número de WhatsApp (ej.: +65 8123 4567)',
    uuidLabel: 'UUID / enlace de entrega (para localizar)',
    uuidPh: 'Obligatorio: UUID o https://p.bothook.me/...'
  },
  'fr': {
    waLabel: 'Numéro WhatsApp (pour vérification)',
    waPh: 'Requis : votre numéro WhatsApp (ex. +65 8123 4567)',
    uuidLabel: 'UUID / lien de livraison (pour retrouver)',
    uuidPh: 'Requis : UUID ou https://p.bothook.me/...'
  },
  'hi': {
    waLabel: 'WhatsApp नंबर (सत्यापन के लिए)',
    waPh: 'आवश्यक: आपका WhatsApp नंबर (उदा.: +65 8123 4567)',
    uuidLabel: 'UUID / डिलीवरी लिंक (खोज के लिए)',
    uuidPh: 'आवश्यक: UUID या https://p.bothook.me/...'
  },
  'id': {
    waLabel: 'Nomor WhatsApp (untuk verifikasi)',
    waPh: 'Wajib: nomor WhatsApp Anda (contoh: +65 8123 4567)',
    uuidLabel: 'UUID / tautan pengiriman (untuk pencarian)',
    uuidPh: 'Wajib: UUID atau https://p.bothook.me/...'
  },
  'ja': {
    waLabel: 'WhatsApp番号（確認用）',
    waPh: '必須：WhatsAppの電話番号（例：+65 8123 4567）',
    uuidLabel: 'UUID / 交付リンク（照合用）',
    uuidPh: '必須：UUID または https://p.bothook.me/...'
  },
  'ko': {
    waLabel: 'WhatsApp 번호(확인용)',
    waPh: '필수: WhatsApp 전화번호(예: +65 8123 4567)',
    uuidLabel: 'UUID / 전달 링크(조회용)',
    uuidPh: '필수: UUID 또는 https://p.bothook.me/...'
  },
  'pt-br': {
    waLabel: 'Número do WhatsApp (para verificação)',
    waPh: 'Obrigatório: seu número do WhatsApp (ex.: +65 8123 4567)',
    uuidLabel: 'UUID / link de entrega (para localizar)',
    uuidPh: 'Obrigatório: UUID ou https://p.bothook.me/...'
  },
  'ru': {
    waLabel: 'Номер WhatsApp (для проверки)',
    waPh: 'Обязательно: ваш номер WhatsApp (например: +65 8123 4567)',
    uuidLabel: 'UUID / ссылка доставки (для поиска)',
    uuidPh: 'Обязательно: UUID или https://p.bothook.me/...'
  },
  'th': {
    waLabel: 'หมายเลข WhatsApp (สำหรับยืนยัน)',
    waPh: 'จำเป็น: หมายเลข WhatsApp ของคุณ (เช่น +65 8123 4567)',
    uuidLabel: 'UUID / ลิงก์การส่งมอบ (สำหรับค้นหา)',
    uuidPh: 'จำเป็น: UUID หรือ https://p.bothook.me/...'
  },
  'vi': {
    waLabel: 'Số WhatsApp (để xác minh)',
    waPh: 'Bắt buộc: số WhatsApp của bạn (vd: +65 8123 4567)',
    uuidLabel: 'UUID / liên kết bàn giao (để tra cứu)',
    uuidPh: 'Bắt buộc: UUID hoặc https://p.bothook.me/...'
  },
  'zh': {
    waLabel: 'WhatsApp 手机号码（用于校验）',
    waPh: '必填：你的 WhatsApp 手机号（例如 +65 8123 4567）',
    uuidLabel: 'UUID / 交付链接（用于定位）',
    uuidPh: '必填：UUID（例如 a6bec8ff-...）或 https://p.bothook.me/...'
  },
  'zh-tw': {
    waLabel: 'WhatsApp 手機號碼（用於校驗）',
    waPh: '必填：你的 WhatsApp 手機號（例如 +65 8123 4567）',
    uuidLabel: 'UUID / 交付連結（用於定位）',
    uuidPh: '必填：UUID（例如 a6bec8ff-...）或 https://p.bothook.me/...'
  },
  'en': {
    waLabel: 'WhatsApp phone (for verification)',
    waPh: 'Required for account actions (e.g. cancel). Example: +65 8123 4567',
    uuidLabel: 'UUID / Delivery link (for lookup)',
    uuidPh: 'Required for account actions. UUID or https://p.bothook.me/...'
  }
};

function apply(html, loc){
  const m = MAP[loc];
  if (!m) return { html, changed:false };
  let changed = false;

  const rep = (re, to) => {
    const next = html.replace(re, to);
    if (next !== html) { html = next; changed = true; }
  };

  rep(/<label class="label" for="wa">[\s\S]*?<\/label>/, `<label class="label" for="wa">${m.waLabel}</label>`);
  rep(/<input id="wa" name="wa" type="tel" placeholder="[^"]*" class="input" \/>/, `<input id="wa" name="wa" type="tel" placeholder="${m.waPh}" class="input" />`);

  rep(/<label class="label" for="uuid">[\s\S]*?<\/label>/, `<label class="label" for="uuid">${m.uuidLabel}</label>`);
  rep(/<input id="uuid" name="uuid" type="text" placeholder="[^"]*" class="input" \/>/, `<input id="uuid" name="uuid" type="text" placeholder="${m.uuidPh}" class="input" />`);

  return { html, changed };
}

function main(){
  const files = [];
  for (const dirent of fs.readdirSync(root, { withFileTypes:true })) {
    if (!dirent.isDirectory()) continue;
    const loc = dirent.name;
    const p = path.join(root, loc, 'contact.html');
    if (fs.existsSync(p)) files.push({ loc, p });
  }
  // root english
  const rootEn = path.join(root, 'contact.html');
  if (fs.existsSync(rootEn)) files.push({ loc:'en', p: rootEn });

  let touched=0;
  for (const {loc,p} of files) {
    const src=fs.readFileSync(p,'utf8');
    const r=apply(src, loc);
    if (r.changed) {
      fs.writeFileSync(p, r.html, 'utf8');
      touched++;
      console.log('[localized]', path.relative(process.cwd(), p));
    }
  }
  console.log(JSON.stringify({ok:true,touched},null,2));
}

main();
