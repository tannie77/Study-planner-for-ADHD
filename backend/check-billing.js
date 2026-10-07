require('dotenv').config();
if (!process.env.APP_URL && process.env.RENDER_EXTERNAL_URL) process.env.APP_URL = process.env.RENDER_EXTERNAL_URL;
const { configured, proPrice } = require('./billing');
const { legalReady } = require('./legal');

(async () => {
  if (!configured() || !legalReady()) throw new Error('Set APP_URL, Razorpay keys, Plan ID, webhook secret, BUSINESS_NAME, SUPPORT_EMAIL, and REFUND_POLICY.');
  const price = await proPrice();
  console.log(`Razorpay Pro plan verified: ${price.label}`);
  console.log(`Webhook URL: ${process.env.APP_URL}/api/billing/webhook`);
  console.log('Finish with a test subscription and a signed webhook before switching to live keys.');
})().catch(error => {
  console.error(`Billing check failed: ${error.message}`);
  process.exitCode = 1;
});
