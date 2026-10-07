const crypto = require('node:crypto');
const express = require('express');
const { sql, publicTomorrowTest } = require('./db');
const { requireAuth, sendError } = require('./auth');

const router = express.Router();
router.use(requireAuth);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function nextDay(value) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

router.get('/', (req, res) => {
  res.json({ tests: sql.tomorrowTests.all(req.user.id).map(publicTomorrowTest) });
});

router.post('/', (req, res) => {
  const { subject, question, initialThought = '', localDate } = req.body || {};
  const cleanSubject = typeof subject === 'string' ? subject.trim() : '';
  const cleanQuestion = typeof question === 'string' ? question.trim() : '';
  const cleanThought = typeof initialThought === 'string' ? initialThought.trim() : null;
  if (!cleanSubject || cleanSubject.length > 40) return sendError(res, 400, 'Choose a subject (up to 40 characters).');
  if (!cleanQuestion || cleanQuestion.length > 200) return sendError(res, 400, 'Write a question (up to 200 characters).');
  if (cleanThought === null || cleanThought.length > 500) return sendError(res, 400, 'Your current thought must be under 500 characters.');
  if (!validDate(localDate)) return sendError(res, 400, 'Choose a valid date.');
  const id = crypto.randomUUID();
  sql.insertTomorrowTest.run(id, req.user.id, cleanSubject, cleanQuestion, cleanThought, nextDay(localDate), new Date().toISOString());
  res.status(201).json({ test: publicTomorrowTest(sql.tomorrowTest.get(id, req.user.id)) });
});

router.post('/:id/review', (req, res) => {
  const test = sql.tomorrowTest.get(req.params.id, req.user.id);
  if (!test) return sendError(res, 404, 'Question not found.');
  if (test.status !== 'open') return sendError(res, 409, 'This question is already clear.');
  const { answer, outcome, localDate } = req.body || {};
  const cleanAnswer = typeof answer === 'string' ? answer.trim() : '';
  if (!validDate(localDate)) return sendError(res, 400, 'Choose a valid date.');
  if (localDate < test.review_on) return sendError(res, 409, 'This question is ready tomorrow.');
  if (!cleanAnswer || cleanAnswer.length > 1000) return sendError(res, 400, 'Write your answer from memory first (up to 1000 characters).');
  if (!['clear', 'again'].includes(outcome)) return sendError(res, 400, 'Choose whether to review this again.');
  const now = new Date().toISOString();
  sql.reviewTomorrowTest.run(outcome === 'clear' ? 'clear' : 'open', outcome === 'clear' ? test.review_on : nextDay(localDate), cleanAnswer, now, outcome === 'clear' ? now : null, test.id, req.user.id);
  res.json({ test: publicTomorrowTest(sql.tomorrowTest.get(test.id, req.user.id)) });
});

router.delete('/:id', (req, res) => {
  if (!sql.deleteTomorrowTest.run(req.params.id, req.user.id).changes) return sendError(res, 404, 'Question not found.');
  res.status(204).end();
});

module.exports = router;
