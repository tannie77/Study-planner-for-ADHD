const crypto = require('node:crypto');
const express = require('express');
const { sql } = require('./db');
const { requireAuth, sendError } = require('./auth');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => req.user.tier === 'pro-plus'
  ? next() : sendError(res, 403, 'Exam Runway is a Pro Plus feature.', 'plan_limit'));

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function publicExam(exam) {
  return { id: exam.id, title: exam.title, subject: exam.subject, examDate: exam.exam_date };
}

function weekSummary(user, today) {
  const date = new Date(`${today}T00:00:00Z`);
  const monday = new Date(date.valueOf() - ((date.getUTCDay() + 6) % 7) * 86400000);
  const sunday = new Date(monday.valueOf() + 6 * 86400000);
  const weekStart = monday.toISOString().slice(0, 10);
  const weekEnd = sunday.toISOString().slice(0, 10);
  const minutesDone = sql.studySessionsRange.all(user.id, weekStart, weekEnd)
    .reduce((sum, session) => sum + session.minutes, 0);
  return { minutesTarget: user.weekly_goal_minutes, minutesDone, weekStart, weekEnd };
}

router.get('/', (req, res) => {
  const today = req.query.today;
  if (!validDate(today)) return sendError(res, 400, 'Choose a valid date.');
  res.json({ exams: sql.exams.all(req.user.id).map(publicExam), goal: weekSummary(req.user, today) });
});

router.put('/goal', (req, res) => {
  const minutes = req.body?.minutes;
  if (!Number.isInteger(minutes) || minutes < 60 || minutes > 3000) {
    return sendError(res, 400, 'Choose a weekly goal between 60 and 3,000 minutes.');
  }
  sql.updateWeeklyGoal.run(minutes, req.user.id);
  res.json({ minutesTarget: minutes });
});

function examFields(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
  const examDate = body?.examDate;
  if (!title || title.length > 120) return { error: 'Name the exam (up to 120 characters).' };
  if (!subject || subject.length > 40) return { error: 'Choose a subject (up to 40 characters).' };
  if (!validDate(examDate)) return { error: 'Choose a valid exam date.' };
  return { title, subject, examDate };
}

router.post('/exams', (req, res) => {
  const fields = examFields(req.body);
  if (fields.error) return sendError(res, 400, fields.error);
  if (sql.examCount.get(req.user.id).count >= 30) return sendError(res, 403, 'Keep up to 30 exams in your runway.');
  const id = crypto.randomUUID();
  sql.insertExam.run(id, req.user.id, fields.title, fields.subject, fields.examDate, new Date().toISOString());
  res.status(201).json({ exam: publicExam(sql.exam.get(id, req.user.id)) });
});

router.patch('/exams/:id', (req, res) => {
  const fields = examFields(req.body);
  if (fields.error) return sendError(res, 400, fields.error);
  if (!sql.updateExam.run(fields.title, fields.subject, fields.examDate, req.params.id, req.user.id).changes) {
    return sendError(res, 404, 'Exam not found.');
  }
  res.json({ exam: publicExam(sql.exam.get(req.params.id, req.user.id)) });
});

router.delete('/exams/:id', (req, res) => {
  if (!sql.deleteExam.run(req.params.id, req.user.id).changes) return sendError(res, 404, 'Exam not found.');
  res.status(204).end();
});

module.exports = router;
