const express = require('express');

const router = express.Router();
const POLICY_DATE = '7 October 2026';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function details() {
  const email = process.env.SUPPORT_EMAIL?.trim() || '';
  return {
    owner: process.env.BUSINESS_NAME?.trim() || 'Studyvella',
    contactName: process.env.CONTACT_NAME?.trim() || 'Tan',
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
    phone: process.env.SUPPORT_PHONE?.trim() || '',
    address: process.env.BUSINESS_ADDRESS?.trim() || '',
    refund: process.env.REFUND_POLICY || '',
  };
}

function socialProfile(label, key, domains) {
  const value = process.env[key]?.trim();
  if (!value) return `<span class="social-pending">${label} <small>link coming soon</small></span>`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password ||
        !domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
      throw new Error('Invalid social profile URL');
    }
    return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`;
  } catch {
    return `<span class="social-pending">${label} <small>link coming soon</small></span>`;
  }
}

function legalReady() {
  const data = details();
  return Boolean(process.env.BUSINESS_NAME?.trim() && data.email &&
    ['7-day-first-charge', 'no-refunds'].includes(data.refund));
}

function page(title, eyebrow, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#171217"><title>${escapeHtml(title)} — Studyvella</title><link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/brand.css"><link rel="stylesheet" href="/css/legal.css"></head><body><header class="legal-header"><a class="brand" href="/"><span class="brand-mark">S</span> Studyvella<span class="brand-dot">.</span></a><a href="/">Back to Studyvella ↗</a></header><main class="legal-main"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="legal-date">Updated ${POLICY_DATE}</p>${body}</main><footer class="legal-footer"><span>© Studyvella</span><nav aria-label="Information"><a href="/about">About</a><a href="/contact">Contact</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/refunds">Refunds & cancellation</a></nav></footer></body></html>`;
}

function section(title, content) {
  return `<section><h2>${escapeHtml(title)}</h2><p>${content}</p></section>`;
}

router.get('/about', (req, res) => {
  res.send(page('About Studyvella', 'A CLEAR WAY THROUGH',
    section('Made for ambitious students', 'Studyvella helps students turn a full agenda into a workable plan. Keep assignments and deadlines together, give one task your focus, and use the Tomorrow Test to revisit what still feels unclear.') +
    section('The plans', 'The Free plan includes up to 60 active tasks, subjects, a focus timer, and the Tomorrow Test. Pro adds unlimited active tasks, weekly study insights, and CSV export for ₹299 per month. Pro Plus adds an exam countdown, subject task progress, and a weekly study goal for ₹2,999 once for 15 months when paid plans are available.') +
    section('Who runs it', `Studyvella is operated by ${escapeHtml(details().owner)}. For questions, use the <a href="/contact">Contact page</a>.`)));
});

router.get('/contact', (req, res) => {
  const data = details();
  const contact = data.email
    ? `Email <a href="mailto:${escapeHtml(data.email)}">${escapeHtml(data.email)}</a> for account help, billing questions, refund requests, and privacy requests.`
    : 'Our public support address is being finalized. Paid subscriptions are not available until it is published.';
  const profiles = [
    socialProfile('Instagram', 'INSTAGRAM_URL', ['instagram.com']),
    socialProfile('LinkedIn', 'LINKEDIN_URL', ['linkedin.com']),
    socialProfile('YouTube', 'YOUTUBE_URL', ['youtube.com', 'youtu.be']),
    socialProfile('Pinterest', 'PINTEREST_URL', ['pinterest.com', 'pin.it']),
  ];
  res.send(page('Contact Studyvella', 'WE ARE HERE TO HELP',
    section('Support', contact) +
    section('Contact', `<strong>${escapeHtml(data.contactName)}</strong><br>${escapeHtml(data.owner)}${data.address ? `<br>${escapeHtml(data.address).replace(/\n/g, '<br>')}` : ''}<br>${data.phone ? `Phone: ${escapeHtml(data.phone)}` : 'Example phone: +91 00000 00000 (not monitored)'}`) +
    `<section><h2>Find ${escapeHtml(data.contactName)} online</h2><div class="social-links">${profiles.join('')}</div></section>` +
    section('Before you write', 'For password access, use “Forgot password?” on the login screen. For a Pro subscription, you can check its status or schedule cancellation from your plan settings.')));
});

router.get('/privacy', (req, res) => {
  res.send(page('Privacy Policy', 'YOUR WORK STAYS YOURS',
    section('Who handles your data', `${escapeHtml(details().owner)} operates Studyvella. Contact us through the <a href="/contact">Contact page</a> about your personal information.`) +
    section('What we collect', 'We store your name, email address, a protected password hash, and the tasks, subjects, exams, weekly study goal, study sessions, and Tomorrow Test content you save. We also store account sessions, subscription or order references and status, and limited technical records needed to run and protect the service. Razorpay handles payment details; Studyvella does not store card numbers.') +
    section('Why we use it', 'We use this information to provide your private planner, sign you in, restore account access, manage Pro features and billing, answer support requests, and protect the service. We do not sell your study data.') +
    section('Who helps us run the service', 'Our hosting provider stores the app and database. Razorpay processes Pro payments when available. Our email provider sends password reset messages. These providers process information needed to deliver their services.') +
    section('Cookies and retention', 'A secure, HTTP-only session cookie keeps you signed in for up to 30 days. We keep account and study information while your account is active. Contact us to request access, correction, or deletion; records required for billing or legal obligations may need to be retained. Backups may take additional time to expire.') +
    section('Changes', 'We may update this policy as the service changes. The updated date at the top will show when we last revised it.')));
});

router.get('/terms', (req, res) => {
  res.send(page('Terms of Service', 'THE GROUND RULES',
    section('Using Studyvella', `Studyvella is provided by ${escapeHtml(details().owner)} as a study planning tool. Keep your account details accurate and your password private. Use the service lawfully and do not interfere with other accounts or the app.`) +
    section('Your content', 'Your tasks, notes, and study answers remain yours. You give us permission to store and display them for you while providing the service. You are responsible for keeping any copies you need.') +
    section('Free, Pro, and Pro Plus', 'Free includes up to 60 active tasks. Pro includes unlimited active tasks, weekly study insights, and CSV export. It costs ₹299 per month and renews each month until cancelled. Pro Plus includes everything in Pro, plus an exam countdown with subject task progress and a weekly study goal tracker. It costs ₹2,999 in one payment and grants access for 15 months from purchase, with no automatic renewal or additional charge during that term. Pro Plus tools become unavailable when that term ends, but saved exams and the goal remain on the account if you buy Pro Plus again. You can schedule cancellation of a monthly subscription in the plan dialog; access continues until the end of the current billing period. See our <a href="/refunds">Refunds & cancellation policy</a>.') +
    section('Availability and support', 'We aim to keep Studyvella available, but maintenance and outages can happen. Studyvella is a planning aid and cannot guarantee academic results. Contact us through the <a href="/contact">Contact page</a> if something goes wrong.') +
    section('Changes to these terms', 'We may revise these terms when the product or billing changes. The updated date above identifies the latest version.')));
});

router.get('/refunds', (req, res) => {
  const data = details();
  const policy = data.refund === '7-day-first-charge'
    ? 'You may request a refund of your first monthly Pro charge within seven days of that charge by contacting support. Later renewal charges are normally not refundable, except where required by law or if we billed you in error. Approved refunds go back to the original payment method.'
    : data.refund === 'no-refunds'
      ? 'Pro charges are normally nonrefundable after payment, except where required by law or if we billed you in error. Contact support if you believe a charge is incorrect.'
      : 'The refund rule is being finalized. Paid subscriptions remain unavailable until we publish it.';
  res.send(page('Refunds & cancellation', 'YOUR PLAN, YOUR CALL',
    section('What the paid plans cost', 'The monthly Pro subscription costs ₹299 INR per month and renews automatically until cancelled. The 15-month Pro Plus pass costs ₹2,999 INR in one upfront payment. It does not renew automatically, and there are no further charges for that pass during its 15-month term.') +
    section('Cancel a subscription', 'Open your plan dialog in Studyvella and choose “Cancel Pro at period end.” Your Pro access continues until the end of the current billing period, and future renewal charges stop once cancellation takes effect. You can also contact support if the in-app control is unavailable.') +
    section('Monthly subscription refunds', policy) +
    section('Pro Plus pass refunds', 'The ₹2,999 upfront pass is nonrefundable after purchase, except where a refund is required by law or we billed you in error. Contact support if you believe a charge is incorrect. A full refund ends access from that pass.') +
    section('Questions or requests', data.email ? `Email <a href="mailto:${escapeHtml(data.email)}">${escapeHtml(data.email)}</a> with the account email and charge date. Do not send card numbers.` : 'Use the Contact page once our support address is published.')));
});

module.exports = { router, legalReady };
