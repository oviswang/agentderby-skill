#!/usr/bin/env node
// Generate control-plane/i18n/whatsapp_prompts/<lang>.json for all p-site locales.
// This is intentionally simple and deterministic (no network calls).

import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE = '/home/ubuntu/.openclaw/workspace';
const localesPath = path.join(WORKSPACE, 'p-site/i18n/locales.json');
const outDir = path.join(WORKSPACE, 'control-plane/i18n/whatsapp_prompts');

const locales = JSON.parse(fs.readFileSync(localesPath, 'utf8')).locales;
fs.mkdirSync(outDir, { recursive: true });

// Minimal but locale-matched copy. (Keep it short; user sees this in WhatsApp self-chat.)
const COPY = {
  'en': { langName:'English', welcome:'[bothook] Welcome! Your device is linked.', guide:'To get started: open your UUID page, follow the steps, and paste your OpenAI API key when asked.', promo:'BOTHook: WhatsApp AI device provisioning.' },
  'zh': { langName:'简体中文', welcome:'[bothook] 已连接成功。', guide:'下一步：打开你的 UUID 页面，按引导操作，并在提示时粘贴你的 OpenAI API Key。', promo:'BOTHook：WhatsApp AI 设备交付。' },
  'zh-tw': { langName:'繁體中文', welcome:'[bothook] 已連結成功。', guide:'下一步：打開你的 UUID 頁面，依照引導操作，並在提示時貼上你的 OpenAI API Key。', promo:'BOTHook：WhatsApp AI 裝置交付。' },
  'ja': { langName:'日本語', welcome:'[bothook] 連携が完了しました。', guide:'次へ：UUID ページを開き、案内に従って操作し、求められたら OpenAI API Key を貼り付けてください。', promo:'BOTHook：WhatsApp AI デバイス提供。' },
  'ko': { langName:'한국어', welcome:'[bothook] 연결이 완료되었습니다.', guide:'다음 단계: UUID 페이지를 열고 안내에 따라 진행한 뒤, 요청 시 OpenAI API Key를 붙여넣으세요.', promo:'BOTHook: WhatsApp AI 기기 프로비저닝.' },
  'fr': { langName:'Français', welcome:'[bothook] Connexion réussie.', guide:"Étape suivante : ouvrez votre page UUID, suivez les instructions, puis collez votre clé API OpenAI lorsque c’est demandé.", promo:'BOTHook : provisionnement WhatsApp AI.' },
  'de': { langName:'Deutsch', welcome:'[bothook] Verbindung erfolgreich.', guide:'Nächster Schritt: Öffne deine UUID-Seite, folge den Anweisungen und füge deinen OpenAI API Key ein, wenn du dazu aufgefordert wirst.', promo:'BOTHook: WhatsApp-AI Provisioning.' },
  'es': { langName:'Español', welcome:'[bothook] Conexión exitosa.', guide:'Siguiente paso: abre tu página UUID, sigue las instrucciones y pega tu clave API de OpenAI cuando se solicite.', promo:'BOTHook: aprovisionamiento de WhatsApp AI.' },
  'pt-br': { langName:'Português (Brasil)', welcome:'[bothook] Conectado com sucesso.', guide:'Próximo passo: abra sua página UUID, siga as instruções e cole sua chave de API da OpenAI quando solicitado.', promo:'BOTHook: provisionamento de WhatsApp AI.' },
  'id': { langName:'Bahasa Indonesia', welcome:'[bothook] Berhasil terhubung.', guide:'Langkah berikutnya: buka halaman UUID Anda, ikuti petunjuk, lalu tempel OpenAI API Key saat diminta.', promo:'BOTHook: provisioning WhatsApp AI.' },
  'vi': { langName:'Tiếng Việt', welcome:'[bothook] Kết nối thành công.', guide:'Bước tiếp theo: mở trang UUID của bạn, làm theo hướng dẫn và dán OpenAI API Key khi được yêu cầu.', promo:'BOTHook: cấp phát WhatsApp AI.' },
  'th': { langName:'ภาษาไทย', welcome:'[bothook] เชื่อมต่อสำเร็จแล้ว', guide:'ขั้นถัดไป: เปิดหน้า UUID ของคุณ ทำตามคำแนะนำ แล้ววาง OpenAI API Key เมื่อระบบขอ', promo:'BOTHook: จัดเตรียมอุปกรณ์ WhatsApp AI' },
  'hi': { langName:'हिन्दी', welcome:'[bothook] कनेक्शन सफल हुआ।', guide:'अगला कदम: अपना UUID पेज खोलें, निर्देशों का पालन करें, और जब पूछा जाए तब अपना OpenAI API Key पेस्ट करें।', promo:'BOTHook: WhatsApp AI provisioning.' },
  'ar': { langName:'العربية', welcome:'[bothook] تم الربط بنجاح.', guide:'الخطوة التالية: افتح صفحة UUID الخاصة بك، اتبع التعليمات، ثم الصق مفتاح OpenAI API عند الطلب.', promo:'BOTHook: تهيئة WhatsApp AI.' },
  'ru': { langName:'Русский', welcome:'[bothook] Подключение выполнено.', guide:'Далее: откройте вашу страницу UUID, следуйте инструкциям и вставьте ключ OpenAI API, когда будет запрос.', promo:'BOTHook: WhatsApp AI provisioning.' },
  'tr': { langName:'Türkçe', welcome:'[bothook] Bağlantı başarılı.', guide:'Sonraki adım: UUID sayfanızı açın, yönergeleri izleyin ve istendiğinde OpenAI API anahtarınızı yapıştırın.', promo:'BOTHook: WhatsApp AI provisioning.' }
};

for (const loc of locales) {
  const code = loc.code;
  const c = COPY[code] || COPY['en'];
  const out = {
    langName: c.langName || loc.en || code,
    welcome: c.welcome,
    guide: c.guide,
    promo: c.promo
  };
  fs.writeFileSync(path.join(outDir, code + '.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
}

console.log('generated ' + locales.length + ' prompt files into ' + outDir);
