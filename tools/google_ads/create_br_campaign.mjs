import { GoogleAdsApi } from 'google-ads-api';
import fs from 'node:fs';

// Creates a Brazil-focused Search campaign pointing to https://bothook.me/pt-br/
// Defaults: paused, Maximize Conversions, Google Search only.

const envPath = '/home/ubuntu/.openclaw/credentials/google_ads.env';
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k && v && !process.env[k]) process.env[k] = v;
  }
}

// IMPORTANT: set login_customer_id to MCC when accessing a client customer.
// Some environments may have GOOGLE_ADS_LOGIN_CUSTOMER_ID mis-set to the client customer id; force MCC here.
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = '9776571037';
process.env.GOOGLE_ADS_CUSTOMER_ID = process.env.GOOGLE_ADS_CUSTOMER_ID || '1577191627';

const developer_token = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const client_id = process.env.GOOGLE_ADS_CLIENT_ID;
const client_secret = process.env.GOOGLE_ADS_CLIENT_SECRET;
const refresh_token = process.env.GOOGLE_ADS_REFRESH_TOKEN;
const login_customer_id = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
const customer_id = process.env.GOOGLE_ADS_CUSTOMER_ID;

for (const [k, val] of Object.entries({ developer_token, client_id, client_secret, refresh_token, login_customer_id, customer_id })) {
  if (!val) {
    console.error(`Missing required env: ${k}`);
    process.exit(2);
  }
}

const DAILY_BUDGET = Number(process.env.DAILY_BUDGET || '100'); // in account currency units (SGD)
const FINAL_URL = process.env.FINAL_URL || 'https://bothook.me/pt-br/';
const CAMPAIGN_NAME = process.env.CAMPAIGN_NAME || 'BH-BR-DESKTOP Search v0.1';
const DRY_RUN = String(process.env.DRY_RUN || '') === '1';

// Geo target: Brazil
const BRAZIL_GEO = 'geoTargetConstants/2076';
// Language: Portuguese
const PT_LANG = 'languageConstants/1014';

const api = new GoogleAdsApi({ client_id, client_secret, developer_token });
const customer = api.Customer({ customer_id: String(customer_id), login_customer_id: String(login_customer_id), refresh_token });

const micros = (v) => Math.round(v * 1_000_000);

const main = async () => {
  // Dedupe by name
  const existing = await customer.query(`
    SELECT campaign.id, campaign.name, campaign.status
    FROM campaign
    WHERE campaign.name = '${CAMPAIGN_NAME.replace(/'/g, "\\'")}'
    LIMIT 5
  `);
  if (existing.length) {
    console.log(JSON.stringify({ ok:false, error:'campaign_name_exists', existing: existing.map(r=>({id:r.campaign.id,name:r.campaign.name,status:r.campaign.status})) }, null, 2));
    process.exit(1);
  }

  const budgetName = `${CAMPAIGN_NAME} Budget`;
  const budgetObj = {
    name: budgetName,
    amount_micros: micros(DAILY_BUDGET),
    delivery_method: 'STANDARD',
    explicitly_shared: false,
  };

  if (DRY_RUN) {
    console.log(JSON.stringify({ ok:true, dry_run:true, budgetObj }, null, 2));
    return;
  }

  // Reuse budget if it already exists (idempotency / safer retries)
  const existingBudgets = await customer.query(`
    SELECT campaign_budget.resource_name, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.status
    FROM campaign_budget
    WHERE campaign_budget.name = '${budgetName.replace(/'/g, "\\'")}'
    LIMIT 5
  `);

  let budgetResource = existingBudgets[0]?.campaign_budget?.resource_name || null;
  if (!budgetResource) {
    const budgetCreateRes = await customer.campaignBudgets.create([budgetObj]);
    const first = Array.isArray(budgetCreateRes) ? budgetCreateRes[0] : (budgetCreateRes?.results?.[0] || budgetCreateRes?.result || null);
    budgetResource = first?.resource_name || first?.resourceName || null;
  }

  if (!budgetResource) {
    throw new Error('Failed to create/reuse campaign budget');
  }

  const campaignObj = {
    name: CAMPAIGN_NAME,
    status: 'PAUSED',
    advertising_channel_type: 'SEARCH',
    // Required field (policy compliance). Use the same enum value observed on existing campaigns in this account.
    // (Value mapping varies by API version; in this account existing campaigns show numeric value 3.)
    contains_eu_political_advertising: 3,
    campaign_budget: budgetResource,
    network_settings: {
      target_google_search: true,
      target_search_network: false,
      target_content_network: false,
      target_partner_search_network: false,
    },
    maximize_conversions: {},
  };

  const campCreateRes = await customer.campaigns.create([campaignObj]);
  const campFirst = Array.isArray(campCreateRes) ? campCreateRes[0] : (campCreateRes?.results?.[0] || campCreateRes?.result || null);
  const campaignResource = campFirst?.resource_name || campFirst?.resourceName || null;
  if (!campaignResource) throw new Error('Failed to create campaign');

  // Campaign criteria: location + language
  await customer.campaignCriteria.create([
    { campaign: campaignResource, location: { geo_target_constant: BRAZIL_GEO } },
    { campaign: campaignResource, language: { language_constant: PT_LANG } },
  ]);

  // Ad groups
  const adGroups = [
    { name: 'BR - WhatsApp Assistente', cpc_bid_micros: micros(0.35) },
    { name: 'BR - Automação WhatsApp', cpc_bid_micros: micros(0.35) },
    { name: 'BR - ChatGPT/OpenAI WhatsApp', cpc_bid_micros: micros(0.35) },
    { name: 'BR - VPS/Deploy WhatsApp Bot', cpc_bid_micros: micros(0.35) },
  ];

  const agRes = await customer.adGroups.create(adGroups.map(ag => ({
    name: ag.name,
    campaign: campaignResource,
    status: 'ENABLED',
    type: 'SEARCH_STANDARD',
    cpc_bid_micros: ag.cpc_bid_micros,
  })));

  const agByName = new Map();
  for (let i = 0; i < agRes.length; i++) agByName.set(adGroups[i].name, agRes[i].resource_name);

  // Keywords per ad group
  const KW = {
    'BR - WhatsApp Assistente': [
      ['assistente whatsapp', 'PHRASE'],
      ['assistente de ia whatsapp', 'PHRASE'],
      ['bot whatsapp com ia', 'PHRASE'],
      ['chatbot whatsapp ia', 'PHRASE'],
      ['assistente pessoal whatsapp', 'PHRASE'],
    ],
    'BR - Automação WhatsApp': [
      ['automação whatsapp', 'PHRASE'],
      ['automatizar whatsapp', 'PHRASE'],
      ['automação atendimento whatsapp', 'PHRASE'],
      ['bot para whatsapp', 'PHRASE'],
    ],
    'BR - ChatGPT/OpenAI WhatsApp': [
      ['chatgpt no whatsapp', 'PHRASE'],
      ['openai whatsapp', 'PHRASE'],
      ['gpt whatsapp', 'PHRASE'],
      ['chatgpt whatsapp bot', 'PHRASE'],
    ],
    'BR - VPS/Deploy WhatsApp Bot': [
      ['hospedar chatbot whatsapp', 'PHRASE'],
      ['servidor para bot whatsapp', 'PHRASE'],
      ['vps para bot whatsapp', 'PHRASE'],
      ['deploy bot whatsapp', 'PHRASE'],
    ],
  };

  const kwOps = [];
  for (const [agName, kws] of Object.entries(KW)) {
    const ad_group = agByName.get(agName);
    for (const [text, match] of kws) {
      kwOps.push({
        ad_group,
        status: 'ENABLED',
        keyword: { text, match_type: match },
      });
    }
  }
  await customer.adGroupCriteria.create(kwOps);

  // Campaign-level negative keywords
  const negs = [
    'grátis','gratuito','free','crack','pirata','mod','hack','apk','download','baixar',
    'tutorial','como fazer','curso','aula','github','script','código',
    'whatsapp gb','gbwhatsapp','whatsapp mod','whatsapp web',
    'emprego','vagas','salário'
  ];

  await customer.campaignCriteria.create(negs.map(text => ({
    campaign: campaignResource,
    negative: true,
    keyword: { text, match_type: 'PHRASE' },
  })));

  // RSA ads (1 per ad group)
  const mkRsa = (agName) => {
    const headlines = [
      'OpenClaw no WhatsApp em 1 minuto',
      'Sem VPS. Sem instalação. 24/7',
      'Máquina dedicada (não compartilhada)',
      'Assinatura: US$19,8/mês',
      'Use sua própria chave OpenAI',
      'Cancele quando quiser',
      'Mais privacidade e controle',
    ].slice(0, 10).map(text => ({ text }));

    const descriptions = [
      'Conecte e use. Nós cuidamos do servidor, do vínculo no WhatsApp e da estabilidade. Feito para produtividade.',
      'Ideal para founders, consultores e equipes enxutas. Assistente sempre online no WhatsApp.',
    ].map(text => ({ text }));

    return {
      ad_group: agByName.get(agName),
      status: 'ENABLED',
      ad: {
        final_urls: [FINAL_URL],
        responsive_search_ad: {
          headlines,
          descriptions,
          path1: 'whatsapp',
          path2: 'openclaw',
        }
      }
    };
  };

  const adOps = Object.keys(KW).map(mkRsa);
  await customer.adGroupAds.create(adOps);

  console.log(JSON.stringify({
    ok: true,
    campaign: { name: CAMPAIGN_NAME, resource_name: campaignResource },
    budget: { daily_budget: DAILY_BUDGET, resource_name: budgetResource },
    final_url: FINAL_URL,
    notes: 'Campaign created PAUSED. Enable manually after review.',
  }, null, 2));
};

main().catch(err => {
  console.error('Failed:', err?.message || err);
  if (err?.errors) console.error(JSON.stringify(err.errors, null, 2));
  process.exit(1);
});
