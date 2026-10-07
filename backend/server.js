const path = require('node:path');
const express = require('express');
require('dotenv').config();
if (!process.env.APP_URL && process.env.RENDER_EXTERNAL_URL) process.env.APP_URL = process.env.RENDER_EXTERNAL_URL;
require('./db');

const { router: auth, requireAuth, sendError, passwordResetConfigured } = require('./auth');
const { router: tasks } = require('./tasks');
const { router: billing, configured: billingConfigured, PRO_LABEL } = require('./billing');
const { router: legal, legalReady } = require('./legal');
const study = require('./study');
const tomorrowTests = require('./tomorrow-tests');
const { sql } = require('./db');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.razorpay.com; connect-src 'self' https://*.razorpay.com; frame-src https://*.razorpay.com; font-src 'self' data: https://*.razorpay.com; form-action 'self' https://*.razorpay.com; frame-ancestors 'none'; base-uri 'self'");
  next();
});

app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  const expected = process.env.APP_URL ? new URL(process.env.APP_URL).origin : `${req.protocol}://${req.get('host')}`;
  if (origin && origin !== expected) return sendError(res, 403, 'Request origin is not allowed.');
  next();
});
// Razorpay signs the exact request bytes, so mount this before JSON parsing.
app.use('/api/billing', billing);
app.use(express.json({ limit: '32kb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/config', async (req, res) => {
  if (!billingConfigured() || !legalReady() || !passwordResetConfigured()) return res.json({ freeTaskLimit: 60, billingEnabled: false, proPriceLabel: PRO_LABEL });
  try {
    const { proPrice } = require('./billing');
    const price = await proPrice();
    res.json({ freeTaskLimit: 60, billingEnabled: true, proPriceLabel: price.label });
  } catch (error) {
    console.error('Razorpay plan check error:', error.message);
    res.json({ freeTaskLimit: 60, billingEnabled: false, proPriceLabel: PRO_LABEL });
  }
});
app.use('/api/auth', auth);
app.use('/api/tasks', tasks);
app.use('/api/study', study);
app.use('/api/tomorrow-tests', tomorrowTests);
app.use(legal);

app.get('/api/export/tasks.csv', requireAuth, (req, res) => {
  if (req.user.plan !== 'pro') return sendError(res, 403, 'CSV export is a Pro feature.', 'plan_limit');
  const cell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@\-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = [['Title', 'Description', 'Due date', 'Priority', 'Subject', 'Completed', 'Created at']];
  sql.tasks.all(req.user.id).forEach(task => rows.push([task.title, task.description, task.due_date, task.priority, task.project, task.completed ? 'Yes' : 'No', task.created_at]));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="studyvella-tasks.csv"');
  res.send('\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n'));
});

const frontend = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontend));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return sendError(res, 404, 'Endpoint not found.');
  res.sendFile(path.join(frontend, 'index.html'));
});
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  sendError(res, 500, 'Something went wrong. Please try again.');
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 5000;
  app.listen(port, () => console.log(`Studyvella running at http://localhost:${port}`));
}

module.exports = app;
