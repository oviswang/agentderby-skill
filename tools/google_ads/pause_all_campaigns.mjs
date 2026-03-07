import 'dotenv/config';
import { GoogleAdsApi } from 'google-ads-api';
import fs from 'node:fs';
import path from 'node:path';

// Load credentials from the secured env file explicitly (avoid relying on shell env)
const envPath = '/home/ubuntu/.openclaw/credentials/google_ads.env';
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k && v && !process.env[k]) process.env[k] = v;
  }
}

const developer_token = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const client_id = process.env.GOOGLE_ADS_CLIENT_ID;
const client_secret = process.env.GOOGLE_ADS_CLIENT_SECRET;
const refresh_token = process.env.GOOGLE_ADS_REFRESH_TOKEN;
const login_customer_id = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;

const customer_id = process.env.GOOGLE_ADS_CUSTOMER_ID || login_customer_id;

for (const [k, val] of Object.entries({ developer_token, client_id, client_secret, refresh_token, login_customer_id, customer_id })) {
  if (!val) {
    console.error(`Missing required env: ${k}`);
    process.exit(2);
  }
}

const api = new GoogleAdsApi({
  client_id,
  client_secret,
  developer_token,
});

const customer = api.Customer({
  customer_id: String(customer_id),
  login_customer_id: String(login_customer_id),
  refresh_token,
});

const main = async () => {
  console.log(`Target customer_id=${customer_id}`);

  const rows = await customer.query(`
    SELECT campaign.id, campaign.name, campaign.status
    FROM campaign
  `);

  const campaigns = rows.map(r => ({
    id: r.campaign.id,
    name: r.campaign.name,
    status: r.campaign.status,
  }));

  // google-ads-api returns enum as number: 2=ENABLED, 3=PAUSED, 4=REMOVED
  const toPause = campaigns.filter(c => c.status !== 3 && c.status !== 4);

  console.log(`Found ${campaigns.length} campaigns. Need to pause ${toPause.length}.`);

  if (toPause.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Batch updates to avoid huge single request.
  const batchSize = 50;
  let paused = 0;
  for (let i = 0; i < toPause.length; i += batchSize) {
    const batch = toPause.slice(i, i + batchSize);
    await customer.campaigns.update(
      batch.map(c => ({
        resource_name: `customers/${customer_id}/campaigns/${c.id}`,
        status: 'PAUSED',
      }))
    );
    paused += batch.length;
    console.log(`Paused ${paused}/${toPause.length}...`);
  }

  console.log('Done. All non-removed campaigns are now PAUSED.');
};

main().catch(err => {
  console.error('Failed:', err?.message || err);
  if (err?.errors) console.error(JSON.stringify(err.errors, null, 2));
  process.exit(1);
});
