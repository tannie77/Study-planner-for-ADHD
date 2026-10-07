const crypto = require('node:crypto');
const express = require('express');
const { sql, publicTask } = require('./db');
const { requireAuth, sendError, FREE_TASK_LIMIT } = require('./auth');

const router = express.Router();
router.use(requireAuth);

function validDate(value) {
  if (value === null || value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validateTask(body, previous) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Invalid task.' };
  const allowed = ['title', 'description', 'dueDate', 'priority', 'project', 'completed'];
  if (!Object.keys(body).length || Object.keys(body).some(key => !allowed.includes(key))) return { error: 'Invalid task fields.' };
  const task = {
    title: previous?.title || '', description: previous?.description || '',
    dueDate: previous?.due_date ?? null, priority: previous?.priority || 'medium',
    project: previous?.project || 'General', completed: Boolean(previous?.completed),
  };
  for (const key of Object.keys(body)) {
    if (['title', 'description', 'project'].includes(key)) {
      if (typeof body[key] !== 'string') return { error: `${key} must be text.` };
      task[key] = body[key].trim();
    } else if (key === 'dueDate') task.dueDate = body[key];
    else task[key] = body[key];
  }
  if (!task.title || task.title.length > 160) return { error: 'Task title must be 1–160 characters.' };
  if (task.description.length > 2000) return { error: 'Description must be 2,000 characters or fewer.' };
  if (!task.project || task.project.length > 40) return { error: 'Subject must be 1–40 characters.' };
  if (!validDate(task.dueDate)) return { error: 'Choose a valid due date.' };
  if (!['low', 'medium', 'high'].includes(task.priority)) return { error: 'Choose a valid priority.' };
  if (typeof task.completed !== 'boolean') return { error: 'Completed must be true or false.' };
  return { task };
}

router.get('/', (req, res) => res.json({ tasks: sql.tasks.all(req.user.id).map(publicTask) }));

router.post('/', (req, res) => {
  if (req.body && Object.hasOwn(req.body, 'completed')) return sendError(res, 400, 'New tasks start incomplete.');
  const { task, error } = validateTask(req.body);
  if (error) return sendError(res, 400, error);
  if (req.user.plan === 'free' && sql.activeCount.get(req.user.id).count >= FREE_TASK_LIMIT) {
    return sendError(res, 403, `Free accounts can keep up to ${FREE_TASK_LIMIT} active tasks.`, 'plan_limit');
  }
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  sql.insertTask.run(id, req.user.id, task.title, task.description, task.dueDate || null, task.priority, task.project, timestamp, timestamp);
  res.status(201).json({ task: publicTask(sql.task.get(id, req.user.id)) });
});

router.patch('/:id', (req, res) => {
  const previous = sql.task.get(req.params.id, req.user.id);
  if (!previous) return sendError(res, 404, 'Task not found.');
  const { task, error } = validateTask(req.body, previous);
  if (error) return sendError(res, 400, error);
  if (req.user.plan === 'free' && previous.completed && !task.completed && sql.activeCount.get(req.user.id).count >= FREE_TASK_LIMIT) {
    return sendError(res, 403, `Free accounts can keep up to ${FREE_TASK_LIMIT} active tasks.`, 'plan_limit');
  }
  const completedAt = task.completed ? (previous.completed_at || new Date().toISOString()) : null;
  sql.updateTask.run(task.title, task.description, task.dueDate || null, task.priority, task.project, Number(task.completed), completedAt, new Date().toISOString(), req.params.id, req.user.id);
  res.json({ task: publicTask(sql.task.get(req.params.id, req.user.id)) });
});

router.delete('/:id', (req, res) => {
  const result = sql.deleteTask.run(req.params.id, req.user.id);
  if (!result.changes) return sendError(res, 404, 'Task not found.');
  res.json({ ok: true });
});

module.exports = { router, validateTask };
