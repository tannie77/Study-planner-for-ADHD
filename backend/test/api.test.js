const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');

process.env.DB_PATH = ':memory:';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret';
process.env.BUSINESS_NAME = 'Studyvella Test Business';
process.env.SUPPORT_EMAIL = 'support@example.com';
process.env.REFUND_POLICY = '7-day-first-charge';
process.env.RESEND_API_KEY = 're_test_key';
process.env.RESEND_FROM_EMAIL = 'support@example.com';
const app = require('../server');
const { db } = require('../db');
const { addMonthsClamped } = require('../billing');
let server;
let base;
const originalFetch = global.fetch;
const subscriptions = new Map();
const orders = new Map();
const payments = new Map();
const razorpayCalls = [];
let nextSubscription = 1;
let nextOrder = 1;
let mockPlanAmount = 29900;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { global.fetch = originalFetch; server?.close(); db.close(); });

function mockRazorpay() {
  process.env.APP_URL = base;
  process.env.RAZORPAY_KEY_ID = 'rzp_test_studyvella';
  process.env.RAZORPAY_KEY_SECRET = 'test_razorpay_secret';
  process.env.RAZORPAY_PLAN_ID = 'plan_1234567890ABCD';
  global.fetch = async (input, options) => {
    const url = String(input);
    if (!url.startsWith('https://api.razorpay.com/v1/')) return originalFetch(input, options);
    razorpayCalls.push({ url, options });
    let result;
    if (url.includes('/plans/')) {
      result = {
        id: process.env.RAZORPAY_PLAN_ID, period: 'monthly', interval: 1,
        item: { unit_amount: mockPlanAmount, currency: 'INR', active: true },
      };
    } else if (url.endsWith('/orders')) {
      const body = JSON.parse(options.body);
      const id = `order_Test${nextOrder++}`;
      result = { id, amount: body.amount, currency: body.currency, notes: body.notes, status: 'created' };
      orders.set(id, result);
    } else if (url.includes('/orders/')) {
      result = orders.get(url.split('/').at(-1));
    } else if (url.includes('/payments/')) {
      result = payments.get(url.split('/').at(-1));
    } else if (url.endsWith('/subscriptions')) {
      const body = JSON.parse(options.body);
      const id = `sub_Test${nextSubscription++}`;
      result = subscription(id, body.notes.studyvella_user_id, 'created');
      subscriptions.set(id, result);
    } else if (url.endsWith('/cancel')) {
      const id = url.split('/').at(-2);
      result = JSON.parse(options.body).cancel_at_cycle_end === false
        ? { ...subscriptions.get(id), status: 'cancelled' }
        : { ...subscriptions.get(id), has_scheduled_changes: true, change_scheduled_at: 1790000000 };
      subscriptions.set(id, result);
    } else if (url.includes('/subscriptions/')) {
      result = subscriptions.get(url.split('/').at(-1));
      if (!result) return new Response(JSON.stringify({ error: { description: 'Missing test subscription' } }), { status: 404 });
    } else throw new Error(`Unexpected Razorpay API request: ${url}`);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

async function webhookEvent(id, type, subscriptionId) {
  const event = JSON.stringify({ event: type, payload: { subscription: { entity: { id: subscriptionId } } } });
  const signature = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(event).digest('hex');
  return originalFetch(`${base}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': id },
    body: event,
  });
}

async function paymentWebhookEvent(id, type, paymentId) {
  const payload = type === 'refund.processed'
    ? { refund: { entity: { payment_id: paymentId } } }
    : { payment: { entity: { id: paymentId } } };
  const event = JSON.stringify({ event: type, payload });
  const signature = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(event).digest('hex');
  return originalFetch(`${base}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': id },
    body: event,
  });
}

function subscription(id, userId, status = 'active', planId = process.env.RAZORPAY_PLAN_ID) {
  return { id, plan_id: planId, customer_id: 'cust_Test123', status, paid_count: status === 'active' ? 1 : 0, notes: { studyvella_user_id: userId }, current_end: 1790000000, has_scheduled_changes: false };
}

async function request(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
}

test('accounts, private tasks, study log, plan limits, and signed upgrades', async () => {
  assert.equal((await request('/api/health')).data.ok, true);
  assert.equal((await request('/api/tasks')).status, 401);
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.data, /Studyvella/);
  assert.doesNotMatch(page.data, /unpkg.com/);
  for (const path of ['/about', '/contact', '/privacy', '/terms', '/refunds']) {
    const info = await request(path);
    assert.equal(info.status, 200);
    assert.match(info.data, /Studyvella/);
  }

  const first = await request('/api/auth/register', { method: 'POST', body: { name: 'Alex', email: 'alex@example.com', password: 'strong-pass-123' } });
  assert.equal(first.status, 201);
  assert.equal(first.data.user.plan, 'free');
  assert.match(first.headers.get('set-cookie'), /HttpOnly/);
  const second = await request('/api/auth/register', { method: 'POST', body: { name: 'Sam', email: 'sam@example.com', password: 'another-pass-123' } });
  assert.equal(second.status, 201);
  assert.equal((await request('/api/auth/register', { method: 'POST', body: { name: 'Alex', email: 'ALEX@example.com', password: 'strong-pass-123' } })).status, 409);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: 'alex@example.com', password: 'wrong-pass' } })).status, 401);

  const create = await request('/api/tasks', { method: 'POST', cookie: first.cookie, body: { title: '=HYPERLINK("bad")', description: 'Practice <script>safe</script>', dueDate: '2026-10-08', priority: 'high', project: 'Biology' } });
  assert.equal(create.status, 201);
  const id = create.data.task.id;
  assert.equal((await request('/api/tasks', { cookie: first.cookie })).data.tasks.length, 1);
  assert.equal((await request('/api/tasks', { cookie: second.cookie })).data.tasks.length, 0);
  assert.equal((await request(`/api/tasks/${id}`, { method: 'PATCH', cookie: second.cookie, body: { completed: true } })).status, 404);
  assert.equal((await request(`/api/tasks/${id}`, { method: 'DELETE', cookie: second.cookie })).status, 404);
  assert.equal((await request(`/api/tasks/${id}`, { method: 'PATCH', cookie: first.cookie, body: { userId: second.data.user.id } })).status, 400);
  assert.equal((await request('/api/tasks', { method: 'POST', cookie: first.cookie, body: { title: 'Bad date', dueDate: '2026-02-30' } })).status, 400);
  const completed = await request(`/api/tasks/${id}`, { method: 'PATCH', cookie: first.cookie, body: { completed: true } });
  assert.equal(completed.data.task.completed, true);
  assert.ok(completed.data.task.completedAt);

  const study = await request('/api/study/sessions', { method: 'POST', cookie: first.cookie, body: { subject: 'Biology', minutes: 25, localDate: '2026-10-07' } });
  assert.equal(study.status, 201);
  assert.equal((await request('/api/study/sessions', { cookie: second.cookie })).data.sessions.length, 0);
  assert.equal((await request('/api/study/insights?today=2026-10-07', { cookie: first.cookie })).status, 403);
  assert.equal((await request('/api/export/tasks.csv', { cookie: first.cookie })).status, 403);
  assert.equal((await request('/api/billing/checkout', { method: 'POST', cookie: first.cookie })).status, 503);
  assert.equal((await request('/api/tasks', { method: 'POST', cookie: first.cookie, headers: { Origin: 'https://attacker.example' }, body: { title: 'blocked' } })).status, 403);

  mockRazorpay();
  const checkout = await request('/api/billing/checkout', { method: 'POST', cookie: first.cookie });
  assert.equal(checkout.status, 200);
  subscriptions.set(checkout.data.subscriptionId, subscription(checkout.data.subscriptionId, first.data.user.id, 'active'));
  const event = () => webhookEvent('evt_studyvella_test', 'subscription.activated', checkout.data.subscriptionId);
  assert.equal((await event()).status, 200);
  assert.equal((await event()).status, 200);
  assert.equal((await request('/api/auth/me', { cookie: first.cookie })).data.user.plan, 'pro');
  const insights = await request('/api/study/insights?today=2026-10-07', { cookie: first.cookie });
  assert.equal(insights.status, 200);
  assert.equal(insights.data.totalMinutes, 25);
  assert.equal(insights.data.subjects[0].subject, 'Biology');
  const csv = await request('/api/export/tasks.csv', { cookie: first.cookie });
  assert.equal(csv.status, 200);
  assert.match(csv.data, /'=HYPERLINK/);

  assert.equal((await request('/api/auth/logout', { method: 'POST', cookie: first.cookie })).status, 200);
  assert.equal((await request('/api/auth/me', { cookie: first.cookie })).status, 401);
});

test('password recovery emails a one-use link and invalidates old sessions', async () => {
  process.env.APP_URL = base;
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.RESEND_FROM_EMAIL = 'support@example.com';
  const priorFetch = global.fetch;
  let sentEmail;
  global.fetch = async (input, options) => {
    if (String(input) === 'https://api.resend.com/emails') {
      sentEmail = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: 'email_test' }), { status: 200 });
    }
    return priorFetch(input, options);
  };
  const registered = await request('/api/auth/register', { method: 'POST', body: { name: 'Riya', email: 'riya@example.com', password: 'old-password-123' } });
  assert.equal(registered.status, 201);
  const unknown = await request('/api/auth/forgot-password', { method: 'POST', body: { email: 'nobody@example.com' } });
  assert.equal(unknown.status, 200);
  assert.equal(sentEmail, undefined);
  const known = await request('/api/auth/forgot-password', { method: 'POST', body: { email: 'riya@example.com' } });
  assert.equal(known.status, 200);
  assert.equal(known.data.message, unknown.data.message);
  assert.deepEqual(sentEmail.to, ['riya@example.com']);
  const token = new URL(sentEmail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal((await request('/api/auth/reset-password', { method: 'POST', body: { token: '0'.repeat(64), password: 'new-password-123' } })).status, 400);
  assert.equal((await request('/api/auth/reset-password', { method: 'POST', body: { token, password: 'new-password-123' } })).status, 200);
  assert.equal((await request('/api/auth/me', { cookie: registered.cookie })).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: 'riya@example.com', password: 'old-password-123' } })).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: 'riya@example.com', password: 'new-password-123' } })).status, 200);
  assert.equal((await request('/api/auth/reset-password', { method: 'POST', body: { token, password: 'again-password-123' } })).status, 400);
  global.fetch = priorFetch;
});

test('Razorpay checkout, payment verification, webhooks, and cancellation', async () => {
  const registered = await request('/api/auth/register', {
    method: 'POST', body: { name: 'Billie', email: 'billie@example.com', password: 'strong-pass-123' },
  });
  const userId = registered.data.user.id;
  const cookie = registered.cookie;
  assert.equal(registered.data.user.hasBilling, true);
  const forged = await originalFetch(`${base}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': '0'.repeat(64), 'X-Razorpay-Event-Id': 'evt_forged' },
    body: JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_Forged' } } } }),
  });
  assert.equal(forged.status, 400);
  assert.equal((await request('/api/auth/me', { cookie })).data.user.plan, 'free');
  const config = await request('/api/config');
  assert.equal(config.data.billingEnabled, true);
  assert.equal(config.data.proPriceLabel, '₹299 / month');
  delete process.env.SUPPORT_EMAIL;
  assert.equal((await request('/api/config')).data.billingEnabled, false);
  assert.equal((await request('/api/billing/checkout', { method: 'POST', cookie })).status, 503);
  process.env.SUPPORT_EMAIL = 'support@example.com';
  process.env.RAZORPAY_PLAN_ID = 'plan_ABCDEFGHIJKLMN';
  mockPlanAmount = 19900;
  assert.equal((await request('/api/config')).data.billingEnabled, false);
  process.env.RAZORPAY_PLAN_ID = 'plan_1234567890ABCD';
  mockPlanAmount = 29900;

  const checkout = await request('/api/billing/checkout', { method: 'POST', cookie });
  assert.equal(checkout.status, 200);
  assert.equal(checkout.data.key, process.env.RAZORPAY_KEY_ID);
  const firstId = checkout.data.subscriptionId;
  assert.match(firstId, /^sub_/);
  const createCall = razorpayCalls.find(call => call.url.endsWith('/subscriptions') && call.options.method === 'POST' && JSON.parse(call.options.body).notes.studyvella_user_id === userId);
  assert.ok(createCall);
  const createBody = JSON.parse(createCall.options.body);
  assert.equal(createBody.plan_id, process.env.RAZORPAY_PLAN_ID);
  assert.equal(createBody.total_count, 120);
  assert.equal((await request('/api/billing/checkout', { method: 'POST', cookie })).data.subscriptionId, firstId);

  const paymentId = 'pay_Test123';
  const signature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${paymentId}|${firstId}`).digest('hex');
  const verifyBody = { razorpay_payment_id: paymentId, razorpay_subscription_id: firstId, razorpay_signature: signature };
  assert.equal((await request('/api/billing/verify', { method: 'POST', cookie, body: { ...verifyBody, razorpay_signature: '0'.repeat(64) } })).status, 400);
  assert.equal((await request('/api/billing/verify', { method: 'POST', cookie, body: verifyBody })).data.plan, 'free');
  subscriptions.set(firstId, { ...subscription(firstId, userId, 'active'), paid_count: 0 });
  assert.equal((await webhookEvent('evt_no_first_charge', 'subscription.activated', firstId)).status, 200);
  assert.equal((await request('/api/auth/me', { cookie })).data.user.plan, 'free');
  subscriptions.set(firstId, subscription(firstId, userId, 'active'));
  assert.equal((await webhookEvent('evt_billing_active', 'subscription.charged', firstId)).status, 200);
  assert.equal((await webhookEvent('evt_billing_active', 'subscription.charged', firstId)).status, 200);
  assert.equal((await request('/api/auth/me', { cookie })).data.user.plan, 'pro');
  assert.equal((await request('/api/billing/checkout', { method: 'POST', cookie })).status, 409);
  assert.equal((await request('/api/billing/status', { cookie })).data.status, 'active');

  const cancel = await request('/api/billing/cancel', { method: 'POST', cookie });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.cancelScheduled, true);
  assert.equal((await request('/api/auth/me', { cookie })).data.user.plan, 'pro');
  assert.equal((await request('/api/billing/status', { cookie })).data.cancelScheduled, true);

  subscriptions.set(firstId, subscription(firstId, userId, 'pending'));
  assert.equal((await webhookEvent('evt_billing_pending', 'subscription.pending', firstId)).status, 200);
  assert.equal((await request('/api/auth/me', { cookie })).data.user.plan, 'free');
  assert.equal((await request('/api/billing/checkout', { method: 'POST', cookie })).status, 409);
  subscriptions.set(firstId, subscription(firstId, userId, 'cancelled'));
  assert.equal((await webhookEvent('evt_billing_cancelled', 'subscription.cancelled', firstId)).status, 200);
  assert.equal((await webhookEvent('evt_late_active', 'subscription.activated', firstId)).status, 200);
  assert.equal((await request('/api/auth/me', { cookie })).data.user.plan, 'free');

  const secondCheckout = await request('/api/billing/checkout', { method: 'POST', cookie });
  assert.equal(secondCheckout.status, 200);
  const secondId = secondCheckout.data.subscriptionId;
  assert.notEqual(secondId, firstId);
  subscriptions.set(secondId, subscription(secondId, userId, 'active'));
  assert.equal((await webhookEvent('evt_second_active', 'subscription.activated', secondId)).status, 200);
  assert.equal((await webhookEvent('evt_old_cancelled', 'subscription.cancelled', firstId)).status, 200);
  assert.equal((await request('/api/auth/me', { cookie })).data.user.plan, 'pro');
  subscriptions.set(secondId, subscription(secondId, userId, 'active', 'plan_Other12345678'));
  assert.equal((await webhookEvent('evt_wrong_plan', 'subscription.updated', secondId)).status, 200);
  assert.equal((await request('/api/auth/me', { cookie })).data.user.plan, 'free');
});

test('15-month upfront pass is one charge, expires, and ends after a full refund', async () => {
  assert.equal(addMonthsClamped('2026-01-31T10:00:00.000Z', 15), '2027-04-30T10:00:00.000Z');
  const buyer = await request('/api/auth/register', { method: 'POST', body: { name: 'Anika', email: 'anika@example.com', password: 'strong-pass-123' } });
  const other = await request('/api/auth/register', { method: 'POST', body: { name: 'Nila', email: 'nila@example.com', password: 'strong-pass-123' } });
  const unstartedMonthly = await request('/api/billing/checkout', { method: 'POST', cookie: buyer.cookie });
  assert.equal(unstartedMonthly.status, 200);
  const checkout = await request('/api/billing/upfront/checkout', { method: 'POST', cookie: buyer.cookie });
  assert.equal(checkout.status, 200);
  assert.equal(subscriptions.get(unstartedMonthly.data.subscriptionId).status, 'cancelled');
  assert.equal(checkout.data.amount, 299900);
  assert.equal(checkout.data.currency, 'INR');
  const orderId = checkout.data.orderId;
  assert.equal((await request('/api/billing/upfront/checkout', { method: 'POST', cookie: buyer.cookie })).data.orderId, orderId);
  const order = orders.get(orderId);
  assert.equal(order.notes.studyvella_user_id, buyer.data.user.id);
  assert.equal(order.notes.studyvella_product, 'upfront-15-months');
  assert.equal((await request('/api/auth/me', { cookie: buyer.cookie })).data.user.plan, 'free');
  const paymentId = 'pay_UpfrontTest1';
  const signature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  const body = { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature };
  assert.equal((await request('/api/billing/upfront/verify', { method: 'POST', cookie: other.cookie, body })).status, 400);
  assert.equal((await request('/api/billing/upfront/verify', { method: 'POST', cookie: buyer.cookie, body: { ...body, razorpay_signature: '0'.repeat(64) } })).status, 400);
  orders.set(orderId, { ...order, status: 'paid' });
  assert.equal((await request('/api/billing/upfront/checkout', { method: 'POST', cookie: buyer.cookie })).status, 409);
  payments.set(paymentId, { id: paymentId, order_id: orderId, amount: 299900, currency: 'INR', status: 'authorized', amount_refunded: 0, created_at: Math.floor(Date.now() / 1000) });
  const pending = await request('/api/billing/upfront/verify', { method: 'POST', cookie: buyer.cookie, body });
  assert.equal(pending.status, 200);
  assert.equal(pending.data.pending, true);
  assert.equal((await request('/api/auth/me', { cookie: buyer.cookie })).data.user.plan, 'free');
  payments.set(paymentId, { ...payments.get(paymentId), status: 'captured', amount: 100 });
  assert.equal((await request('/api/billing/upfront/verify', { method: 'POST', cookie: buyer.cookie, body })).status, 502);
  assert.equal((await request('/api/auth/me', { cookie: buyer.cookie })).data.user.plan, 'free');
  payments.set(paymentId, { ...payments.get(paymentId), amount: 299900 });
  const verified = await request('/api/billing/upfront/verify', { method: 'POST', cookie: buyer.cookie, body });
  assert.equal(verified.status, 200);
  assert.equal(verified.data.plan, 'pro');
  const expiresAt = verified.data.expiresAt;
  assert.ok(Date.parse(expiresAt) > Date.now() + 14 * 30 * 24 * 60 * 60 * 1000);
  assert.equal((await request('/api/billing/upfront/verify', { method: 'POST', cookie: buyer.cookie, body })).data.expiresAt, expiresAt);
  assert.equal((await request('/api/auth/me', { cookie: buyer.cookie })).data.user.upfrontExpiresAt, expiresAt);
  assert.equal((await request('/api/billing/upfront/checkout', { method: 'POST', cookie: buyer.cookie })).status, 409);
  assert.equal((await request('/api/billing/checkout', { method: 'POST', cookie: buyer.cookie })).status, 409);
  payments.set(paymentId, { ...payments.get(paymentId), amount_refunded: 100 });
  assert.equal((await paymentWebhookEvent('evt_partial_refund', 'payment.refunded', paymentId)).status, 200);
  assert.equal((await request('/api/auth/me', { cookie: buyer.cookie })).data.user.plan, 'pro');
  payments.set(paymentId, { ...payments.get(paymentId), amount_refunded: 299900, status: 'refunded' });
  assert.equal((await paymentWebhookEvent('evt_full_refund', 'refund.processed', paymentId)).status, 200);
  assert.equal((await request('/api/auth/me', { cookie: buyer.cookie })).data.user.plan, 'free');
  const secondCheckout = await request('/api/billing/upfront/checkout', { method: 'POST', cookie: other.cookie });
  const secondOrderId = secondCheckout.data.orderId;
  const secondPaymentId = 'pay_UpfrontTest2';
  orders.set(secondOrderId, { ...orders.get(secondOrderId), status: 'paid' });
  payments.set(secondPaymentId, { id: secondPaymentId, order_id: secondOrderId, amount: 299900, currency: 'INR', status: 'captured', amount_refunded: 0, created_at: Math.floor(Date.now() / 1000) });
  assert.equal((await paymentWebhookEvent('evt_upfront_capture', 'payment.captured', secondPaymentId)).status, 200);
  assert.equal((await request('/api/auth/me', { cookie: other.cookie })).data.user.plan, 'pro');
  const beforeOrderEvent = (await request('/api/auth/me', { cookie: other.cookie })).data.user.upfrontExpiresAt;
  assert.equal((await paymentWebhookEvent('evt_upfront_order_paid', 'order.paid', secondPaymentId)).status, 200);
  assert.equal((await request('/api/auth/me', { cookie: other.cookie })).data.user.upfrontExpiresAt, beforeOrderEvent);
  db.prepare('UPDATE users SET upfront_expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', other.data.user.id);
  assert.equal((await request('/api/auth/me', { cookie: other.cookie })).data.user.plan, 'free');
  assert.equal((await request('/api/export/tasks.csv', { cookie: other.cookie })).status, 403);
});

test('free plan permits 60 active tasks, then reopens space when one is completed', async () => {
  const register = await request('/api/auth/register', { method: 'POST', body: { name: 'Taylor', email: 'taylor@example.com', password: 'strong-pass-123' } });
  const cookie = register.cookie;
  let id;
  for (let index = 0; index < 60; index++) {
    const result = await request('/api/tasks', { method: 'POST', cookie, body: { title: `Study item ${index + 1}` } });
    assert.equal(result.status, 201);
    if (index === 0) id = result.data.task.id;
  }
  const blocked = await request('/api/tasks', { method: 'POST', cookie, body: { title: 'One more' } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'plan_limit');
  assert.equal((await request(`/api/tasks/${id}`, { method: 'PATCH', cookie, body: { completed: true } })).status, 200);
  assert.equal((await request('/api/tasks', { method: 'POST', cookie, body: { title: 'Now there is room' } })).status, 201);
});

test('Tomorrow Test saves a private question and repeats it until clear', async () => {
  const first = await request('/api/auth/register', { method: 'POST', body: { name: 'Mia', email: 'mia@example.com', password: 'strong-pass-123' } });
  const second = await request('/api/auth/register', { method: 'POST', body: { name: 'Leo', email: 'leo@example.com', password: 'strong-pass-123' } });
  assert.equal((await request('/api/tomorrow-tests')).status, 401);
  const created = await request('/api/tomorrow-tests', { method: 'POST', cookie: first.cookie, body: {
    subject: 'Chemistry', question: 'Why do atoms bond?', initialThought: 'To become stable', localDate: '2026-10-07',
  } });
  assert.equal(created.status, 201);
  assert.equal(created.data.test.reviewOn, '2026-10-08');
  assert.equal(created.data.test.attempts, 0);
  const id = created.data.test.id;
  assert.equal((await request('/api/tomorrow-tests', { cookie: second.cookie })).data.tests.length, 0);
  assert.equal((await request(`/api/tomorrow-tests/${id}/review`, { method: 'POST', cookie: second.cookie, body: { answer: 'Answer', outcome: 'clear', localDate: '2026-10-08' } })).status, 404);
  assert.equal((await request(`/api/tomorrow-tests/${id}/review`, { method: 'POST', cookie: first.cookie, body: { answer: 'Answer', outcome: 'clear', localDate: '2026-10-07' } })).status, 409);
  assert.equal((await request(`/api/tomorrow-tests/${id}/review`, { method: 'POST', cookie: first.cookie, body: { answer: '', outcome: 'clear', localDate: '2026-10-08' } })).status, 400);
  const again = await request(`/api/tomorrow-tests/${id}/review`, { method: 'POST', cookie: first.cookie, body: { answer: 'Electrons seek a stable configuration', outcome: 'again', localDate: '2026-10-08' } });
  assert.equal(again.status, 200);
  assert.equal(again.data.test.reviewOn, '2026-10-09');
  assert.equal(again.data.test.attempts, 1);
  assert.equal(again.data.test.lastAnswer, 'Electrons seek a stable configuration');
  const clear = await request(`/api/tomorrow-tests/${id}/review`, { method: 'POST', cookie: first.cookie, body: { answer: 'Bonding lowers energy for the atoms', outcome: 'clear', localDate: '2026-10-09' } });
  assert.equal(clear.data.test.status, 'clear');
  assert.equal(clear.data.test.attempts, 2);
  assert.ok(clear.data.test.resolvedAt);
  assert.equal((await request(`/api/tomorrow-tests/${id}/review`, { method: 'POST', cookie: first.cookie, body: { answer: 'again', outcome: 'again', localDate: '2026-10-10' } })).status, 409);
  assert.equal((await request(`/api/tomorrow-tests/${id}`, { method: 'DELETE', cookie: second.cookie })).status, 404);
  assert.equal((await request(`/api/tomorrow-tests/${id}`, { method: 'DELETE', cookie: first.cookie })).status, 204);
  assert.equal((await request('/api/tomorrow-tests', { cookie: first.cookie })).data.tests.length, 0);
  assert.equal((await request('/api/tomorrow-tests', { method: 'POST', cookie: first.cookie, body: { subject: 'Math', question: 'Invalid date', localDate: '2026-02-30' } })).status, 400);
});
