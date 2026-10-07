const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');
const { db, sql, effectivePlan } = require('./db');

const router = express.Router();
const scrypt = promisify(crypto.scrypt);
const SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FREE_TASK_LIMIT = 60;
const RESET_AGE_MS = 60 * 60 * 1000;
const RESET_COOLDOWN_MS = 60 * 1000;
const attempts = new Map();

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const publicUser = user => ({
  id: user.id, name: user.name, email: user.email, plan: effectivePlan(user),
  freeTaskLimit: FREE_TASK_LIMIT,
  hasBilling: require('./billing').configured(),
  hasSubscription: Boolean(user.razorpay_subscription_id),
  upfrontExpiresAt: user.upfront_expires_at,
});
const sendError = (res, status, error, code) => res.status(status).json({ error, ...(code ? { code } : {}) });

function readCookie(req, name) {
  const pair = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return pair ? pair.slice(name.length + 1) : null;
}

function issueSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sql.insertSession.run(hashToken(token), userId, Date.now() + SESSION_AGE_MS);
  res.cookie('studyvella_session', token, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict',
    path: '/', maxAge: SESSION_AGE_MS,
  });
}

function requireAuth(req, res, next) {
  const token = readCookie(req, 'studyvella_session');
  const user = token && sql.userBySession.get(hashToken(token), Date.now());
  if (!user) return sendError(res, 401, 'Please sign in to continue.');
  const plan = effectivePlan(user);
  if (user.plan !== plan) db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, user.id);
  user.plan = plan;
  req.user = user;
  next();
}

function rateLimit(req, res, next) {
  const key = `${req.ip}:${req.path}`;
  const current = attempts.get(key) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
  if (current.until < Date.now()) { current.count = 0; current.until = Date.now() + 15 * 60 * 1000; }
  current.count += 1;
  attempts.set(key, current);
  if (current.count > 20) return sendError(res, 429, 'Too many attempts. Please try again later.');
  next();
}

function passwordResetConfigured() {
  const { APP_URL, RESEND_API_KEY, RESEND_FROM_EMAIL } = process.env;
  if (!RESEND_API_KEY || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(RESEND_FROM_EMAIL || '')) return false;
  try {
    const url = new URL(APP_URL);
    return url.origin === APP_URL && (url.protocol === 'https:' ||
      (process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
  } catch { return false; }
}

async function sendPasswordReset(email, token) {
  const resetUrl = new URL('/reset-password', process.env.APP_URL);
  resetUrl.searchParams.set('token', token);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL, to: [email],
      subject: 'Reset your Studyvella password',
      text: `Open this link to choose a new Studyvella password. It expires in one hour.\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
    }),
  });
  if (!response.ok) throw new Error(`Email service returned ${response.status}.`);
}

router.post('/register', rateLimit, async (req, res, next) => {
  try {
    const { name, email, password } = req.body || {};
    const cleanName = typeof name === 'string' ? name.trim() : '';
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!cleanName || cleanName.length > 80) return sendError(res, 400, 'Name must be 1–80 characters.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) return sendError(res, 400, 'Enter a valid email address.');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) return sendError(res, 400, 'Password must be 8–128 characters.');
    if (sql.userByEmail.get(cleanEmail)) return sendError(res, 409, 'An account with this email already exists.');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt, 64)).toString('hex');
    const id = crypto.randomUUID();
    sql.insertUser.run(id, cleanName, cleanEmail, hash, salt, new Date().toISOString());
    issueSession(res, id);
    res.status(201).json({ user: publicUser(sql.userById.get(id)) });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendError(res, 409, 'An account with this email already exists.');
    next(error);
  }
});

router.post('/login', rateLimit, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body?.password;
    const user = sql.userByEmail.get(email);
    if (!user || typeof password !== 'string') return sendError(res, 401, 'Invalid email or password.');
    const hash = await scrypt(password, user.password_salt, 64);
    if (!crypto.timingSafeEqual(hash, Buffer.from(user.password_hash, 'hex'))) return sendError(res, 401, 'Invalid email or password.');
    issueSession(res, user.id);
    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

router.post('/forgot-password', rateLimit, async (req, res) => {
  if (!passwordResetConfigured()) return sendError(res, 503, 'Password recovery is being set up. Please contact support.');
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return sendError(res, 400, 'Enter a valid email address.');
  }
  const generic = 'If an account exists for that email, a reset link is on its way.';
  const user = sql.userByEmail.get(email);
  if (!user || (sql.recentPasswordReset.get(user.id)?.created_at || 0) > Date.now() - RESET_COOLDOWN_MS) {
    return res.json({ message: generic });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  sql.deleteUserPasswordResets.run(user.id);
  sql.insertPasswordReset.run(tokenHash, user.id, Date.now() + RESET_AGE_MS, Date.now());
  try {
    await sendPasswordReset(user.email, token);
  } catch (error) {
    sql.deletePasswordReset.run(tokenHash);
    console.error('Password reset email error:', error.message);
  }
  return res.json({ message: generic });
});

router.post('/reset-password', rateLimit, async (req, res, next) => {
  const token = req.body?.token;
  const password = req.body?.password;
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) ||
      typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return sendError(res, 400, 'Enter a valid reset link and an 8–128 character password.');
  }
  const tokenHash = hashToken(token);
  const reset = sql.passwordResetByHash.get(tokenHash, Date.now());
  if (!reset) return sendError(res, 400, 'This reset link is invalid or has expired. Request a new one.');
  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt, 64)).toString('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const stillValid = sql.passwordResetByHash.get(tokenHash, Date.now());
      if (!stillValid) {
        db.exec('ROLLBACK');
        return sendError(res, 400, 'This reset link is invalid or has expired. Request a new one.');
      }
      sql.updatePassword.run(hash, salt, reset.user_id);
      sql.deleteUserSessions.run(reset.user_id);
      sql.deleteUserPasswordResets.run(reset.user_id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.clearCookie('studyvella_session', { path: '/' });
    res.json({ message: 'Password updated. Log in with your new password.' });
  } catch (error) { next(error); }
});

router.post('/logout', (req, res) => {
  const token = readCookie(req, 'studyvella_session');
  if (token) sql.deleteSession.run(hashToken(token));
  res.clearCookie('studyvella_session', { path: '/' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

module.exports = { router, requireAuth, publicUser, sendError, passwordResetConfigured, FREE_TASK_LIMIT };
