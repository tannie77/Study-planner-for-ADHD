require('dotenv').config();
if (!process.env.APP_URL && process.env.RENDER_EXTERNAL_URL) process.env.APP_URL = process.env.RENDER_EXTERNAL_URL;
const { configured, proPrice } = require('./billing');
const { legalReady } = require('./legal');
const { passwordResetConfigured } = require('./auth');

(async () => {
  if (!configured() || !legalReady() || !passwordResetConfigured()) throw new Error('Set APP_URL, Razorpay keys, Plan ID, webhook secret, BUSINESS_NAME, SUPPORT_EMAIL, REFUND_POLICY, RESEND_API_KEY, and RESEND_FROM_EMAIL.');
  const price = await proPrice();
  console.log(`Razorpay Pro plan verified: ${price.label}`);
  console.log('Upfront Pro pass: ₹2,999 once for 15 months, via Razorpay Orders (no renewal).');
  console.log(`Webhook URL: ${process.env.APP_URL}/api/billing/webhook`);
  console.log('Enable subscription.*, payment.captured, order.paid, and refund.processed events, then test both checkout paths before switching to live keys.');
})().catch(error => {
  console.error(`Billing check failed: ${error.message}`);
  process.exitCode = 1;
});
