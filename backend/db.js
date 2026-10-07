const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'studyvella.sqlite');
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    monthly_active INTEGER NOT NULL DEFAULT 0,
    upfront_expires_at TEXT,
    razorpay_customer_id TEXT,
    razorpay_subscription_id TEXT,
    razorpay_cancel_requested_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id, created_at);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    due_date TEXT,
    priority TEXT NOT NULL DEFAULT 'medium',
    project TEXT NOT NULL DEFAULT 'Inbox',
    completed INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_user_due ON tasks(user_id, due_date, completed);
  CREATE TABLE IF NOT EXISTS razorpay_events (id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS upfront_orders (
    order_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    payment_id TEXT UNIQUE,
    paid_at TEXT,
    expires_at TEXT,
    refunded_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS upfront_orders_user ON upfront_orders(user_id, expires_at);
  CREATE TABLE IF NOT EXISTS study_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    local_date TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS study_sessions_user_date ON study_sessions(user_id, local_date);
  CREATE TABLE IF NOT EXISTS tomorrow_tests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    question TEXT NOT NULL,
    initial_thought TEXT NOT NULL DEFAULT '',
    review_on TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'clear')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_answer TEXT,
    last_reviewed_at TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS tomorrow_tests_user_review ON tomorrow_tests(user_id, status, review_on);
`);

// Existing local databases were created before the Razorpay switch.
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
if (!userColumns.has('razorpay_customer_id')) db.exec('ALTER TABLE users ADD COLUMN razorpay_customer_id TEXT');
if (!userColumns.has('razorpay_subscription_id')) db.exec('ALTER TABLE users ADD COLUMN razorpay_subscription_id TEXT');
if (!userColumns.has('razorpay_cancel_requested_at')) db.exec('ALTER TABLE users ADD COLUMN razorpay_cancel_requested_at TEXT');
if (!userColumns.has('monthly_active')) {
  db.exec('ALTER TABLE users ADD COLUMN monthly_active INTEGER NOT NULL DEFAULT 0');
  db.exec("UPDATE users SET monthly_active = 1 WHERE plan = 'pro' AND razorpay_subscription_id IS NOT NULL");
}
if (!userColumns.has('upfront_expires_at')) db.exec('ALTER TABLE users ADD COLUMN upfront_expires_at TEXT');

const effectivePlan = user => user.monthly_active ||
  (user.upfront_expires_at && Date.parse(user.upfront_expires_at) > Date.now()) ? 'pro' : 'free';

const sql = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userBySession: db.prepare('SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?'),
  insertUser: db.prepare('INSERT INTO users (id, name, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  passwordResetByHash: db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND expires_at > ?'),
  recentPasswordReset: db.prepare('SELECT created_at FROM password_resets WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'),
  insertPasswordReset: db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'),
  deletePasswordReset: db.prepare('DELETE FROM password_resets WHERE token_hash = ?'),
  deleteUserPasswordResets: db.prepare('DELETE FROM password_resets WHERE user_id = ?'),
  updatePassword: db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?'),
  tasks: db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY completed ASC, due_date IS NULL, due_date ASC, created_at DESC'),
  task: db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?'),
  activeCount: db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE user_id = ? AND completed = 0'),
  insertTask: db.prepare('INSERT INTO tasks (id, user_id, title, description, due_date, priority, project, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  updateTask: db.prepare('UPDATE tasks SET title = ?, description = ?, due_date = ?, priority = ?, project = ?, completed = ?, completed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?'),
  razorpayEvent: db.prepare('SELECT id FROM razorpay_events WHERE id = ?'),
  insertRazorpayEvent: db.prepare('INSERT INTO razorpay_events (id, received_at) VALUES (?, ?)'),
  upfrontOrder: db.prepare('SELECT * FROM upfront_orders WHERE order_id = ?'),
  pendingUpfrontOrder: db.prepare('SELECT * FROM upfront_orders WHERE user_id = ? AND paid_at IS NULL AND refunded_at IS NULL ORDER BY created_at DESC LIMIT 1'),
  insertUpfrontOrder: db.prepare('INSERT INTO upfront_orders (order_id, user_id, amount, currency, created_at) VALUES (?, ?, ?, ?, ?)'),
  latestUpfrontExpiry: db.prepare('SELECT MAX(expires_at) AS expires_at FROM upfront_orders WHERE user_id = ? AND paid_at IS NOT NULL AND refunded_at IS NULL'),
  studySessions: db.prepare('SELECT id, subject, minutes, local_date AS localDate, created_at AS createdAt FROM study_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 500'),
  studySessionsRange: db.prepare('SELECT subject, minutes, local_date AS localDate FROM study_sessions WHERE user_id = ? AND local_date BETWEEN ? AND ?'),
  insertStudySession: db.prepare('INSERT INTO study_sessions (id, user_id, subject, minutes, local_date, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  tomorrowTests: db.prepare('SELECT * FROM tomorrow_tests WHERE user_id = ? ORDER BY status ASC, review_on ASC, created_at DESC'),
  tomorrowTest: db.prepare('SELECT * FROM tomorrow_tests WHERE id = ? AND user_id = ?'),
  insertTomorrowTest: db.prepare('INSERT INTO tomorrow_tests (id, user_id, subject, question, initial_thought, review_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  reviewTomorrowTest: db.prepare('UPDATE tomorrow_tests SET status = ?, review_on = ?, attempts = attempts + 1, last_answer = ?, last_reviewed_at = ?, resolved_at = ? WHERE id = ? AND user_id = ?'),
  deleteTomorrowTest: db.prepare('DELETE FROM tomorrow_tests WHERE id = ? AND user_id = ?'),
};

const publicTask = task => ({
  id: task.id, title: task.title, description: task.description, dueDate: task.due_date,
  priority: task.priority, project: task.project, completed: Boolean(task.completed),
  completedAt: task.completed_at, createdAt: task.created_at, updatedAt: task.updated_at,
});

const publicTomorrowTest = test => ({
  id: test.id, subject: test.subject, question: test.question,
  initialThought: test.initial_thought, reviewOn: test.review_on,
  status: test.status, attempts: test.attempts, lastAnswer: test.last_answer,
  lastReviewedAt: test.last_reviewed_at, createdAt: test.created_at, resolvedAt: test.resolved_at,
});

module.exports = { db, sql, effectivePlan, publicTask, publicTomorrowTest };
