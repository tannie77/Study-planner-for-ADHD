const crypto = require('node:crypto');
const express = require('express');
const { sql } = require('./db');
const { requireAuth, sendError } = require('./auth');

const router = express.Router();
router.use(requireAuth);

router.get('/sessions', (req, res) => res.json({ sessions: sql.studySessions.all(req.user.id) }));

router.get('/insights', (req, res) => {
  if (req.user.plan !== 'pro') return sendError(res, 403, 'Study insights are a Pro feature.', 'plan_limit');
  const today = req.query.today;
  const parsed = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today) ? new Date(`${today}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== today) return sendError(res, 400, 'Choose a valid date.');
  const dates = Array.from({ length: 7 }, (_, index) => new Date(parsed.valueOf() - (6 - index) * 86400000).toISOString().slice(0, 10));
  const rows = sql.studySessionsRange.all(req.user.id, dates[0], today);
  const daily = dates.map(date => ({ date, minutes: rows.filter(session => session.localDate === date).reduce((sum, session) => sum + session.minutes, 0) }));
  const subjectTotals = new Map();
  rows.forEach(session => subjectTotals.set(session.subject, (subjectTotals.get(session.subject) || 0) + session.minutes));
  const subjects = [...subjectTotals].map(([subject, minutes]) => ({ subject, minutes })).sort((a, b) => b.minutes - a.minutes);
  res.json({ daily, subjects, totalMinutes: rows.reduce((sum, session) => sum + session.minutes, 0), sessionCount: rows.length });
});

router.post('/sessions', (req, res) => {
  const { subject, minutes, localDate } = req.body || {};
  const cleanSubject = typeof subject === 'string' ? subject.trim() : '';
  const parsedDate = typeof localDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(localDate) ? new Date(`${localDate}T00:00:00Z`) : null;
  if (!cleanSubject || cleanSubject.length > 40) return sendError(res, 400, 'Choose a subject.');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) return sendError(res, 400, 'Study session must be 1–180 minutes.');
  if (!parsedDate || Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== localDate) return sendError(res, 400, 'Choose a valid date.');
  const id = crypto.randomUUID();
  sql.insertStudySession.run(id, req.user.id, cleanSubject, minutes, localDate, new Date().toISOString());
  res.status(201).json({ session: sql.studySessions.all(req.user.id).find(session => session.id === id) });
});

module.exports = router;
