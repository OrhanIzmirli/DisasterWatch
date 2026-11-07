# Operations

Running, configuring and deploying DisasterWatch, and what the free setup and the sources limit. Back to the [README](../README.md).

## Limits

- **Alerts can be hours late.** The free Render services sleep after about 15 minutes without traffic. GitHub's scheduled workflow (`.github/workflows/wake.yml`, hourly on paper, in practice every few hours because GitHub delays or skips scheduled runs under load) wakes them; then the backend ingests and the notification service consumes what waits in Kafka. An alert therefore arrives up to several hours after the source reports the event (plus the source's own delay), and events older than 48 hours never notify. While someone uses the site the backend ingests every 5 minutes, but the site never calls the notification service, so alerts (and the e-mail confirmation link) still wait for the next wake-up.
- **Free infrastructure.** Cold starts take up to a minute, and the first feed after it waits for the NASA EONET download (2.6 MB, 4–13 s when measured). It does not wait for GDACS: events show the GDACS answers stored from earlier lookups at once, the others the EONET point and measurement (floods: not rated) until their lookup answers in the background, from the next request on. GDACS is often slow (on 2026-10-22 most lookups timed out from Render and from a residential line alike), so after a long sleep or a deploy some events can stay on the EONET values for a while. The ingestion job waits for the lookups of the events it has not recorded yet (the others are recorded once and not looked up again) and records an event with the EONET point and area when GDACS cannot be reached. Aiven's free Kafka powers off after a period without traffic and must be started from its console; until then events wait in the outbox and no alerts go out. The free plans also cap the database size, instance hours and e-mails (100 per day at Resend; e-mail stops at 90 by default, `EMAIL_DAILY_LIMIT`, and alerts stay in-app).
- **An alert carries the level known when the event was first seen.** The ingestion job asks GDACS for an event's impact level only before recording it; a recorded event is never rated again (the public feed refreshes its levels, the alert pipeline does not). An event whose GDACS level rises later (Green to Orange or Red) sends no new alert, so a subscriber whose minimum severity it now reaches never hears of it; an event recorded while GDACS was unreachable keeps the severity from the EONET measurement for the same reason.
- **Source coverage.** Only what USGS (M 4.5+) and NASA EONET (wildfires, floods, severe storms) report: no volcanoes, landslides, tsunami warnings, heat waves, droughts or official warnings. EONET lists an event when one of its contributors does, so small or local events may be missing and some arrive late. EONET reports no flood measurement, so floods are rated only by their GDACS level and shown as not rated when GDACS cannot be reached. GDACS levels describe expected humanitarian impact, not physical size.
- **News coverage.** GDELT answers most requests with HTTP 429 (even from a residential IP; Render's shared address makes it worse); The Guardian needs a key; GDACS media lists are noisy. The panel may be thin or stale for hours, and the relevance rules are word-based, so some off-topic articles get through and some relevant ones are dropped.
- **E-mail.** Until the project has its own sending domain, Resend's test mode delivers only to the Resend account owner's address; other users see the switch but their e-mails fail. There is no SMS or push channel.

---

## Running the services outside Docker

Start the infrastructure in Docker and the service you are working on with Node `24.13.0` (`nvm use` reads `.nvmrc`).

```bash
docker compose up db dw-kafka            # PostgreSQL on 5432, Kafka on 29092 for the host
```

**Backend** (`backend/`)

```bash
cd backend
npm ci
npx prisma generate
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/disasterwatch npx prisma db push
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/disasterwatch KAFKA_BROKER=localhost:29092 npm run dev
```

The other variables come from `backend/.env` (`dotenv`); its `NODE_ENV=development` keeps the session cookie non-Secure for plain http and tolerates the dev `JWT_SECRET` placeholder.

**Frontend** (`disasterwatch-frontend/`)

```bash
cd disasterwatch-frontend
npm ci
npm run dev                              # http://localhost:5173, /api proxied to localhost:5000
```

**Notification service** (`notification-service/`)

```bash
cd notification-service
npm ci
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/disasterwatch KAFKA_BROKER=localhost:29092 npm start
```

---

## Tests and CI in detail

| Suite | Command | Needs |
|---|---|---|
| Backend (Vitest + supertest) | `cd backend && npm test` | `TEST_DATABASE_URL`, a throwaway PostgreSQL |
| Notification service (Vitest) | `cd notification-service && npm test` | nothing for the unit tests; the e-mail dispatcher tests run only with `TEST_DATABASE_URL` (schema pushed from `backend/prisma`) and are skipped otherwise |
| Frontend (Vitest + Testing Library, ESLint) | `cd disasterwatch-frontend && npm run lint && npm test && npm run build` | nothing (lint, tests, type check + production build) |
| Frontend visual and accessibility (Playwright, axe-core) | `cd disasterwatch-frontend && npm run build && npm run test:e2e` | Chromium (`npx playwright install chromium`); screenshots compare only inside the Linux image, see [Visual tests](#visual-tests) |

The backend suite **refuses to run against the application database**: `TEST_DATABASE_URL` must be set, must not share a host with `DATABASE_URL` (from the environment or `backend/.env`), and the target must not contain any user whose e-mail is not `@example.com`. It pushes the Prisma schema into that database and truncates the tables before every file. A throwaway database for local runs:

```bash
docker run -d --name dw-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=dwtest -p 55432:5432 postgres:16
cd backend && npx prisma generate
TEST_DATABASE_URL=postgresql://postgres:test@localhost:55432/dwtest npm test
```

`GET /disasters` (external NASA/USGS) is not covered by tests on purpose.

**CI** (`.github/workflows/ci.yml`, on every push and pull request): backend tests and notification-service tests, each against its own `postgres:16` service container, frontend lint, tests and build, and the frontend visual and accessibility tests in the Playwright image (a failed run uploads the report with the image diffs). The Node jobs use the version from `.nvmrc`.

### Visual tests

`disasterwatch-frontend/e2e/` runs the production build in Chromium at 1440 px and 390 px with fixed data (`e2e/fixtures.ts`: every API call is answered there, map tiles are blank, the clock is frozen at 2026-11-06 12:00 UTC, invented titles and example.com links only), so a test fails only when the UI changes:

- `visual.spec.ts`: each page, the open drawer (earthquake, wildfire, storm), the news panel and the map tooltip, compared with the reviewed baselines in `e2e/__screenshots__/` (up to 0.2 % of pixels may differ, for anti-aliasing). The status bar's measured API latency is masked.
- `behaviour.spec.ts`: "Show on map" in the drawer and in the news panel, the Today's events cards, and the note for a news link to an event the feed no longer has.
- `a11y.spec.ts`: axe-core with the WCAG 2.1 A and AA rules on every page, the drawer and the news panel; serious and critical findings fail.

Font rendering differs between operating systems, so the baselines are made in the image CI uses. After an intended UI change, update them and review the new images in the pull request:

```bash
docker run --rm -v "$PWD":/work -v /work/disasterwatch-frontend/node_modules -w /work/disasterwatch-frontend   mcr.microsoft.com/playwright:v1.56.1-noble   bash -lc "npm ci && npm run build && npx playwright test --update-snapshots"
```

The extra `node_modules` volume keeps the container's Linux packages out of the local install. On Windows and macOS the behaviour and accessibility tests run directly (`npx playwright test e2e/behaviour.spec.ts e2e/a11y.spec.ts`); the screenshot comparisons belong to the Linux image.

### End-to-end flows (local stack)

`disasterwatch-frontend/e2e-stack/` drives the write flows through the UI against a local Docker Compose stack: sign-up, sign-in and a refused wrong password, creating and deleting alerts (with an axe check of the open form), the e-mail switch, an `ADMIN_EMAILS` address becoming admin only after confirming while signed in, disabling and re-enabling a user with the audit log, an event published to Kafka reaching the user's bell, and account deletion. They create accounts, so `playwright.stack.config.ts` refuses any URL that is not localhost.

```bash
docker compose up -d --build            # with local values only, see below
cd disasterwatch-frontend
npx playwright test -c playwright.stack.config.ts
```

Run them with local values only: `backend/.env` may hold cloud settings, so override them for the run (an extra compose file with `environment:` entries for `JWT_SECRET` (the `.env.example` placeholder), `KAFKA_BROKER*` (`dw-kafka:9092`), empty `KAFKA_SASL_*` and `GUARDIAN_API_KEY`, `ADMIN_EMAILS=admin@example.com`), and give the notification service a dummy `RESEND_API_KEY`, an `example.com` sender and `extra_hosts: ["api.resend.com:127.0.0.1"]` so the e-mail channel counts as configured while nothing can leave the machine. A separate database volume keeps an older local schema out of the way (`prisma db push` stops on its data-loss warning otherwise). Sign-in is rate limited (10 attempts per 15 minutes per client): restart the backend container between repeated runs.

### Read-only checks (live site)

`disasterwatch-frontend/e2e-live/` checks the live site without writing: every request that is not a GET is aborted. It covers the feed, type filters, search, severity sort, paging, the map and its clusters, the drawer and "Show on map", the news panel with its hazard and region filters, privacy, 404 and the phone views. Live data changes, so the tests check consistency (a filter keeps only its type, search results name the place), not exact values.

```bash
cd disasterwatch-frontend
npx playwright test -c playwright.live.config.ts      # DW_LIVE_URL overrides the address
```


---

## Environment variables

Every service has a `.env.example` next to its code. Docker Compose sets the container-specific values (`DATABASE_URL`, `KAFKA_BROKER`, `NODE_ENV`, `PORT`) itself; `backend/.env` is loaded on top via `env_file` and is the place for secrets and optional keys.

### Backend (`backend/.env.example`)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | – | PostgreSQL connection string (Prisma). Compose sets the in-network value |
| `JWT_SECRET` | yes | dev placeholder | signs session tokens. **32+ characters**; with `NODE_ENV=production` the server refuses to start when it is missing, shorter, the literal `CHANGE_ME`, the `.env.example` value or anything containing "change me". Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| `JWT_EXPIRES_IN` | no | `1d` | token lifetime; keep in line with the 24 h cookie |
| `COOKIE_NAME` | no | `dw_session` | session cookie name |
| `ADMIN_EMAILS` | no | empty | comma-separated e-mails that get the `admin` role (case-insensitive) once the address is confirmed while signed in. Checked on every request: added → promoted, removed → demoted. There is no other way to become admin |
| `NODE_ENV` | no | – | `production` enables the Secure cookie flag and the strict `JWT_SECRET` check (every deployment); Compose runs the local stack with `development`; `test` disables the background jobs |
| `PORT` | no | `5000` | HTTP port (Render provides it) |
| `KAFKA_BROKER` | no | `dw-kafka:9092` | broker(s), comma-separated. `KAFKA_BROKERS` and `KAFKA_BOOTSTRAP_SERVERS` are accepted as aliases |
| `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD` | cloud | empty | when both are set the client connects with SASL_SSL (Aiven). One without the other is a configuration error |
| `KAFKA_SASL_MECHANISM` | no | `scram-sha-256` | `plain`, `scram-sha-256` or `scram-sha-512` |
| `KAFKA_SSL_CA` | cloud | empty | CA certificate (PEM) for providers with a private CA; `\n` accepted for newlines |
| `GUARDIAN_API_KEY` | no | empty | adds The Guardian as a news provider ([News](news.md)) |
| `GDELT_TIMEOUT_MS` | no | `30000` | per-request timeout for GDELT searches (answers take 15–18 s) |
| `GDACS_TIMEOUT_MS` | no | `4000` | per-request timeout for GDACS impact-level lookups ([Severity](severity.md)) |
| `DISABLE_GDACS` | no | – | `1` switches the GDACS lookups off (wildfires fall back to the size rule, floods are not rated) |
| `CORS_ORIGINS` | no | live frontend + `localhost:8080/5173/4173` | browser origins allowed to call the API directly; the `/api` proxy never needs it |
| `DISABLE_NEWS_JOB` | no | – | `1` switches off the background news refresh |
| `DISABLE_INGESTION` | no | – | `1` switches off the NASA/USGS ingestion job (no events reach Kafka) |
| `INGEST_WAKE_SECRET` | cloud | empty | shared secret of the scheduled wake-up (`POST /internal/ingest`, [Scheduled wake-up](#scheduled-wake-up)); **32+ characters**, same value as the GitHub Actions secret of the same name (the workflow is the only caller). Without it the endpoint does not exist |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | for API keys | empty | credentials of the GitHub OAuth app behind the optional public API keys (the secret is a secret: Render environment only). Without both, `/api/v1/auth/github` answers 503 and the API page offers no sign-in; the API itself works without keys |
| `GITHUB_OAUTH_REDIRECT_URI` | optional | the live site's `/api/v1/auth/github/callback` | must equal the OAuth app's callback URL; set it for a local or other deployment |
| `TEST_DATABASE_URL` | tests | – | throwaway database for `npm test` ([Tests and CI](#tests-and-ci-in-detail)) |

### Notification service (`notification-service/.env.example`)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | – | the app database: reads `AlertSubscription`, writes `Notification` (plain `pg`, no Prisma). The service exits without it |
| `KAFKA_BROKER` | no | `dw-kafka:9092` | broker(s); same aliases as the backend |
| `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`, `KAFKA_SASL_MECHANISM`, `KAFKA_SSL_CA` | cloud | – | as for the backend |
| `PORT` | no | `3000` | health-check port (`GET /health`) |
| `NODE_ENV` | no | – | informational |
| `RESEND_API_KEY` | for e-mail | – | [Resend](https://resend.com) API key (secret). E-mail stays off unless this, `RESEND_FROM` and `APP_URL` are set |
| `RESEND_FROM` | for e-mail | – | sender; without an own domain (Resend test mode) `DisasterWatch <onboarding@resend.dev>`, which delivers only to the Resend account owner's address |
| `APP_URL` | for e-mail | – | public site URL for the links in the e-mail, no trailing slash |
| `EMAIL_DAILY_LIMIT` | no | `90` | e-mails per rolling 24 hours (Resend free plan: 100 per day) |

### Frontend (`disasterwatch-frontend/.env.example`)

The frontend reads **no** environment variables. It calls relative `/api/...` paths, which are rewritten to the backend by Nginx (Docker), by the Vite dev server (`vite.config.ts`) and by a Render rewrite rule (cloud).

---

## Cloud deployment (free tiers)

The same code runs in the cloud; only environment variables change. Without the Kafka SASL variables everything behaves exactly like the local Docker Compose setup.

| Component | Service |
|---|---|
| Frontend | Render Static Site |
| Backend | Render Web Service (Docker, `backend/`) |
| Notification service | Render Web Service (Docker, `notification-service/`) |
| PostgreSQL | Neon |
| Kafka | Aiven for Apache Kafka (free tier) |

### 1) Kafka (Aiven)
1. Create a free Kafka service.
2. In **Advanced configuration**, enable `kafka_authentication_methods.sasl`.
3. Create the topic `disaster-events` (automatic topic creation is off by default).
4. From the **SASL** connection details, copy the host:port, user, password and the CA certificate.

The free tier powers off after a period without traffic; it can be started again from the Aiven console.

### 2) Database (Neon)
Create a database and copy its connection string (keep `?sslmode=require`). Push the Prisma schema once from your machine, using the **direct** (non-pooler) host:

```bash
cd backend
npm ci
DATABASE_URL="postgresql://...neon.tech/...?sslmode=require" npm run db:push
```

### 3) Backend and notification service (Render)
Create two **Web Services** from this repository with the **Docker** runtime, root directories `backend` and `notification-service`, and health check path `/health`. Set the variables from the [Environment variables](#environment-variables) tables: both services need `DATABASE_URL` (pooler host is fine at runtime), `KAFKA_BROKER`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD` and, unless `letsencrypt_sasl` is enabled on the Aiven service, `KAFKA_SSL_CA`; the backend additionally needs `JWT_SECRET`, `NODE_ENV=production` and `ADMIN_EMAILS`, `INGEST_WAKE_SECRET` for the scheduled wake-up ([Scheduled wake-up](#scheduled-wake-up)), optionally `GUARDIAN_API_KEY` and `CORS_ORIGINS`; the notification service needs `RESEND_API_KEY`, `RESEND_FROM` and `APP_URL` for e-mail ([E-mail alerts](#e-mail-alerts)). Render provides `PORT`.

**Generate a new `JWT_SECRET` for the deployment, never reuse the example value**: in production the backend refuses the `.env.example` placeholder and anything containing "change me" (`node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`).

Free Render web services sleep after inactivity, so the consumer only processes messages while the service is awake.

### 4) Frontend (Render Static Site)
- Root directory: `disasterwatch-frontend`
- Build command: `npm ci && npm run build`
- Publish directory: `dist`
- Redirects/Rewrites, in this order:
  - `/api/*` → `https://<backend-service>.onrender.com/*` (Rewrite)
  - `/*` → `/index.html` (Rewrite)

The frontend calls relative `/api/...` paths, so the first rule plays the role of the Nginx proxy used locally. Render reads the Node version from `engines` in `package.json`.

---

## Scheduled wake-up

The services are not kept awake (the free plan has 750 instance hours a month per workspace). The GitHub Actions workflow `.github/workflows/wake.yml` wakes them: its schedule says minute 22 of every hour, but GitHub delays or skips scheduled runs under load, and in practice the runs arrive every three to five hours. It is the only scheduler: an external cron service was tried and dropped, because Render's edge answered its requests to a sleeping service with 503 (`x-render-routing: hibernate-wake-error`) without waking it, while the same requests from a GitHub runner wake it. Each run opens an awake window of about 20 minutes (the calls, then Render's 15-minute idle timer; a few minutes more when the workflow follows a long run on `/health`): some 6 to 8 windows a day, roughly 50 to 80 instance hours a month per service; even hourly runs would use about 240 per service, within the budget. Visits to the site open their own windows. Every run sends:

1. `POST <backend>/internal/ingest` with `Authorization: Bearer <INGEST_WAKE_SECRET>`: a sleeping backend wakes (and ingests on start), an awake one ingests unless a run worked in the last 10 minutes (it ingests every 5 minutes anyway); new events are published to Kafka. Idempotent: a run in progress is joined, a failed recent run is retried. The secret is compared in constant time and the endpoint is rate limited (10 requests per 15 minutes per client). The answer carries counts only; `ok: false` (a failed source fetch or Kafka publish, e.g. a powered-off Aiven broker) fails the workflow run, so GitHub reports it. The answer is sent within 60 seconds whatever the run does (Kafka readiness and the run share that budget): when the run is still going, the endpoint answers `202 { reason: "in-progress" }` and the run continues; the workflow then follows it on `/health` → `ingest` (`running`, then `lastErrorSources`) for up to 6 minutes. Before this, a run after a long sleep could hold the answer for 5 minutes and more (it refreshed the GDACS lookups of every EONET event of the last 30 days first) and every wake-up call timed out, which GitHub reported as a failed run.
2. `GET <notification service>/health`: the consumer wakes and processes what waits in Kafka.

Setup, values never in the repository:

| Where | Name | Value |
|---|---|---|
| Render → backend → Environment | `INGEST_WAKE_SECRET` | a random string of 32+ characters, e.g. `node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"` |
| GitHub → Settings → Secrets and variables → Actions → **Secrets** | `INGEST_WAKE_SECRET` | the same value |
| GitHub → … → Actions → **Variables** | `BACKEND_URL` | the backend's Render URL, no trailing slash |
| GitHub → … → Actions → **Variables** | `NOTIFICATION_URL` | the notification service's Render URL, no trailing slash |

`/health` → `ingest` shows the last run (time, trigger, counts, which part failed) and the last wake-up (`lastWakeAt`, `lastWakeOutcome`). `ingest.eonetFallbackRecorded` counts the events recorded with the EONET point because GDACS could not be reached (`total` since the process started; `lastStats.eonetFallback` for the last run); events are recorded once, so these keep that point (and the severity from the EONET measurement), and their ids are in the `[ingest] ... recorded with the EONET point` log line. GitHub delays scheduled runs under load and disables a schedule after 60 days without repository activity (a push keeps it alive): check `lastWakeAt` to see when the last wake-up arrived and the run list under Actions → Scheduled wake for the gaps between runs; **Run workflow** there (`workflow_dispatch`) wakes the services by hand.

## E-mail alerts

Opt-in per user: `User.emailAlertsEnabled` is `false` until the user turns the switch on the Alerts page on; the request must carry `consent: true` and the consent time is stored. **Double opt-in:** registration does not verify addresses, so the first e-mail to an address is a confirmation link only (fixed text, nothing a user typed); alert e-mails start after its owner opened `/confirm-email` and pressed the button (`User.emailVerifiedAt`). Only notifications created after the consent are e-mailed, at most 24 hours after they were created.

The notification service (`src/email/`) sends, after a burst of new notifications (20 s debounce, at most 2 minutes) and every 10 minutes for retries, **one summary e-mail per user** with all of that user's new notifications (a user whose previous digest is still being retried waits for it). Claims run in one transaction under a transaction-level advisory lock (it also works through the Neon pooler); each send takes a short lease on its delivery row, so two instances never send the same digest.

- **Daily limit** (`EMAIL_DAILY_LIMIT`, default 90 per rolling 24 h; Resend free: 100/day; confirmation e-mails count too) counted from the `EmailDelivery` table (sent, pending, and failed ones that reached the provider), not from memory, since the service sleeps and restarts. Over the limit the notification is marked `emailSkipReason = "daily-limit"`; the in-app notification exists anyway.
- **Never twice:** a digest is a `pending` `EmailDelivery` row before the send; a notification belongs to at most one digest. `emailSentAt` is written only after Resend accepted the e-mail. The message is rendered once and stored with the delivery; a transient failure (network, 429, 5xx, Resend's 409 "concurrent request") leaves it pending and the next run sends the identical payload with the same `Idempotency-Key`, so a send that did go out is not repeated; other 4xx, 5 failures or 23 hours (Resend keeps keys 24 h) mark it failed (`send-failed`).
- **Content:** per event the title, type, severity, source, time (UTC), location with the map's "approximate" note, and a link to the event on the map; below, which alert matched, the alert settings link and the unsubscribe link. Plain text + HTML, only data from our database: no third-party text, no images, no tracking pixel.
- **Unsubscribe:** every e-mail has a link to `/unsubscribe?token=…` (no sign-in; one button press switches e-mail off and the page confirms it; opening the page changes nothing, so link scanners, even ones that run JavaScript, cannot unsubscribe anyone) and the headers `List-Unsubscribe: <APP_URL/api/email/unsubscribe?token=…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). The token is 32 random bytes, kept across opt-ins.
- **Honest status:** the service writes `EmailChannelStatus` on start and after every run; the Alerts page shows e-mail as "active" only when the service reports it configured (within 3 hours), and says when the daily limit is used up. `/health` of both services shows the e-mail status (configured, sent in the last 24 h, last error); no addresses. Logs mask addresses (`som***@example.com`).

## Operational notes

The user-facing limits (alerts hours late, free tiers, source coverage) are listed under [Limits](#limits).

- **Sleeping services catch up.** While the backend sleeps no ingestion runs and nothing is published; while the notification service sleeps nothing is consumed. Both catch up when they wake: Kafka keeps the messages, so the consumer resumes from its committed offset. With the broker powered off the backend keeps serving the public feed and events wait in the outbox.
- Events older than 48 hours and subscriptions created after an event never produce notifications, by design.
- **GDELT rate limits by source IP.** The news job backs off and keeps serving GDELT's last articles (72 h) next to The Guardian and GDACS media; `/health` → `news.providers.gdelt` shows the last success and error.
- **Deploy order: notification-service first, then the backend.** A consumer running an older build rejects messages with a value it does not know (such as `severity: "unrated"`) and commits their offsets, so those events never produce notifications unless the group offset is reset. On Render: 1) deploy the `notification-service` web service and wait for its `/health` to answer with `kafka: "connected"`; 2) only then deploy the backend. With auto-deploy from `main` on both services, suspend the backend's auto-deploy before merging a contract change, merge, let the notification-service build finish, then deploy the backend manually.
