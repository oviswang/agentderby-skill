#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || path.join(process.cwd(), 'p-site', 'i18n', 'strings');

const VALUES = {
  'en': {
    paidTitle: 'Subscription',
    paidActiveLine: '✅ Subscription active.',
    paidHint: 'You can relink WhatsApp here. For billing actions (cancel / payment method), please contact support.',
    paidRelink: 'Relink device',
    paidUpgradeComing: 'Upgrade (coming soon)'
  },
  'zh': {
    paidTitle: '订阅状态',
    paidActiveLine: '✅ 订阅已激活',
    paidHint: '你可以在这里重新关联 WhatsApp 设备（Relink）。如需取消订阅/更换支付方式等操作，请提交客服表单（邮箱 + WhatsApp 手机号 + UUID/交付链接），我们会通过邮件协助。',
    paidRelink: '重新关联设备（Relink）',
    paidUpgradeComing: '升级套餐（即将推出）'
  },
  'zh-tw': {
    paidTitle: '訂閱狀態',
    paidActiveLine: '✅ 訂閱已啟用',
    paidHint: '你可以在這裡重新關聯 WhatsApp 裝置（Relink）。如需取消訂閱/更換付款方式等操作，請提交客服表單（Email + WhatsApp 手機號碼 + UUID/交付連結），我們會透過郵件協助。',
    paidRelink: '重新關聯裝置（Relink）',
    paidUpgradeComing: '升級方案（即將推出）'
  },
  'ja': {
    paidTitle: 'サブスクリプション',
    paidActiveLine: '✅ サブスクリプションは有効です。',
    paidHint: 'ここで WhatsApp の再リンク（Relink）ができます。解約や支払い方法の変更などは、サポートフォーム（メール + WhatsApp番号 + UUID/リンク）からご連絡ください。',
    paidRelink: '再リンク（Relink）',
    paidUpgradeComing: 'アップグレード（近日公開）'
  },
  'ko': {
    paidTitle: '구독',
    paidActiveLine: '✅ 구독이 활성화되었습니다.',
    paidHint: '여기에서 WhatsApp 기기를 다시 연결(RelinK)할 수 있습니다. 취소/결제수단 변경 등은 지원 폼(이메일 + WhatsApp 번호 + UUID/링크)으로 문의해 주세요.',
    paidRelink: '기기 재연결 (Relink)',
    paidUpgradeComing: '업그레이드(곧 제공)'
  },
  'de': {
    paidTitle: 'Abo',
    paidActiveLine: '✅ Abo aktiv.',
    paidHint: 'Hier kannst du WhatsApp neu verbinden (Relink). Für Abrechnungsaktionen (Kündigung/Zahlungsmethode) nutze bitte das Support-Formular (E-Mail + WhatsApp-Nummer + UUID/Link).',
    paidRelink: 'Neu verbinden (Relink)',
    paidUpgradeComing: 'Upgrade (bald verfügbar)'
  },
  'fr': {
    paidTitle: 'Abonnement',
    paidActiveLine: '✅ Abonnement actif.',
    paidHint: 'Vous pouvez relier WhatsApp ici (Relink). Pour la facturation (annulation / moyen de paiement), contactez le support via le formulaire (e-mail + WhatsApp + UUID/lien).',
    paidRelink: 'Relier à nouveau (Relink)',
    paidUpgradeComing: 'Mise à niveau (bientôt)'
  },
  'es': {
    paidTitle: 'Suscripción',
    paidActiveLine: '✅ Suscripción activa.',
    paidHint: 'Puedes volver a vincular WhatsApp aquí (Relink). Para acciones de facturación (cancelar / método de pago), usa el formulario de soporte (email + WhatsApp + UUID/enlace).',
    paidRelink: 'Re-vincular (Relink)',
    paidUpgradeComing: 'Mejorar (próximamente)'
  },
  'pt-br': {
    paidTitle: 'Assinatura',
    paidActiveLine: '✅ Assinatura ativa.',
    paidHint: 'Você pode reconectar o WhatsApp aqui (Relink). Para cobrança (cancelar / forma de pagamento), use o formulário de suporte (e-mail + WhatsApp + UUID/link).',
    paidRelink: 'Reconectar (Relink)',
    paidUpgradeComing: 'Upgrade (em breve)'
  },
  'id': {
    paidTitle: 'Langganan',
    paidActiveLine: '✅ Langganan aktif.',
    paidHint: 'Anda bisa menghubungkan ulang WhatsApp di sini (Relink). Untuk penagihan (batalkan / metode pembayaran), kirim formulir dukungan (email + WhatsApp + UUID/tautan).',
    paidRelink: 'Hubungkan ulang (Relink)',
    paidUpgradeComing: 'Upgrade (segera hadir)'
  },
  'hi': {
    paidTitle: 'सब्सक्रिप्शन',
    paidActiveLine: '✅ सब्सक्रिप्शन सक्रिय है।',
    paidHint: 'आप यहाँ WhatsApp को फिर से लिंक (Relink) कर सकते हैं। बिलिंग (रद्द/भुगतान विधि) के लिए सपोर्ट फ़ॉर्म (ईमेल + WhatsApp नंबर + UUID/लिंक) भरें।',
    paidRelink: 'फिर से लिंक करें (Relink)',
    paidUpgradeComing: 'अपग्रेड (जल्द आ रहा है)'
  },
  'ru': {
    paidTitle: 'Подписка',
    paidActiveLine: '✅ Подписка активна.',
    paidHint: 'Здесь можно выполнить повторную привязку WhatsApp (Relink). Для оплаты (отмена/способ оплаты) обратитесь в поддержку через форму (email + WhatsApp + UUID/ссылка).',
    paidRelink: 'Повторная привязка (Relink)',
    paidUpgradeComing: 'Обновить (скоро)'
  },
  'th': {
    paidTitle: 'การสมัครสมาชิก',
    paidActiveLine: '✅ สมัครสมาชิกใช้งานอยู่',
    paidHint: 'คุณสามารถเชื่อม WhatsApp ใหม่ได้ที่นี่ (Relink) สำหรับการเรียกเก็บเงิน (ยกเลิก/เปลี่ยนวิธีชำระเงิน) โปรดติดต่อผ่านแบบฟอร์มซัพพอร์ต (อีเมล + WhatsApp + UUID/ลิงก์)',
    paidRelink: 'เชื่อมใหม่ (Relink)',
    paidUpgradeComing: 'อัปเกรด (เร็วๆ นี้)'
  },
  'tr': {
    paidTitle: 'Abonelik',
    paidActiveLine: '✅ Abonelik aktif.',
    paidHint: 'Buradan WhatsApp’ı yeniden bağlayabilirsiniz (Relink). Faturalandırma işlemleri (iptal/ödeme yöntemi) için destek formunu kullanın (e‑posta + WhatsApp + UUID/bağlantı).',
    paidRelink: 'Yeniden bağla (Relink)',
    paidUpgradeComing: 'Yükselt (yakında)'
  },
  'vi': {
    paidTitle: 'Gói thuê bao',
    paidActiveLine: '✅ Gói thuê bao đang hoạt động.',
    paidHint: 'Bạn có thể liên kết lại WhatsApp tại đây (Relink). Với vấn đề thanh toán (hủy/đổi phương thức), hãy gửi form hỗ trợ (email + WhatsApp + UUID/link).',
    paidRelink: 'Liên kết lại (Relink)',
    paidUpgradeComing: 'Nâng cấp (sắp ra mắt)'
  },
  'ar': {
    paidTitle: 'الاشتراك',
    paidActiveLine: '✅ الاشتراك نشط.',
    paidHint: 'يمكنك إعادة ربط WhatsApp هنا (Relink). لإجراءات الفوترة (الإلغاء/طريقة الدفع)، تواصل عبر نموذج الدعم (البريد + WhatsApp + UUID/الرابط).',
    paidRelink: 'إعادة الربط (Relink)',
    paidUpgradeComing: 'ترقية (قريبًا)'
  }
};

function main(){
  const files = fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
  let touched=0;
  for (const f of files){
    const loc = f.replace(/\.json$/,'');
    const p = path.join(dir,f);
    const obj = JSON.parse(fs.readFileSync(p,'utf8'));
    const v = VALUES[loc] || VALUES['en'];
    let changed=false;
    for (const [k,val] of Object.entries(v)){
      if (obj[k] !== val){ obj[k]=val; changed=true; }
    }
    if (changed){
      fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
      touched++;
      console.log('[updated]', path.relative(process.cwd(), p));
    }
  }
  console.log(JSON.stringify({ok:true,touched},null,2));
}

main();
