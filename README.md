# Studyvella

See [BRAND.md](BRAND.md) for the visual palette, typography, and writing voice.

Studyvella is a student-focused study planner. Students can create a private account, organise tasks by subject and due date, complete tasks, log focused study sessions, and use the Tomorrow Test. The same Node server serves the website and API.

The Tomorrow Test turns an unclear point into a next-day memory check: save one question (and optionally your current thought), answer it from memory when it is due, then mark it clear or schedule it again for tomorrow. The focus timer offers this prompt at the end of a session, and students can also add questions manually. It is a self-assessment tool; the app does not grade answers.

Check trademark and domain availability before a public launch.

## Run locally

Requires Node.js 24 or newer. No MongoDB account or external database is needed.

```powershell
cd todo-app/backend
npm install
npm start
```

Open **http://localhost:5000**. Your data is stored in `backend/data/studyvella.sqlite`. To use another port, set `PORT` in `backend/.env`. To use another database path, set `DB_PATH`.

Run the API tests with `npm test` from `todo-app/backend`.

## Product model

| Plan | Included |
| --- | --- |
| Free | 60 active tasks, unlimited subjects, due dates, priority, focus timer, study log, Tomorrow Test |
| Pro monthly — ₹299/month | Unlimited active tasks, weekly study insights, and CSV task export, plus everything in Free; renews monthly until cancelled |
| Pro Plus upfront — ₹2,999 once | Everything in Pro, plus an exam countdown with subject task progress and an editable weekly study goal, for 15 months from payment; no automatic renewal or additional payment during that term |

Completed tasks do not count toward the Free active-task limit. The upfront pass saves ₹1,486 against 15 monthly payments (₹4,485). The app verifies that the Razorpay subscription plan is exactly ₹299 monthly in INR before enabling either checkout. Profitability depends on acquisition, retention, pricing, and costs.

## Enable paid plans

1. Create a Razorpay merchant account. In Test Mode, open Account & Settings → API Keys → Generate Key and save the Key ID and Key Secret privately. Then open Subscriptions → Plans → + New Plan. Name it Studyvella Pro, set the billing amount to ₹299 INR and the frequency to Monthly, then copy its `plan_...` ID. See Razorpay's [API key](https://razorpay.com/docs/api/authentication) and [plan creation](https://razorpay.com/docs/payments/subscriptions/create-plans) guides.
2. Register a webhook at `https://YOUR_DOMAIN/api/billing/webhook` in Razorpay Dashboard → Account & Settings → Webhooks. Set a strong webhook secret. Subscribe to `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.paused`, `subscription.resumed`, `subscription.completed`, `subscription.updated`, `payment.captured`, `order.paid`, and `refund.processed`. See [Razorpay subscription webhooks](https://razorpay.com/docs/payments/subscriptions/subscribe-to-webhooks) and [payment webhook events](https://razorpay.com/docs/webhooks/payments/).
3. Set these variables in `backend/.env` or your hosting environment:

```text
APP_URL=https://YOUR_DOMAIN
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_PLAN_ID=plan_...
RAZORPAY_WEBHOOK_SECRET=...
BUSINESS_NAME=Your registered business name
SUPPORT_EMAIL=help@your-domain.example
REFUND_POLICY=7-day-first-charge
```

Paid checkout also requires the public Contact, About, Privacy, Terms, and Refunds pages to be complete, and password recovery email to be configured. Set the real business name, a working support inbox, and a reviewed monthly refund choice (`7-day-first-charge` or `no-refunds`). The upfront pass policy is no refunds after purchase, subject to required legal exceptions and billing errors. `CONTACT_NAME` defaults to Tan. Until `SUPPORT_PHONE` is set, Contact displays a clearly labeled, unmonitored example number. Optional `BUSINESS_ADDRESS` appears when supplied. Set `INSTAGRAM_URL`, `LINKEDIN_URL`, `YOUTUBE_URL`, and `PINTEREST_URL` to the full HTTPS addresses of Tan's actual profiles; until then, Contact shows non-clickable placeholders. When the required business details are missing, paid checkout remains disabled. Review these policy drafts for your business before inviting paying customers.

The site enables upgrades only after it retrieves and validates the configured monthly plan. Students authorise payments in Razorpay Checkout. Monthly access follows live subscription status and signed webhooks. The Pro Plus 15-month pass creates a one-time Razorpay Order for ₹2,999 (299900 paise); after verifying the checkout signature, captured payment, order status, amount, currency, and owner, the app grants access through the exact expiry date. A signed payment webhook can also grant access if the browser callback is missed. Full refunds revoke the pass. The pass has no automatic renewal. Exam Runway and the weekly goal API require an active Pro Plus pass; saved exam and goal data remain on the account if the pass expires. Students can schedule cancellation of monthly billing at the end of the current billing period. Razorpay requires a bounded subscription; this integration creates 120 monthly billing cycles (ten years). Before then, a customer who wants to continue would need a new subscription.

Run `npm run billing:check` from `todo-app/backend` after setting the variables. It verifies the Razorpay plan and prints the webhook URL. Then test monthly checkout, a successful charge, a failed charge, cancellation, one-time checkout, expiry, and refund handling with test keys and a public test webhook URL. Replace test keys, plan ID, and webhook secret with their live equivalents only after the test flow works. When variables are absent, paid checkout stays disabled. Keep the Key Secret and webhook secret out of frontend files and Git.

## Password recovery

The login screen has a “Forgot password?” flow. It emails a one-hour, single-use link, replaces the password, and signs out old sessions. Create a Resend account, verify a sender domain, and set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` in the server environment. The sender must be a real address on your verified domain. Without these values the recovery form reports that setup is incomplete; do not invite paying customers until a real reset email has been tested. See [Resend's sending API](https://resend.com/docs/api-reference/emails/send-email) and [domain setup](https://resend.com/docs/dashboard/domains/introduction).

## Render deployment

`render.yaml` prepares one paid Node web service with a persistent `/var/data` disk for SQLite. Put the contents of `todo-app` at the root of a private GitHub repository, then create a Render Blueprint from that repository. The app uses Render's assigned HTTPS URL automatically. If you later add a custom domain, set `APP_URL` to that exact origin without a trailing slash. Add the business, Resend, and Razorpay values through Render's Environment settings, never to Git. The service runs `cd backend && npm ci`, then `node backend/server.js`, and uses `/api/health` for health checks. Keep a separate SQLite backup outside the Render disk.

## Deployment notes

- Host the Node server over HTTPS. Set `NODE_ENV=production` so session cookies are secure.
- Use a persistent disk for `DB_PATH`, keep database backups, and run one application instance with SQLite. A multi-instance deployment needs a shared database migration.
- Outside Render, set `APP_URL` to the public app origin without a trailing slash. On Render, the app defaults to its assigned HTTPS URL. It is used for password reset links and same-origin request protection.
- Before inviting real customers, test the real password reset email and complete the business details and policy drafts. Email verification, monitoring, and a support workflow still need attention.
- The original MongoDB prototype was replaced. Old shared tasks are not imported because they had no account owner. The top-level `index.html` now points to the live app; the top-level `javascript.js` is unused legacy code. The live app is served from `todo-app/frontend` by `todo-app/backend/server.js`.

## Main files

- `backend/server.js` — API, security headers, static serving, CSV export
- `backend/auth.js` — account registration, login, private sessions
- `backend/tasks.js` — private task CRUD and plan limits
- `backend/study.js` — focus-session log
- `backend/tomorrow-tests.js` — private question capture and next-day review
- `backend/runway.js` — Pro Plus exam countdowns and weekly study goals
- `backend/billing.js` — Razorpay subscriptions, one-time orders, checkout verification, cancellation, signed webhooks
- `backend/db.js` — SQLite tables and queries
- `frontend/` — responsive website
