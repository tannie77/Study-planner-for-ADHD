const crypto = require('node:crypto');
const express = require('express');
const { db, sql, effectivePlan } = require('./db');
const { requireAuth, sendError, passwordResetConfigured } = require('./auth');
const { legalReady } = require('./legal');

const router = express.Router();
const PRO_AMOUNT_PAISE = 29900;
const PRO_LABEL = '₹299 / month';
const UPFRONT_AMOUNT_PAISE = 299900;
const UPFRONT_LABEL = '₹2,999 once / 15 months';
const BILLING_CYCLES = 120; // Razorpay requires a bounded subscription; 120 months is ten years.
let planCache;

function configured() {
  const { APP_URL, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_PLAN_ID, RAZORPAY_WEBHOOK_SECRET } = process.env;
  if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(RAZORPAY_KEY_ID || '') ||
      !RAZORPAY_KEY_SECRET || !/^plan_[A-Za-z0-9]{14}$/.test(RAZORPAY_PLAN_ID || '') ||
      !RAZORPAY_WEBHOOK_SECRET) return false;
  try {
    const url = new URL(APP_URL);
    return url.origin === APP_URL && (url.protocol === 'https:' ||
      (process.env.NODE_ENV !== 'production' && url.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(url.hostname)));
  } catch { return false; }
}

function validId(value, prefix) {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
}

function verifySignature(body, signature, secret) {
  if (!/^[a-f0-9]{64}$/i.test(signature || '')) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

function verifyCheckoutSignature(paymentId, subscriptionId, signature) {
  if (!validId(paymentId, 'pay') || !validId(subscriptionId, 'sub')) return false;
  return verifySignature(`${paymentId}|${subscriptionId}`, signature, process.env.RAZORPAY_KEY_SECRET);
}

function addMonthsClamped(isoDate, months) {
  const date = new Date(isoDate);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const finalDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, finalDay));
  return date.toISOString();
}

function syncUpfrontAccess(userId) {
  const expiry = sql.latestUpfrontExpiry.get(userId)?.expires_at || null;
  const user = sql.userById.get(userId);
  const plan = effectivePlan({ ...user, upfront_expires_at: expiry });
  db.prepare('UPDATE users SET upfront_expires_at = ?, plan = ? WHERE id = ?').run(expiry, plan, userId);
  return { plan, expiresAt: expiry };
}

async function fetchPayment(paymentId) {
  if (!validId(paymentId, 'pay')) throw new Error('Invalid payment reference.');
  const payment = await razorpayApi(`payments/${paymentId}`);
  if (payment.id !== paymentId) throw new Error('Razorpay returned a different payment.');
  return payment;
}

async function confirmUpfrontPayment(orderId, paymentId) {
  const saved = sql.upfrontOrder.get(orderId);
  if (!saved) return null; // Other products can use this Razorpay account.
  const [payment, order] = await Promise.all([fetchPayment(paymentId), razorpayApi(`orders/${orderId}`)]);
  if (order.id !== orderId || order.amount !== UPFRONT_AMOUNT_PAISE ||
      order.currency !== 'INR' || order.notes?.studyvella_user_id !== saved.user_id ||
      order.notes?.studyvella_product !== 'upfront-15-months' ||
      payment.order_id !== orderId ||
      payment.amount !== UPFRONT_AMOUNT_PAISE || payment.currency !== 'INR' ||
      saved.amount !== UPFRONT_AMOUNT_PAISE || saved.currency !== 'INR' ||
      (saved.payment_id && saved.payment_id !== paymentId)) {
    throw new Error('Upfront payment details do not match the order.');
  }
  if (order.status !== 'paid' || !['captured', 'refunded'].includes(payment.status)) {
    const user = sql.userById.get(saved.user_id);
    return { plan: effectivePlan(user), expiresAt: user.upfront_expires_at, pending: true };
  }
  if (payment.status === 'refunded' && !saved.paid_at && payment.amount_refunded < UPFRONT_AMOUNT_PAISE) {
    throw new Error('Upfront refund details do not match the order.');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = sql.upfrontOrder.get(orderId);
    if (!current.paid_at && payment.status === 'captured') {
      const paidAt = Number.isInteger(payment.created_at) && payment.created_at > 0
        ? new Date(payment.created_at * 1000).toISOString() : new Date().toISOString();
      const expiresAt = addMonthsClamped(paidAt, 15);
      db.prepare('UPDATE upfront_orders SET payment_id = ?, paid_at = ?, expires_at = ? WHERE order_id = ?')
        .run(paymentId, paidAt, expiresAt, orderId);
    }
    if (payment.amount_refunded >= UPFRONT_AMOUNT_PAISE) {
      db.prepare('UPDATE upfront_orders SET refunded_at = COALESCE(refunded_at, ?) WHERE order_id = ?')
        .run(new Date().toISOString(), orderId);
    }
    const access = syncUpfrontAccess(saved.user_id);
    db.exec('COMMIT');
    return access;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

async function razorpayApi(endpoint, body) {
  const authorization = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const response = await fetch(`https://api.razorpay.com/v1/${endpoint}`, {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: `Basic ${authorization}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.description || 'Razorpay request failed.');
  return result;
}

async function proPrice() {
  if (!configured()) return null;
  const cacheKey = `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}:${process.env.RAZORPAY_PLAN_ID}`;
  if (planCache?.key === cacheKey && planCache.until > Date.now()) return planCache.value;
  const plan = await razorpayApi(`plans/${process.env.RAZORPAY_PLAN_ID}`);
  const amount = plan.item?.unit_amount ?? plan.item?.amount;
  if (plan.id !== process.env.RAZORPAY_PLAN_ID || plan.period !== 'monthly' ||
      plan.interval !== 1 || plan.item?.currency !== 'INR' ||
      amount !== PRO_AMOUNT_PAISE || plan.item?.active === false) {
    throw new Error('The Razorpay Pro plan must be an active ₹299 monthly plan in INR.');
  }
  const value = { label: PRO_LABEL };
  planCache = { key: cacheKey, until: Date.now() + 5 * 60 * 1000, value };
  return value;
}

async function fetchSubscription(subscriptionId) {
  if (!validId(subscriptionId, 'sub')) throw new Error('Invalid subscription reference.');
  const subscription = await razorpayApi(`subscriptions/${subscriptionId}`);
  if (subscription.id !== subscriptionId) throw new Error('Razorpay returned a different subscription.');
  return subscription;
}

function applySubscription(subscription, user) {
  if ((subscription.notes?.studyvella_user_id && subscription.notes.studyvella_user_id !== user.id) ||
      user.razorpay_subscription_id !== subscription.id) {
    throw new Error('Subscription does not belong to this account.');
  }
  const monthlyActive = subscription.status === 'active' && subscription.paid_count > 0 &&
    subscription.plan_id === process.env.RAZORPAY_PLAN_ID ? 1 : 0;
  const plan = effectivePlan({ ...user, monthly_active: monthlyActive });
  db.prepare('UPDATE users SET plan = ?, monthly_active = ?, razorpay_customer_id = COALESCE(?, razorpay_customer_id) WHERE id = ?')
    .run(plan, monthlyActive, subscription.customer_id || null, user.id);
  return plan;
}

async function processEvent(eventId, event) {
  if (sql.razorpayEvent.get(eventId)) return;
  const upfrontPaymentId = ['payment.captured', 'payment.refunded', 'order.paid'].includes(event.event)
    ? event.payload?.payment?.entity?.id : event.event === 'refund.processed'
      ? event.payload?.refund?.entity?.payment_id : null;
  if (upfrontPaymentId) {
    const payment = await fetchPayment(upfrontPaymentId);
    if (validId(payment.order_id, 'order') && sql.upfrontOrder.get(payment.order_id)) {
      await confirmUpfrontPayment(payment.order_id, upfrontPaymentId);
    }
  }
  const subscriptionId = event.event?.startsWith('subscription.')
    ? event.payload?.subscription?.entity?.id : null;
  if (event.event?.startsWith('subscription.') && !validId(subscriptionId, 'sub')) {
    throw new Error('Subscription event is missing its subscription ID.');
  }
  let subscription;
  let user;
  if (subscriptionId) {
    subscription = await fetchSubscription(subscriptionId);
    const userId = subscription.notes?.studyvella_user_id;
    user = (userId && sql.userById.get(userId)) ||
      db.prepare('SELECT * FROM users WHERE razorpay_subscription_id = ?').get(subscriptionId);
    if (!user) subscription = null; // Other products can share the same Razorpay account.
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (sql.razorpayEvent.get(eventId)) { db.exec('COMMIT'); return; }
    if (subscription && user && user.razorpay_subscription_id === subscription.id) {
      applySubscription(subscription, user);
    }
    sql.insertRazorpayEvent.run(eventId, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

router.post('/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return sendError(res, 503, 'Billing is not configured.');
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!raw.length || !verifySignature(raw, req.get('x-razorpay-signature'), process.env.RAZORPAY_WEBHOOK_SECRET)) {
    return sendError(res, 400, 'Invalid signature.');
  }
  const eventId = req.get('x-razorpay-event-id');
  if (!eventId || eventId.length > 255) return sendError(res, 400, 'Missing event ID.');
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return sendError(res, 400, 'Invalid event.'); }
  if (typeof event.event !== 'string') return sendError(res, 400, 'Invalid event.');
  try {
    await processEvent(eventId, event);
    res.json({ received: true });
  } catch (error) {
    console.error('Razorpay webhook error:', error);
    sendError(res, 500, 'Could not process event.');
  }
});

router.use(express.json({ limit: '16kb' }));

router.post('/checkout', requireAuth, async (req, res) => {
  if (!configured() || !legalReady() || !passwordResetConfigured()) return sendError(res, 503, 'Billing is not configured yet.');
  try {
    await proPrice();
    if (req.user.razorpay_subscription_id) {
      const current = await fetchSubscription(req.user.razorpay_subscription_id);
      if (current.notes?.studyvella_user_id && current.notes.studyvella_user_id !== req.user.id) {
        throw new Error('Subscription owner mismatch.');
      }
      if (current.status === 'created') {
        return res.json({ key: process.env.RAZORPAY_KEY_ID, subscriptionId: current.id });
      }
      if (!['cancelled', 'completed', 'expired'].includes(current.status)) {
        applySubscription(current, req.user);
        return sendError(res, 409, 'A subscription already exists. Check its status before starting another.');
      }
    }
    if (req.user.plan === 'pro') {
      return sendError(res, 409, 'Your account is already on Pro.');
    }
    const subscription = await razorpayApi('subscriptions', {
      plan_id: process.env.RAZORPAY_PLAN_ID,
      total_count: BILLING_CYCLES,
      quantity: 1,
      customer_notify: false,
      notes: { studyvella_user_id: req.user.id },
    });
    if (!validId(subscription.id, 'sub') || subscription.plan_id !== process.env.RAZORPAY_PLAN_ID) {
      throw new Error('Razorpay returned an invalid subscription.');
    }
    db.prepare("UPDATE users SET plan = 'free', monthly_active = 0, razorpay_subscription_id = ?, razorpay_customer_id = NULL, razorpay_cancel_requested_at = NULL WHERE id = ?")
      .run(subscription.id, req.user.id);
    res.json({ key: process.env.RAZORPAY_KEY_ID, subscriptionId: subscription.id });
  } catch (error) {
    console.error('Razorpay checkout error:', error);
    sendError(res, 502, 'Could not open checkout. Please try again.');
  }
});

router.post('/upfront/checkout', requireAuth, async (req, res) => {
  if (!configured() || !legalReady() || !passwordResetConfigured()) return sendError(res, 503, 'Billing is not configured yet.');
  try {
    await proPrice();
    if (req.user.plan === 'pro') return sendError(res, 409, 'Your account already has Pro access.');
    if (req.user.razorpay_subscription_id) {
      const current = await fetchSubscription(req.user.razorpay_subscription_id);
      if (current.notes?.studyvella_user_id && current.notes.studyvella_user_id !== req.user.id) {
        throw new Error('Subscription owner mismatch.');
      }
      if (current.status === 'created') {
        const cancelled = await razorpayApi(`subscriptions/${current.id}/cancel`, { cancel_at_cycle_end: false });
        if (cancelled.id !== current.id || cancelled.status !== 'cancelled') {
          throw new Error('Could not close the unstarted monthly checkout.');
        }
        applySubscription(cancelled, req.user);
      } else if (!['cancelled', 'completed', 'expired'].includes(current.status)) {
        return sendError(res, 409, 'Your monthly subscription must finish before choosing the upfront pass.');
      }
    }
    const pending = sql.pendingUpfrontOrder.get(req.user.id);
    if (pending) {
      const existing = await razorpayApi(`orders/${pending.order_id}`);
      if (existing.id !== pending.order_id || existing.amount !== UPFRONT_AMOUNT_PAISE || existing.currency !== 'INR' ||
          existing.notes?.studyvella_user_id !== req.user.id || existing.notes?.studyvella_product !== 'upfront-15-months') {
        throw new Error('Existing upfront order does not match the account.');
      }
      if (['created', 'attempted'].includes(existing.status)) {
        return res.json({ key: process.env.RAZORPAY_KEY_ID, orderId: existing.id, amount: UPFRONT_AMOUNT_PAISE, currency: 'INR' });
      }
      return sendError(res, 409, 'A previous payment is being confirmed. Please check again shortly or contact support.');
    }
    const order = await razorpayApi('orders', {
      amount: UPFRONT_AMOUNT_PAISE, currency: 'INR',
      receipt: `sv15_${crypto.randomBytes(12).toString('hex')}`,
      notes: { studyvella_user_id: req.user.id, studyvella_product: 'upfront-15-months' },
    });
    if (!validId(order.id, 'order') || order.amount !== UPFRONT_AMOUNT_PAISE || order.currency !== 'INR') {
      throw new Error('Razorpay returned an invalid order.');
    }
    sql.insertUpfrontOrder.run(order.id, req.user.id, UPFRONT_AMOUNT_PAISE, 'INR', new Date().toISOString());
    res.json({ key: process.env.RAZORPAY_KEY_ID, orderId: order.id, amount: UPFRONT_AMOUNT_PAISE, currency: 'INR' });
  } catch (error) {
    console.error('Razorpay upfront checkout error:', error);
    sendError(res, 502, 'Could not open checkout. Please try again.');
  }
});

router.post('/upfront/verify', requireAuth, async (req, res) => {
  if (!configured()) return sendError(res, 503, 'Billing is unavailable.');
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  const saved = validId(orderId, 'order') && sql.upfrontOrder.get(orderId);
  if (!saved || saved.user_id !== req.user.id || !validId(paymentId, 'pay') ||
      !verifySignature(`${saved.order_id}|${paymentId}`, signature, process.env.RAZORPAY_KEY_SECRET)) {
    return sendError(res, 400, 'Payment verification failed.');
  }
  try {
    const access = await confirmUpfrontPayment(orderId, paymentId);
    res.json(access);
  } catch (error) {
    console.error('Razorpay upfront verification error:', error);
    sendError(res, 502, 'Could not confirm the payment yet. Please check again shortly.');
  }
});

router.post('/verify', requireAuth, async (req, res) => {
  if (!configured()) return sendError(res, 503, 'Billing is unavailable.');
  const { razorpay_payment_id: paymentId, razorpay_subscription_id: subscriptionId, razorpay_signature: signature } = req.body || {};
  if (subscriptionId !== req.user.razorpay_subscription_id ||
      !verifyCheckoutSignature(paymentId, subscriptionId, signature)) {
    return sendError(res, 400, 'Payment verification failed.');
  }
  try {
    const subscription = await fetchSubscription(subscriptionId);
    const plan = applySubscription(subscription, req.user);
    res.json({ status: subscription.status, plan });
  } catch (error) {
    console.error('Razorpay verification error:', error);
    sendError(res, 502, 'Could not confirm the subscription yet. Please try again.');
  }
});

router.get('/status', requireAuth, async (req, res) => {
  if (!req.user.razorpay_subscription_id) return res.json({ status: 'none', plan: req.user.plan, upfrontExpiresAt: req.user.upfront_expires_at });
  if (!configured()) return sendError(res, 503, 'Billing status is unavailable.');
  try {
    const subscription = await fetchSubscription(req.user.razorpay_subscription_id);
    const plan = applySubscription(subscription, req.user);
    res.json({
      status: subscription.status, plan, upfrontExpiresAt: req.user.upfront_expires_at,
      currentEnd: subscription.current_end || null,
      cancelScheduled: Boolean(req.user.razorpay_cancel_requested_at && subscription.status === 'active'),
    });
  } catch (error) {
    console.error('Razorpay status error:', error);
    sendError(res, 502, 'Could not check billing status.');
  }
});

router.post('/cancel', requireAuth, async (req, res) => {
  if (!configured() || !req.user.razorpay_subscription_id) return sendError(res, 503, 'Billing is unavailable.');
  try {
    const current = await fetchSubscription(req.user.razorpay_subscription_id);
    if (current.notes?.studyvella_user_id && current.notes.studyvella_user_id !== req.user.id) {
      return sendError(res, 403, 'Subscription does not belong to this account.');
    }
    if (current.status !== 'active') return sendError(res, 409, 'Only an active subscription can be scheduled for cancellation.');
    if (current.has_scheduled_changes || req.user.razorpay_cancel_requested_at) {
      return sendError(res, 409, 'This subscription already has a scheduled change.');
    }
    const cancelled = await razorpayApi(`subscriptions/${current.id}/cancel`, { cancel_at_cycle_end: true });
    if (cancelled.id !== current.id) throw new Error('Razorpay returned a different subscription.');
    const plan = applySubscription(cancelled, req.user);
    db.prepare('UPDATE users SET razorpay_cancel_requested_at = ? WHERE id = ?')
      .run(new Date().toISOString(), req.user.id);
    res.json({ status: cancelled.status, plan, cancelScheduled: true, currentEnd: cancelled.current_end || null });
  } catch (error) {
    console.error('Razorpay cancellation error:', error);
    sendError(res, 502, 'Could not schedule cancellation. Please try again.');
  }
});

module.exports = { router, configured, proPrice, verifySignature, PRO_LABEL, UPFRONT_LABEL, addMonthsClamped };
