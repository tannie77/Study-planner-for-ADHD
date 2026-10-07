const $ = selector => document.querySelector(selector);
const state = {
  user: null, config: null, tasks: [], sessions: [], tests: [], insights: null, view: 'today',
  subject: null, status: 'open', search: '', authMode: 'register',
  timerMinutes: 25, remaining: 25 * 60, timerEnd: null, timerInterval: null,
};

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const prettyDate = date => date ? new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'No due date';
const titleCase = text => text.charAt(0).toUpperCase() + text.slice(1);

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      credentials: 'same-origin',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
  } catch {
    throw new Error('Could not reach the server. Please check your connection.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong.');
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

let toastTimeout;
function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { element.hidden = true; }, 5000);
}

function showScreen(name) {
  $('#landing-view').hidden = name !== 'landing';
  $('#auth-view').hidden = name !== 'auth';
  $('#app-view').hidden = name !== 'app';
  const banner = $('#affirmation-banner');
  if (name === 'landing') $('#landing-view main').prepend(banner);
  if (name === 'app') $('.dashboard-wrap').prepend(banner);
  if (name === 'landing') document.title = 'Studyvella — a lot to do, a clear way through';
  if (name === 'app') document.title = 'Your study space — Studyvella';
  window.scrollTo(0, 0);
}

function showAuth(mode) {
  state.authMode = mode;
  $('#auth-heading').textContent = ({ register: 'Create your account', login: 'Welcome back', forgot: 'Reset your password', reset: 'Choose a new password' })[mode];
  $('#auth-subheading').textContent = mode === 'register' ? 'A lot to do. A clear way through.' : mode === 'forgot' ? 'We’ll email a private reset link if this account exists.' : mode === 'reset' ? 'Make it something only you know.' : 'Your plan is ready when you are.';
  $('#name-field').hidden = mode !== 'register';
  $('#email-field').hidden = mode === 'reset';
  $('#password-field').hidden = mode === 'forgot';
  $('#auth-form [name=name]').required = mode === 'register';
  $('#auth-form [name=email]').required = mode !== 'reset';
  $('#auth-form [name=password]').required = mode !== 'forgot';
  $('#auth-form [name=password]').autocomplete = mode === 'register' || mode === 'reset' ? 'new-password' : 'current-password';
  $('#auth-submit').textContent = ({ register: 'Create free account', login: 'Log in', forgot: 'Email reset link', reset: 'Save new password' })[mode];
  $('#auth-switch').innerHTML = ({
    register: 'Already have an account? <button class="inline-button" data-auth="login">Log in</button>',
    login: '<button class="inline-button" data-auth="forgot">Forgot password?</button> · New here? <button class="inline-button" data-auth="register">Create an account</button>',
    forgot: '<button class="inline-button" data-auth="login">Back to log in</button>',
    reset: '<button class="inline-button" data-auth="forgot">Request another link</button>',
  })[mode];
  $('#auth-form').reset();
  showScreen('auth');
  $('#auth-form [name=' + (mode === 'reset' ? 'password' : 'email') + ']').focus();
}

async function loadData() {
  const [tasks, sessions, tests] = await Promise.all([api('/tasks'), api('/study/sessions'), api('/tomorrow-tests')]);
  state.tasks = tasks.tasks;
  state.sessions = sessions.sessions;
  state.tests = tests.tests;
  render();
}

async function enterApp(user) {
  state.user = user;
  showScreen('app');
  $('#profile-name').textContent = user.name;
  $('#avatar').textContent = user.name.charAt(0).toUpperCase();
  await loadData();
}

function subjects() {
  return [...new Set(['General', ...state.tasks.map(task => task.project).filter(Boolean), ...state.tests.map(test => test.subject).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
}

function renderSubjects() {
  $('#subject-nav').innerHTML = subjects().map((subject, index) => `<button class="subject-link ${state.subject === subject ? 'active' : ''}" data-subject="${escapeHtml(subject)}"><span class="subject-dot"></span>${escapeHtml(subject)}</button>`).join('');
  $('#subject-options').innerHTML = subjects().map(subject => `<option value="${escapeHtml(subject)}"></option>`).join('');
  const selected = $('#timer-subject').value;
  $('#timer-subject').innerHTML = subjects().map(subject => `<option value="${escapeHtml(subject)}">${escapeHtml(subject)}</option>`).join('');
  $('#timer-subject').value = subjects().includes(selected) ? selected : 'General';
}

function filteredTasks() {
  const today = localDate();
  let tasks = state.tasks.filter(task => {
    if (state.subject) return task.project === state.subject;
    if (state.view === 'today') return !task.dueDate || task.dueDate <= today;
    if (state.view === 'upcoming') return Boolean(task.dueDate && task.dueDate > today);
    if (state.view === 'completed') return task.completed;
    return true;
  });
  if (state.status === 'open') tasks = tasks.filter(task => !task.completed);
  else if (state.status === 'done') tasks = tasks.filter(task => task.completed);
  const search = state.search.trim().toLowerCase();
  if (search) tasks = tasks.filter(task => `${task.title} ${task.description} ${task.project}`.toLowerCase().includes(search));
  return tasks;
}

function renderTasks() {
  const tasks = filteredTasks();
  $('#task-count').textContent = tasks.length;
  if (!tasks.length) {
    const searching = state.search.trim();
    $('#task-list').innerHTML = `<div class="empty-state"><span class="empty-icon">✦</span><strong>${searching ? 'Nothing matches that search' : state.status === 'done' ? 'No completed tasks yet' : 'Your next move starts here'}</strong><p>${searching ? 'Try another word or subject.' : state.status === 'done' ? 'Every finished task will show up here.' : 'Add the first task. Keep the plan clear.'}</p>${searching || state.status === 'done' ? '' : '<button class="button button-outline" id="empty-add-task">+ Add a task</button>'}</div>`;
    return;
  }
  const today = localDate();
  $('#task-list').innerHTML = tasks.map(task => {
    const dueLabel = task.dueDate ? task.dueDate === today ? 'Due today' : task.dueDate < today && !task.completed ? 'Overdue · ' + prettyDate(task.dueDate) : prettyDate(task.dueDate) : 'Anytime';
    return `<article class="task-item ${task.completed ? 'done' : ''}"><button class="task-checkbox" data-action="toggle" data-id="${task.id}" aria-label="${task.completed ? 'Mark incomplete' : 'Mark complete'}">${task.completed ? '✓' : ''}</button><div class="task-content"><strong class="task-title">${escapeHtml(task.title)}</strong>${task.description ? `<p class="task-description">${escapeHtml(task.description)}</p>` : ''}<div class="task-meta"><span class="meta-subject">${escapeHtml(task.project)}</span><span class="${task.dueDate < today && !task.completed ? 'due-overdue' : ''}">▦ ${escapeHtml(dueLabel)}</span><span class="priority-${task.priority}">● ${titleCase(task.priority)}</span></div></div><div class="task-actions"><button data-action="edit" data-id="${task.id}" aria-label="Edit task" title="Edit task">✎</button><button data-action="delete" data-id="${task.id}" aria-label="Delete task" title="Delete task">×</button></div></article>`;
  }).join('');
}

function renderHeader() {
  const now = new Date();
  $('#date-label').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
  const copy = state.subject ? [state.subject, 'Every move for this subject, in one place.'] : ({
    today: ['A lot to do. You have a plan.', 'Start with the next move.'],
    upcoming: ['Stay ahead. Stay clear.', 'See what’s next before it becomes urgent.'],
    all: ['The whole agenda.', 'Every task, one clear view.'],
    completed: ['Done. And then some.', 'See the work you’ve already handled.'],
    insights: ['Your work, in numbers.', 'See where your focus went this week.'],
    tomorrow: ['Make the work stick.', 'Answer from memory. Keep what needs another look.'],
  })[state.view];
  $('#view-title').textContent = copy[0];
  $('#view-description').textContent = copy[1];
  $('#task-list-title').firstChild.textContent = state.subject ? `${state.subject} tasks ` : ({ today: 'Today’s tasks ', upcoming: 'Upcoming tasks ', all: 'All tasks ', completed: 'Completed tasks ', insights: 'All tasks ', tomorrow: 'All tasks ' })[state.view];
  $('#new-task-button').hidden = state.view === 'tomorrow' && !state.subject;
  document.querySelectorAll('.side-link').forEach(button => button.classList.toggle('active', !state.subject && button.dataset.view === state.view));
}

function renderStats() {
  const today = localDate();
  const doneToday = state.tasks.filter(task => task.completedAt && localDate(new Date(task.completedAt)) === today).length;
  const focused = state.sessions.filter(session => session.localDate === today).reduce((total, session) => total + session.minutes, 0);
  const upcoming = state.tasks.filter(task => !task.completed && task.dueDate && task.dueDate >= today && task.dueDate <= localDate(new Date(Date.now() + 7 * 86400000))).length;
  $('#done-count').textContent = doneToday;
  $('#focus-count').textContent = `${focused} min`;
  $('#upcoming-count').textContent = upcoming;
  $('#profile-plan').textContent = state.user.plan === 'pro' ? 'Pro plan' : 'Free plan';
}

function render() {
  if (!state.user) return;
  renderSubjects(); renderHeader(); renderStats(); renderTasks(); renderTomorrow();
  $('#task-panel').hidden = ['insights', 'tomorrow'].includes(state.view) && !state.subject;
  $('#insights-panel').hidden = state.view !== 'insights' || Boolean(state.subject);
  $('#tomorrow-panel').hidden = state.view !== 'tomorrow' || Boolean(state.subject);
  if (state.view === 'insights') renderInsights();
  $('#status-filter').value = state.status;
}

function renderTomorrow() {
  const today = localDate();
  const open = state.tests.filter(test => test.status === 'open');
  const due = open.filter(test => test.reviewOn <= today);
  const waiting = open.filter(test => test.reviewOn > today);
  const clear = state.tests.filter(test => test.status === 'clear');
  $('#tomorrow-nav-count').hidden = due.length === 0;
  $('#tomorrow-nav-count').textContent = due.length;
  const card = (test, stage) => `<article class="tomorrow-card ${stage}"><div class="tomorrow-card-head"><span class="meta-subject">${escapeHtml(test.subject)}</span><span class="tomorrow-date">${stage === 'due' ? 'Ready now' : stage === 'waiting' ? `Ready ${escapeHtml(prettyDate(test.reviewOn))}` : 'Clear'}</span></div><h3>${escapeHtml(test.question)}</h3>${test.attempts ? `<p class="tomorrow-attempts">${test.attempts} ${test.attempts === 1 ? 'attempt' : 'attempts'}</p>` : ''}<div class="tomorrow-card-actions">${stage === 'due' ? `<button class="button button-dark button-small" data-test-action="review" data-id="${test.id}">Answer from memory</button>` : ''}<button class="quiet-button" data-test-action="delete" data-id="${test.id}" aria-label="Delete question">Delete</button></div></article>`;
  $('#tomorrow-list').innerHTML = state.tests.length
    ? `<div class="tomorrow-group"><h3>Ready to answer <span>${due.length}</span></h3>${due.length ? due.map(test => card(test, 'due')).join('') : '<p class="tomorrow-empty">No questions to answer today. Enjoy the breathing room.</p>'}</div><div class="tomorrow-group"><h3>Coming back tomorrow <span>${waiting.length}</span></h3>${waiting.length ? waiting.map(test => card(test, 'waiting')).join('') : '<p class="tomorrow-empty">Save a question after your next study session.</p>'}</div>${clear.length ? `<div class="tomorrow-group"><h3>Clear now <span>${clear.length}</span></h3>${clear.map(test => card(test, 'clear')).join('')}</div>` : ''}`
    : '<div class="empty-state"><span class="empty-icon">✳</span><strong>One question can change how you study.</strong><p>After a focus session, capture what still feels unclear. Tomorrow, answer it without your notes.</p><button class="button button-outline" id="empty-add-test">+ Save a question</button></div>';
}

function renderInsights() {
  if (!state.insights) {
    $('#insight-bars').innerHTML = '<p class="insight-empty">Loading your study insights…</p>';
    $('#insight-subjects').innerHTML = '';
    return;
  }
  const { daily, subjects, totalMinutes, sessionCount } = state.insights;
  $('#insight-total').textContent = `${totalMinutes} min`;
  $('#insight-sessions').textContent = sessionCount;
  const maxDay = Math.max(1, ...daily.map(day => day.minutes));
  $('#insight-bars').innerHTML = daily.map(day => `<div class="insight-row"><span>${escapeHtml(new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' }))}</span><progress value="${day.minutes}" max="${maxDay}"></progress><strong>${day.minutes}m</strong></div>`).join('');
  const maxSubject = Math.max(1, ...subjects.map(subject => subject.minutes));
  $('#insight-subjects').innerHTML = subjects.length
    ? subjects.map(subject => `<div class="insight-row subject"><span>${escapeHtml(subject.subject)}</span><progress value="${subject.minutes}" max="${maxSubject}"></progress><strong>${subject.minutes}m</strong></div>`).join('')
    : '<p class="insight-empty">Finish a focus session to see your subjects here.</p>';
}

async function selectView(view) {
  if (view === 'insights' && state.user.plan !== 'pro') return openPlan();
  if (view === 'insights') state.insights = null;
  state.view = view;
  state.subject = null;
  state.status = view === 'completed' ? 'done' : 'open';
  $('.sidebar').classList.remove('open');
  render();
  if (view === 'insights') {
    try {
      state.insights = (await api(`/study/insights?today=${localDate()}`));
      renderInsights();
    } catch (error) { toast(error.message, true); }
  }
}

function openTask(task = null, subject = null) {
  const dialog = $('#task-dialog');
  const form = $('#task-form');
  form.reset();
  dialog.dataset.id = task?.id || '';
  $('#task-dialog-title').textContent = task ? 'Edit task' : 'Add a task';
  $('#task-save').textContent = task ? 'Save changes' : 'Add task';
  form.elements.title.value = task?.title || '';
  form.elements.description.value = task?.description || '';
  form.elements.project.value = task?.project || subject || state.subject || 'General';
  form.elements.dueDate.value = task?.dueDate || (state.view === 'today' ? localDate() : '');
  form.elements.priority.value = task?.priority || 'medium';
  dialog.showModal();
  form.elements.title.focus();
}

async function saveTask(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = $('#task-dialog').dataset.id;
  const task = {
    title: form.elements.title.value.trim(), description: form.elements.description.value.trim(),
    project: form.elements.project.value.trim(), dueDate: form.elements.dueDate.value || null,
    priority: form.elements.priority.value,
  };
  const button = $('#task-save');
  button.disabled = true;
  try {
    const result = id
      ? await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(task) })
      : await api('/tasks', { method: 'POST', body: JSON.stringify(task) });
    state.tasks = id ? state.tasks.map(item => item.id === id ? result.task : item) : [result.task, ...state.tasks];
    $('#task-dialog').close();
    render();
    toast(id ? 'Task updated.' : 'Task added. Next move, handled.');
  } catch (error) {
    toast(error.message, true);
    if (error.code === 'plan_limit') $('#plan-dialog').showModal();
  } finally { button.disabled = false; }
}

function openTest(subject = null) {
  const form = $('#test-form');
  form.reset();
  form.elements.subject.value = subject || state.subject || $('#timer-subject').value || 'General';
  $('#test-dialog').showModal();
  form.elements.question.focus();
}

async function saveTest(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#test-save');
  button.disabled = true;
  try {
    const { test } = await api('/tomorrow-tests', { method: 'POST', body: JSON.stringify({
      subject: form.elements.subject.value.trim(),
      question: form.elements.question.value.trim(),
      initialThought: form.elements.initialThought.value.trim(),
      localDate: localDate(),
    }) });
    state.tests.unshift(test);
    $('#test-dialog').close();
    render();
    toast('Saved. Studyvella will ask you tomorrow.');
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}

function openReview(id) {
  const test = state.tests.find(item => item.id === id);
  if (!test || test.status !== 'open' || test.reviewOn > localDate()) return;
  const dialog = $('#review-dialog');
  dialog.dataset.id = id;
  $('#review-subject').textContent = test.subject;
  $('#review-question').textContent = test.question;
  $('#review-answer').value = '';
  $('#review-initial-thought').textContent = test.initialThought || 'You didn’t save an earlier thought. Compare your answer with your notes.';
  $('#review-reveal-row').hidden = false;
  $('#review-decision').hidden = true;
  dialog.showModal();
  $('#review-answer').focus();
}

async function reviewTest(outcome) {
  const id = $('#review-dialog').dataset.id;
  const buttons = $('#review-decision').querySelectorAll('button');
  buttons.forEach(button => { button.disabled = true; });
  try {
    const { test } = await api(`/tomorrow-tests/${id}/review`, { method: 'POST', body: JSON.stringify({
      answer: $('#review-answer').value.trim(), outcome, localDate: localDate(),
    }) });
    state.tests = state.tests.map(item => item.id === id ? test : item);
    $('#review-dialog').close();
    render();
    toast(outcome === 'clear' ? 'Marked clear. You explained it!' : 'Still fuzzy? You’ll see it again tomorrow.');
  } catch (error) { toast(error.message, true); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}

async function handleTestAction(button) {
  const id = button.dataset.id;
  if (button.dataset.testAction === 'review') return openReview(id);
  const test = state.tests.find(item => item.id === id);
  if (!test || !confirm(`Delete “${test.question}”?`)) return;
  try {
    await api(`/tomorrow-tests/${id}`, { method: 'DELETE' });
    state.tests = state.tests.filter(item => item.id !== id);
    render();
    toast('Question deleted.');
  } catch (error) { toast(error.message, true); }
}

async function handleTaskAction(button) {
  const task = state.tasks.find(item => item.id === button.dataset.id);
  if (!task) return;
  if (button.dataset.action === 'edit') return openTask(task);
  if (button.dataset.action === 'delete' && !confirm(`Delete “${task.title}”?`)) return;
  try {
    if (button.dataset.action === 'toggle') {
      const result = await api(`/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ completed: !task.completed }) });
      state.tasks = state.tasks.map(item => item.id === task.id ? result.task : item);
    } else if (button.dataset.action === 'delete') {
      await api(`/tasks/${task.id}`, { method: 'DELETE' });
      state.tasks = state.tasks.filter(item => item.id !== task.id);
      toast('Task deleted.');
    }
    render();
  } catch (error) { toast(error.message, true); }
}

function openPlan() {
  const pro = state.user.plan === 'pro';
  const enabled = state.user.hasBilling && (state.config?.billingEnabled || state.user.hasSubscription);
  $('#current-plan-copy').textContent = pro ? 'You’re on Pro. Keep planning without limits.' : `You’re on Free. You can keep up to ${state.user.freeTaskLimit} active tasks.`;
  $('#plan-price').textContent = state.config?.proPriceLabel || 'Pro billing is being set up.';
  $('#plan-action').textContent = pro || state.user.hasSubscription ? 'Check billing status' : 'Upgrade to Pro';
  $('#plan-action').disabled = !enabled;
  $('#plan-cancel').hidden = !pro || !enabled || !state.user.hasSubscription;
  $('#export-button').hidden = !pro;
  $('#plan-footnote').textContent = enabled ? 'Secure recurring payments are handled by Razorpay.' : 'The site owner needs to configure payments before upgrades are available.';
  $('#plan-dialog').showModal();
  if (enabled && state.user.hasSubscription) {
    api('/billing/status').then(status => {
      if (!$('#plan-dialog').open) return;
      $('#plan-footnote').textContent = billingStatusCopy(status);
      $('#plan-cancel').hidden = status.status !== 'active' || status.plan !== 'pro' || status.cancelScheduled;
      if (status.plan !== state.user.plan) refreshUser().catch(() => {});
    }).catch(() => {});
  }
}

function billingStatusCopy(status) {
  if (status.cancelScheduled) return 'Cancellation is scheduled. Pro stays active until the current billing period ends.';
  if (status.status === 'active' && status.plan === 'pro') return 'Your ₹299 monthly subscription is active.';
  if (status.status === 'active') return 'Your first payment is still being confirmed.';
  if (status.status === 'pending' || status.status === 'halted') return 'A payment needs attention. Check the message from Razorpay to update your payment method.';
  if (status.status === 'authenticated') return 'Your subscription is being activated. Please check again shortly.';
  return `Subscription status: ${status.status}.`;
}

async function refreshUser() {
  state.user = (await api('/auth/me')).user;
  render();
}

let checkoutScriptPromise;
function loadRazorpayCheckout() {
  if (window.Razorpay) return Promise.resolve();
  if (!checkoutScriptPromise) {
    checkoutScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      script.onload = () => window.Razorpay ? resolve() : reject(new Error('Razorpay checkout did not load.'));
      script.onerror = () => reject(new Error('Could not load Razorpay checkout. Please try again.'));
      document.head.appendChild(script);
    }).catch(error => { checkoutScriptPromise = null; throw error; });
  }
  return checkoutScriptPromise;
}

async function planAction() {
  const button = $('#plan-action');
  button.disabled = true;
  try {
    if (state.user.plan === 'pro' || state.user.hasSubscription) {
      const status = await api('/billing/status');
      $('#plan-footnote').textContent = billingStatusCopy(status);
      $('#plan-cancel').hidden = status.status !== 'active' || status.plan !== 'pro' || status.cancelScheduled;
      await refreshUser();
      return;
    }
    await loadRazorpayCheckout();
    const { key, subscriptionId } = await api('/billing/checkout', { method: 'POST' });
    if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(key) || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) {
      throw new Error('Invalid checkout details.');
    }
    $('#plan-dialog').close();
    const checkout = new window.Razorpay({
      key, subscription_id: subscriptionId,
      name: 'Studyvella',
      description: 'Studyvella Pro — ₹299 per month',
      prefill: { name: state.user.name, email: state.user.email },
      theme: { color: '#9A728A' },
      handler: async response => {
        try {
          const result = await api('/billing/verify', { method: 'POST', body: JSON.stringify(response) });
          await refreshUser();
          toast(result.plan === 'pro' ? 'Your Pro plan is active.' : 'Payment received. Your Pro plan will activate shortly.');
          if (result.plan !== 'pro') {
            for (let attempt = 1; attempt <= 4; attempt++) {
              setTimeout(async () => {
                try { await api('/billing/status'); await refreshUser(); } catch { /* reload can refresh later */ }
              }, attempt * 2500);
            }
          }
        } catch (error) { toast(error.message, true); }
      },
      modal: { ondismiss: () => { button.disabled = false; } },
    });
    checkout.open();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}

async function cancelPlan() {
  if (!window.confirm('Cancel Pro at the end of your current billing period?')) return;
  const button = $('#plan-cancel');
  button.disabled = true;
  try {
    const result = await api('/billing/cancel', { method: 'POST' });
    $('#plan-footnote').textContent = billingStatusCopy(result);
    button.hidden = true;
    await refreshUser();
    toast('Cancellation scheduled. Pro stays active until the period ends.');
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}

function showTimer() {
  const minutes = Math.floor(state.remaining / 60);
  const seconds = state.remaining % 60;
  $('#timer-display').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  $('#timer-toggle').textContent = state.timerEnd ? 'Pause focus' : state.remaining < state.timerMinutes * 60 ? 'Resume focus' : 'Start focus';
  $('#timer-subject').disabled = Boolean(state.timerEnd);
  document.querySelectorAll('[data-minutes]').forEach(button => { button.disabled = Boolean(state.timerEnd); button.classList.toggle('selected', Number(button.dataset.minutes) === state.timerMinutes); });
}

async function tickTimer() {
  if (!state.timerEnd) return;
  state.remaining = Math.max(0, Math.ceil((state.timerEnd - Date.now()) / 1000));
  showTimer();
  if (state.remaining > 0) return;
  clearInterval(state.timerInterval);
  state.timerEnd = null;
  const subject = $('#timer-subject').value;
  try {
    const { session } = await api('/study/sessions', { method: 'POST', body: JSON.stringify({ subject, minutes: state.timerMinutes, localDate: localDate() }) });
    state.sessions.unshift(session);
    renderStats();
    toast(`${state.timerMinutes} minutes of focus logged. One move, handled.`);
    if (state.view === 'insights' && state.user.plan === 'pro') {
      try { state.insights = await api(`/study/insights?today=${localDate()}`); renderInsights(); }
      catch { /* insights will refresh when reopened */ }
    }
  } catch (error) { toast(`Timer finished, but the session could not be saved: ${error.message}`, true); }
  state.remaining = state.timerMinutes * 60;
  showTimer();
  if (!document.querySelector('dialog[open]')) openTest(subject);
}

function toggleTimer() {
  if (state.timerEnd) {
    state.remaining = Math.max(0, Math.ceil((state.timerEnd - Date.now()) / 1000));
    state.timerEnd = null;
    clearInterval(state.timerInterval);
  } else {
    state.timerEnd = Date.now() + state.remaining * 1000;
    state.timerInterval = setInterval(tickTimer, 1000);
  }
  showTimer();
}

function resetTimer() {
  clearInterval(state.timerInterval);
  state.timerEnd = null;
  state.remaining = state.timerMinutes * 60;
  showTimer();
}

document.addEventListener('click', event => {
  const authButton = event.target.closest('[data-auth]');
  if (authButton) return showAuth(authButton.dataset.auth);
  const closeButton = event.target.closest('[data-close]');
  if (closeButton) return document.getElementById(closeButton.dataset.close).close();
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    selectView(viewButton.dataset.view);
    return;
  }
  const subjectButton = event.target.closest('[data-subject]');
  if (subjectButton) {
    state.subject = subjectButton.dataset.subject;
    state.status = 'open';
    $('.sidebar').classList.remove('open');
    render();
    return;
  }
  const taskAction = event.target.closest('[data-action]');
  if (taskAction) return handleTaskAction(taskAction);
  const testAction = event.target.closest('[data-test-action]');
  if (testAction) return handleTestAction(testAction);
  const reviewOutcome = event.target.closest('[data-outcome]');
  if (reviewOutcome) return reviewTest(reviewOutcome.dataset.outcome);
  if (event.target.closest('#empty-add-task')) openTask();
  if (event.target.closest('#empty-add-test')) openTest();
});

$('#back-home').addEventListener('click', () => { history.replaceState(null, '', '/'); showScreen('landing'); });
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#auth-submit');
  button.disabled = true;
  try {
    if (state.authMode === 'forgot') {
      const result = await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: form.elements.email.value.trim() }) });
      showAuth('login');
      toast(result.message);
    } else if (state.authMode === 'reset') {
      const token = new URLSearchParams(location.search).get('token');
      const result = await api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password: form.elements.password.value }) });
      history.replaceState(null, '', '/');
      showAuth('login');
      toast(result.message);
    } else {
      const body = { email: form.elements.email.value.trim(), password: form.elements.password.value };
      if (state.authMode === 'register') body.name = form.elements.name.value.trim();
      const { user } = await api(`/auth/${state.authMode}`, { method: 'POST', body: JSON.stringify(body) });
      await enterApp(user);
    }
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});
$('#logout-button').addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* clear local UI regardless */ }
  state.user = null; state.tasks = []; state.sessions = []; state.tests = []; state.insights = null;
  state.view = 'today'; state.subject = null; state.status = 'open';
  resetTimer();
  showScreen('landing');
});
$('#new-task-button').addEventListener('click', () => openTask());
$('#add-subject').addEventListener('click', () => { openTask(null, ''); $('#task-form').elements.project.value = ''; $('#task-form').elements.project.focus(); });
$('#task-form').addEventListener('submit', saveTask);
$('#test-form').addEventListener('submit', saveTest);
$('#new-test-button').addEventListener('click', () => openTest());
$('#review-reveal').addEventListener('click', () => {
  if (!$('#review-answer').value.trim()) return toast('Write your answer from memory first.', true);
  $('#review-reveal-row').hidden = true;
  $('#review-decision').hidden = false;
});
$('#task-search').addEventListener('input', event => { state.search = event.target.value; renderTasks(); });
$('#status-filter').addEventListener('change', event => { state.status = event.target.value; renderTasks(); });
$('#sidebar-upgrade').addEventListener('click', openPlan);
$('#plan-action').addEventListener('click', planAction);
$('#plan-cancel').addEventListener('click', cancelPlan);
$('#export-button').addEventListener('click', () => { location.href = '/api/export/tasks.csv'; });
$('#mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
$('.app-main').addEventListener('click', () => $('.sidebar').classList.remove('open'));
$('#timer-toggle').addEventListener('click', toggleTimer);
$('#timer-reset').addEventListener('click', resetTimer);
document.querySelectorAll('[data-minutes]').forEach(button => button.addEventListener('click', () => {
  state.timerMinutes = Number(button.dataset.minutes);
  resetTimer();
}));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
}));

async function boot() {
  $('#year').textContent = new Date().getFullYear();
  showTimer();
  try { state.config = await api('/config'); } catch { state.config = {}; }
  $('#landing-pro-price').textContent = state.config.proPriceLabel || 'Pricing coming soon';
  if (location.pathname === '/reset-password') {
    showAuth(new URLSearchParams(location.search).get('token') ? 'reset' : 'forgot');
    return;
  }
  try {
    const { user } = await api('/auth/me');
    await enterApp(user);
  } catch (error) {
    showScreen('landing');
    if (error.status && error.status !== 401) toast(error.message, true);
  }
}
boot();
