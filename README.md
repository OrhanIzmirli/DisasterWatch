# DisasterWatch

[![CI](https://github.com/OrhanIzmirli/DisasterWatch/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/OrhanIzmirli/DisasterWatch/actions/workflows/ci.yml)

A real-time disaster monitoring platform. The backend aggregates **NASA EONET** and **USGS** into one feed, rates every event LOW / MEDIUM / HIGH (or not rated) from what the sources publish, links news articles to events, and streams new events through **Kafka** to a notification service that matches them against users' location-based alert rules and sends in-app and opt-in e-mail alerts. The React frontend shows everything on a live map with a feed, news panel, alert subscriptions, notifications and an admin console.

**Live:** https://disasterwatch-frontend.onrender.com (free hosting: the first request after a quiet spell can take up to a minute while the services wake up, see [Limits](#limits)).

The whole stack runs on localhost with one `docker compose up`; the same images run in the cloud (Render + Neon + Aiven + Resend, free tiers).

> DisasterWatch is a portfolio project, not an official warning service. For warnings and evacuation orders follow your local authorities.

---

## Contents

- [Architecture](#architecture)
- [Methodology in short](#methodology-in-short)
- [Limits](#limits)
- [Features](#features)
- [Quick start (Docker Compose)](#quick-start-docker-compose)
- [Running the services outside Docker](#running-the-services-outside-docker)
- [Tests and CI](#tests-and-ci)
- [Environment variables](#environment-variables)
- [HTTP API](#http-api)
- [Feed contract: `GET /disasters`](#feed-contract-get-disasters)
- [News](#news)
- [Event-driven notification pipeline](#event-driven-notification-pipeline)
- [Kafka demo (send a test event)](#kafka-demo-send-a-test-event)
- [Cloud deployment (free tiers)](#cloud-deployment-free-tiers)
- [Repository layout](#repository-layout)
- [Screenshots](#screenshots)

---

## Architecture

```
                      ┌──────────── backend (Express + Prisma) ────────────┐
NASA EONET ──┐        │ feed cache (5 min) ──────────────> GET /disasters  │
USGS ────────┼──────> │ GDACS impact level + point (severity, location)    │
GDACS ───────┘        │ ingestion job ─> IngestedEvent (outbox) ─┐         │
GDELT, Guardian,      │ news job ─> NewsCache ─────────> GET /news│        │
GDACS media ────────> │ accounts, alerts, admin, privacy          │        │
                      └───────────────────────────────────────────┼────────┘
                                                                  │ publish
                                                       Kafka topic disaster-events
                                                                  │ consume
                      ┌──────────── notification-service ─────────▼────────┐
                      │ match subscriptions ─> Notification (in-app bell)  │
                      │ e-mail dispatcher ─> EmailDelivery ─> Resend       │
                      └────────────────────────────────────────────────────┘
React (Vite) frontend ── /api ──> backend          PostgreSQL: one database for both services
```

| Part | Runs as | Cloud (free tier) | Local (Compose) |
|---|---|---|---|
| Frontend (React, TypeScript, Leaflet) | static build | Render Static Site, `/api` rewritten to the backend | Nginx on 8080, proxies `/api` |
| Backend (Node.js, Express, Prisma) | web service | Render Web Service (Docker) | container on 5000 |
| Notification service (Node.js, KafkaJS, `pg`) | Kafka consumer + e-mail sender | Render Web Service (Docker) | container |
| Database | PostgreSQL | Neon | PostgreSQL 16 container |
| Message broker | Kafka | Aiven | Confluent 7.6.1 containers |
| E-mail | HTTP API | Resend | off (add `RESEND_*` and `APP_URL` to the `notification` service) |
| Scheduler | wake-up call every few hours | GitHub Actions scheduled workflow (`wake.yml`) | not needed |

The public map and feed need only the backend and the sources; Kafka, the notification service and Resend carry the alerts. Each part degrades on its own: a failed source, news provider, GDACS lookup or a powered-off broker leaves the rest working and is reported in `/health`.

---

## Methodology in short

- **Sources.** Earthquakes of the last 7 days from USGS (magnitude 4.5 and above); wildfires, floods and severe storms from NASA EONET (open and closed events of the last 30 days; the feed shows the last 7 days by default). Every feed item keeps its source id and links, and nothing is invented: when the sources fail the feed says so instead of showing demo data.
- **Location.** USGS gives a point. For EONET events reported by GDACS the GDACS event point wins over the EONET geometry when GDACS can be reached (otherwise the EONET geometry is used, see `ingest.eonetFallbackRecorded`); when the two are more than 100 km apart the event is marked *approximate* and the drawer says why. Countries come from the source place names; an event whose country cannot be derived (open sea) is not counted as a country.
- **Severity.** Taken from the source wherever it publishes one: GDACS impact level (Green / Orange / Red) for wildfires and floods, magnitude for earthquakes, the Saffir-Simpson scale on the peak advisory wind for storms, burned area for fires GDACS does not cover. An event the source gives no intensity for is shown as *not rated*, never guessed. The wildfire area cut was set from 90 days of EONET data; storms use the Saffir-Simpson boundaries ([Severity](#severity)).
- **News.** At most four requests per provider and refresh (up to three combined searches for the most important events plus one general search; GDELT makes only the general one), plus the media lists GDACS keeps for up to 25 GDACS-linked events. Every article passes the same relevance rules (sport, retrospectives, idioms and similar are dropped). GDELT and Guardian articles are linked to an event by headline or story slug; GDACS media articles come with the GDACS event they are listed under. An article gets a country from its linked event, its Guardian tags or its GDACS event, and a country inherited from GDACS is kept only when the headline or slug names it; otherwise the article stays unlocated ([News](#news)).
- **Alerts.** A subscription is a hazard type, a minimum severity and a circle (centre + radius). New events are recorded once, published through a transactional outbox and matched by distance; each user gets at most one notification per event and, if they opted in and confirmed their address, one summary e-mail per run ([Event-driven notification pipeline](#event-driven-notification-pipeline)).

---

## Limits

- **Alerts can be hours late.** The free Render services sleep after about 15 minutes without traffic. GitHub's scheduled workflow (`.github/workflows/wake.yml`, hourly on paper, in practice every few hours because GitHub delays or skips scheduled runs under load) wakes them; then the backend ingests and the notification service consumes what waits in Kafka. An alert therefore arrives up to several hours after the source reports the event (plus the source's own delay), and events older than 48 hours never notify. While someone uses the site the backend ingests every 5 minutes, but the site never calls the notification service, so alerts (and the e-mail confirmation link) still wait for the next wake-up.
- **Free infrastructure.** Cold starts take up to a minute, and the first feed after it waits for the NASA EONET download (2.6 MB, 4–13 s when measured). It does not wait for GDACS: events show the GDACS answers stored from earlier lookups at once, the others the EONET point and measurement (floods: not rated) until their lookup answers in the background, from the next request on. GDACS is often slow (on 2026-10-22 most lookups timed out from Render and from a residential line alike), so after a long sleep or a deploy some events can stay on the EONET values for a while. The ingestion job waits for the lookups of the events it has not recorded yet (the others are recorded once and not looked up again) and records an event with the EONET point and area when GDACS cannot be reached. Aiven's free Kafka powers off after a period without traffic and must be started from its console; until then events wait in the outbox and no alerts go out. The free plans also cap the database size, instance hours and e-mails (100 per day at Resend; e-mail stops at 90 by default, `EMAIL_DAILY_LIMIT`, and alerts stay in-app).
- **An alert carries the level known when the event was first seen.** The ingestion job asks GDACS for an event's impact level only before recording it; a recorded event is never rated again (the public feed refreshes its levels, the alert pipeline does not). An event whose GDACS level rises later (Green to Orange or Red) sends no new alert, so a subscriber whose minimum severity it now reaches never hears of it; an event recorded while GDACS was unreachable keeps the severity from the EONET measurement for the same reason.
- **Source coverage.** Only what USGS (M 4.5+) and NASA EONET (wildfires, floods, severe storms) report: no volcanoes, landslides, tsunami warnings, heat waves, droughts or official warnings. EONET lists an event when one of its contributors does, so small or local events may be missing and some arrive late. EONET reports no flood measurement, so floods are rated only by their GDACS level and shown as not rated when GDACS cannot be reached. GDACS levels describe expected humanitarian impact, not physical size.
- **News coverage.** GDELT answers most requests with HTTP 429 (even from a residential IP; Render's shared address makes it worse); The Guardian needs a key; GDACS media lists are noisy. The panel may be thin or stale for hours, and the relevance rules are word-based, so some off-topic articles get through and some relevant ones are dropped.
- **E-mail.** Until the project has its own sending domain, Resend's test mode delivers only to the Resend account owner's address; other users see the switch but their e-mails fail. There is no SMS or push channel.

---

## Features

### 1) Multi-source disaster feed (NASA EONET + USGS)
- **USGS** earthquakes (M ≥ 4.5, last 7 days) and **NASA EONET** wildfires, floods and storms.
- Heterogeneous responses are normalized into one model (`type`, `severity`, `title`, `lat`/`lng`, `country`, `occurredAt`, source ids).
- 5-minute server-side cache per source; the two sources are fetched independently, so one failing source degrades the feed instead of killing it (see [Feed contract](#feed-contract-get-disasters)).
- Pagination and marker caps keep the map responsive: the map shows the 15 strongest earthquakes of the feed page, and when a week has more quakes than the page has room for, the page keeps the strongest, not the newest.

### 2) Live dashboard (map + feed + KPIs)
- Interactive world map (Leaflet) with severity-coloured markers and an event detail drawer (related news, USGS PAGER alert level, EONET sources).
- Nearby events are grouped into numbered clusters (supercluster, `src/utils/clustering.ts`) coloured by event type like the markers: one solid colour when a single type is inside, a ring split proportionally to the type counts for a mix, with the count on a dark disc. Clusters are sized logarithmically and carry a "7 events · 6 wildfires, 1 flood · highest: High" tooltip (severity lives in the tooltip, not in the colour); clicking zooms to the cluster's bounds, or fans the events out when they share coordinates (spiderfy). The selected event is always drawn on its own, on top, so it never disappears inside a cluster.
- Live feed with filters (earthquake / wildfire / flood / storm), search by place, sorting by newest or severity.
- KPIs: total events, significant events (high + medium severity), countries affected (derived by the backend from the source place names; events whose country cannot be derived, e.g. "North Atlantic Ocean", are not counted).
- Honest states: a skeleton while loading, a per-source note when one source is down, the last good feed flagged STALE when a refresh fails, an explicit error state with "Try again" when nothing is cached. There are no demo or fallback events anywhere.

### 3) Severity from the source (LOW / MEDIUM / HIGH, or NOT RATED)
- Decided in `backend/src/utils/severity.js` (the single source of truth; the explanation sentence is generated from the same rules):
  - **earthquake:** rounded magnitude ≥ 6.0 high, 5.0–5.9 medium, < 5.0 low
  - **wildfire and flood: the GDACS impact level is primary** (Red → high, Orange → medium, Green → low). GDACS, the source behind every non-US fire and every flood in EONET, publishes its own impact level per event; the backend looks it up on gdacs.org by the event id in EONET's source link (see [Severity](#severity)).
  - **wildfire without a GDACS level** (US/IRWIN fires, GDACS unreachable): burned area normalised to hectares (`hectare` as is, `acres` × 0.40469): ≥ 10,000 ha high, 7,000–9,999 ha medium, < 7,000 ha low
  - **storm:** Saffir-Simpson on the **peak** advisory wind of the event (highest `magnitudeValue` of the series): ≥ 96 kts high (category 3+), 64–95 kts medium (category 1–2), < 64 kts low; the current wind is shown next to the peak ("Peaked 135 kts (Cat-4), now 55 kts")
  - flood without a GDACS level, no value, unknown unit: **not rated** (`unrated`, "Not rated: the source reports no intensity for this event")
  - manual (admin) entries keep the severity the admin chose (low / medium / high, never unrated)
- Shown as badges in the feed, in the map tooltip and in the drawer, each with the reason sentence and the GDACS attribution where it applies. Not-rated events sort last and wear a neutral stone-grey pill, distinct from the storm marker grey. The **"Significant events"** KPI counts high + medium (never not-rated); it is unrelated to the users' alert subscriptions.

### 4) News linked to events
- GDELT and The Guardian (optional) are searched for the most important feed events, and GDACS media news is listed per GDACS event; articles are linked to events on our side, placed in a country and region, and shown in the news panel (hazard and region filters) and the event drawer ("Show on map", "Related news"). Details in [News](#news).

### 5) Accounts, alerts and notifications
- Cookie-based sessions (JWT in an `httpOnly` cookie), registration and login with rate limiting.
- **Alert subscriptions:** hazard type (or any), minimum severity, a centre point and a radius in km. Minimum `low` means every event, including not-rated ones; `medium` and `high` never match a not-rated event.
- **Notifications:** new events that match a subscription appear in the bell in the header (polled every 60 s).
- **E-mail alerts (opt-in):** off by default; a switch with the consent text on the Alerts page turns them on. One summary e-mail per user per run, a daily limit, one-click unsubscribe ([E-mail alerts](#e-mail-alerts)).
- **Privacy and deletion:** a plain-language privacy page (`/privacy`, linked from the footer of every content page and from sign-up) lists what is stored, who processes it (Render, Neon, Resend), how long it is kept and how to delete it. On *My account* a user deletes their own account after entering the password again; subscriptions and notifications go with it, the e-mail records are anonymised. An `ADMIN_EMAILS` address confirms only while signed in to its account (so whoever registered the owner's address first cannot become admin through the owner's click).

### 6) Admin console
- Accounts whose e-mail is listed in `ADMIN_EMAILS` **and confirmed while signed in** get the `admin` role: the double opt-in link of the e-mail alerts, opened in a browser that is signed in to that account, sets `emailConfirmedSignedInAt` (password and mailbox proven together). Registering does not prove an address and a click on the link proves only the mailbox, so a new account, or one confirmed without its session, is never an admin, not even when its address is added to the list later. The role is worked out on every request, so a list change applies to open sessions at once. To become admin: register the listed address, sign in, turn e-mail alerts on, open the confirmation link in the same browser (alerts can be turned off again afterwards). Admins can list, disable, enable and delete users, read the audit log (every admin action is written in the same transaction as the action), create manual disaster entries and publish a test event to Kafka.

### 7) Event-driven architecture (Kafka)
- The backend records new NASA/USGS events in an outbox table and publishes them to the topic `disaster-events`; the notification service consumes them and creates notifications. At-least-once delivery, at most one notification per user and event. Details in [Event-driven notification pipeline](#event-driven-notification-pipeline).

### 8) Dockerized services
- `frontend` (React build served by Nginx, which also proxies `/api`), `backend` (Node.js + Express + Prisma), `db` (PostgreSQL 16), `dw-kafka` + `zookeeper` (Confluent 7.6.1), `notification` (Kafka consumer). One Compose file, one command.

---

## Quick start (Docker Compose)

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Docker with Compose v2 | Docker Desktop 4.x or Docker Engine 24+ (`docker compose version` works) | the only hard requirement |
| Git | any | |
| Node.js | `24.13.0` (`.nvmrc`) | only for running services or tests outside Docker |

Ports used on the host: **8080** (frontend), **5000** (backend), **5432** (PostgreSQL), **9092 / 29092** (Kafka), **2181** (Zookeeper). Stop anything else listening there first.

### 1) Clone and create the backend env file

```bash
git clone https://github.com/OrhanIzmirli/DisasterWatch.git
cd DisasterWatch
cp backend/.env.example backend/.env
```

`backend/.env.example` ships with a **dev-only `JWT_SECRET` placeholder** that the server accepts only with `NODE_ENV=development` (which Compose sets for the local stack); in production it is rejected, so generate a real one before any deployment (see [Environment variables](#environment-variables)). To get an admin account, put your e-mail in `ADMIN_EMAILS` in `backend/.env` before registering.

### 2) Build and start

```bash
docker compose up --build
```

First start takes a few minutes (image pulls + `npm ci`). What happens:

1. `db` starts and passes its health check; `zookeeper` and `dw-kafka` start, the broker passes its health check.
2. `backend` runs `prisma db push` against the database (creates the tables on a fresh volume, no-op afterwards) and then starts the API. It logs `Backend listening on port 5000`, then `Kafka producer initialized`, then the first ingestion run.
3. `notification` connects to the database and to Kafka and logs `Notification service listening on topic: disaster-events`.
4. `frontend` serves the built app on port 8080 and proxies `/api/*` to the backend.

### 3) Open it

| URL | What you get |
|---|---|
| http://localhost:8080 | the app |
| http://localhost:8080/api/health | backend health through the Nginx proxy |
| http://localhost:8080/api/disasters | the normalized feed |
| http://localhost:5000/health | backend directly |

Register at http://localhost:8080/signup (any e-mail, password 8+ characters). Set up an alert on the Alerts page; the bell fills up when a new matching event arrives (events older than 48 hours never notify).

### Stop, reset

```bash
docker compose down          # stop, keep the database volume
docker compose down -v       # stop and delete the database volume (fresh start next time)
```

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

## Tests and CI

| Suite | Command | Needs |
|---|---|---|
| Backend (Vitest + supertest) | `cd backend && npm test` | `TEST_DATABASE_URL`, a throwaway PostgreSQL |
| Notification service (Vitest) | `cd notification-service && npm test` | nothing for the unit tests; the e-mail dispatcher tests run only with `TEST_DATABASE_URL` (schema pushed from `backend/prisma`) and are skipped otherwise |
| Frontend (Vitest + Testing Library, ESLint) | `cd disasterwatch-frontend && npm run lint && npm test && npm run build` | nothing (lint, tests, type check + production build) |

The backend suite **refuses to run against the application database**: `TEST_DATABASE_URL` must be set, must not share a host with `DATABASE_URL` (from the environment or `backend/.env`), and the target must not contain any user whose e-mail is not `@example.com`. It pushes the Prisma schema into that database and truncates the tables before every file. A throwaway database for local runs:

```bash
docker run -d --name dw-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=dwtest -p 55432:5432 postgres:16
cd backend && npx prisma generate
TEST_DATABASE_URL=postgresql://postgres:test@localhost:55432/dwtest npm test
```

`GET /disasters` (external NASA/USGS) is not covered by tests on purpose.

**CI** (`.github/workflows/ci.yml`, on every push and pull request): backend tests and notification-service tests, each against its own `postgres:16` service container, and frontend lint, tests and build. All jobs use the Node version from `.nvmrc`.

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
| `GUARDIAN_API_KEY` | no | empty | adds The Guardian as a news provider ([News](#news)) |
| `GDELT_TIMEOUT_MS` | no | `30000` | per-request timeout for GDELT searches (answers take 15–18 s) |
| `GDACS_TIMEOUT_MS` | no | `4000` | per-request timeout for GDACS impact-level lookups ([Severity](#severity)) |
| `DISABLE_GDACS` | no | – | `1` switches the GDACS lookups off (wildfires fall back to the size rule, floods are not rated) |
| `CORS_ORIGINS` | no | live frontend + `localhost:8080/5173/4173` | browser origins allowed to call the API directly; the `/api` proxy never needs it |
| `DISABLE_NEWS_JOB` | no | – | `1` switches off the background news refresh |
| `DISABLE_INGESTION` | no | – | `1` switches off the NASA/USGS ingestion job (no events reach Kafka) |
| `INGEST_WAKE_SECRET` | cloud | empty | shared secret of the scheduled wake-up (`POST /internal/ingest`, [Scheduled wake-up](#scheduled-wake-up)); **32+ characters**, same value as the GitHub Actions secret of the same name (the workflow is the only caller). Without it the endpoint does not exist |
| `TEST_DATABASE_URL` | tests | – | throwaway database for `npm test` ([Tests and CI](#tests-and-ci)) |

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

## HTTP API

All paths are relative to the backend (`http://localhost:5000`) or to the proxy (`http://localhost:8080/api`). Responses are JSON; errors are `{ message }` (or `{ ok: false, error }` for `/events`).

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /health` | – | `{ ok, service, kafka, outboxPending, ingest: { running, lastRunAt, lastTrigger, lastErrorSources, lastStats, lastWakeAt, lastWakeOutcome, eonetFallbackRecorded }, news: { provider, updatedAt, stale, articles, providers: { <name>: { articles, located, lastAttemptAt, lastSuccessAt, lastError, lastErrorKind, droppedOffTopic } }, storms }, gdacs: { disabled, cached, pending, requests, hits, failures, lastError, lastFetchAt, store }, email: { state, dailyLimit, sentLast24h, reportedAt, lastSentAt, lastError, lastErrorAt } (null when the database is unreachable), time }` |
| `GET /disasters` | – | the public feed ([contract below](#feed-contract-get-disasters)) |
| `GET /news?type=&region=&event=` | – | cached news articles, linked to feed events and placed in a region ([News](#news)) |
| `POST /users/register`, `POST /users/login`, `POST /users/logout` | – | `{ email, password }`; sets or clears the session cookie. Rate limited |
| `GET /users/me` | user | the signed-in user |
| `DELETE /users/me` | user | `{ password }`: deletes the account with its subscriptions and notifications (cascade); its e-mail delivery rows stay anonymised (no user, message or provider id; a pending one is cancelled) because the daily limit and the confirmation cap are counted from them; audit rows about it and manual entries it wrote keep only the masked address; clears the cookie. 403 wrong password; rate limited like sign-in |
| `GET /alerts`, `POST /alerts`, `PATCH /alerts/:id`, `DELETE /alerts/:id` | user | alert subscriptions (`type`, `minSeverity`, `label`, `centerLat`, `centerLng`, `radiusKm`, `active`) |
| `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` | user | in-app notifications of the signed-in user |
| `GET /alerts/email`, `PUT /alerts/email` | user | e-mail alerts of the signed-in user: `{ enabled, consentAt, channel: { state, dailyLimit, sentLast24h } }`; turning on needs `{ enabled: true, consent: true }` |
| `POST /email/unsubscribe` | – (token) | one-click unsubscribe: `?token=` (RFC 8058 form post from the mail client) or `{ token }`. Rate limited |
| `POST /email/confirm` | – (token) | double opt-in: `{ token }` from the confirmation e-mail confirms the address (single use) |
| `GET /disasters/manual`, `POST /disasters` | user / admin | manual disaster entries (stored, not published to Kafka) |
| `POST /events` | admin | validates the body against the event contract and publishes it to Kafka |
| `GET /admin/users`, `GET /admin/users/:id`, `POST /admin/users/:id/disable`, `POST /admin/users/:id/enable`, `DELETE /admin/users/:id`, `GET /admin/audit` | admin | user management and the audit log |

Authenticated routes read the user from the database on every request, so a disabled or deleted account loses access immediately.

---

## Feed contract: `GET /disasters`

Query parameters (anything outside the range is clamped; non-numeric input falls back to the default):

| Parameter | Default | Range | Meaning |
|---|---|---|---|
| `minutes` | `10080` (7 days) | 60 … 43200 | look-back window; earthquakes cover at most the last 7 days (the USGS weekly feed), so a longer window adds only NASA events |
| `limit` | `50` | 1 … 200 | maximum number of items |
| `minMag` | `4.5` | 4.5 … 10 | minimum earthquake magnitude (the USGS feed carries M 4.5+ only) |

There is **no** parameter to force a live fetch or shorten the cache: the lifetime is fixed on the server (5 minutes per source), so anonymous callers cannot turn the backend into a NASA/USGS proxy.

Response `200`:

| Field | Type | Meaning |
|---|---|---|
| `items` | array | normalized events (see below) |
| `count` | number | `items.length` |
| `counts` | object | `{ total, bySeverity: { high, medium, low, unrated }, byType: { <type>: { total, high, medium, low, unrated } } }` over the whole window, independent of `limit`; the dashboard KPIs ("Disasters", "Significant events") use it |
| `source` | string | `NASA + USGS`, `NASA` or `USGS` when live data was fetched in this call, `CACHE` when served from the 5-minute cache, `CACHE-FALLBACK` when both sources failed |
| `stale` | boolean | `true` when both sources failed and the previous feed is being served |
| `partial` | boolean | `true` when one source is missing from this answer |
| `sources` | object | `{ nasa, usgs }`, each `"ok"`, `"stale"` (last good data ≤ 60 min old is served) or `"error"` (older data was dropped) |
| `sourcesUpdatedAt` | object | `{ nasa, usgs }` ISO timestamps of each source's last good fetch (`null` when none) |
| `updatedAt` | string | ISO timestamp of the newest source data; the dashboard derives every "ago" label from it |
| `params` | object | the effective `minutesWindow`, `limit`, `minMag` after clamping |

Each item: `id`, `type` (`earthquake` | `wildfire` | `flood` | `storm`), `location`, `meta` (one-line summary), `severity` (`low` | `medium` | `high` | `unrated`), `timeMinutesAgo`, `description`, `lat`, `lng`, `country` (derived from the USGS place or the EONET title, `null` when not derivable) and `details`: source-faithful fields for the event drawer (`eventId` such as `usgs:us7000abcd`, `source`, `category`, `cleanTitle`, `place`, `occurredAt`, `updatedAt`, `status`, `sources` [{ name, url }], `magnitude`, `magnitudeLabel`, `magType`, `depthKm`, `pagerAlert`, `tsunami`, `feltReports` for USGS; `magnitudeValue`/`magnitudeUnit` as reported by EONET plus `areaHa` (wildfire area normalised to hectares), `peakKts`/`currentKts` (storms), `gdacsLevel`/`gdacsScore` (wildfires and floods rated by GDACS; `null` otherwise); `severity`, `severityReason`, `severitySource`; `locationPrecision`). An event that links to GDACS is placed at the GDACS event point; otherwise at the EONET point or polygon centroid. When the GDACS point and the EONET geometry lie more than 100 km apart, `details.locationPrecision` is `approximate` with the reason, and the drawer and e-mails show an "approximate" note.

Failure behaviour: a source that fails keeps serving its last good data while it is at most 60 minutes old; a source that has never returned data is retried after 10 seconds, otherwise after a minute. When both sources fail and nothing is cached the endpoint answers `503 { message: "Live disaster sources are not responding", retryAfterSeconds: 60 }`. Upstream error details never leave the server log.

---

## Severity

How the thresholds were derived (2026-10-15, full analysis in the review notes):

- **EONET exposes no alert level.** Its events carry only id, title, link, status, categories, sources and a geometry series with `magnitudeValue`/`magnitudeUnit`. But every GDACS-sourced event links to its GDACS report (`https://www.gdacs.org/report.aspx?eventtype=WF&eventid=…`), and GDACS's public API (`https://www.gdacs.org/gdacsapi/api/events/geteventdata?eventtype=WF&eventid=…`, no key) answers with the impact level GDACS assigned (Green / Orange / Red, based on population exposed and country capacity). In EONET's last 90 days, 915 of 1,000 wildfires and 180 of 180 floods are GDACS-sourced; storms come from JTWC/NOAA and have no GDACS key. Over the last 12 months GDACS rated 15 wildfires and 18 floods Orange or Red; the rest are Green.
- **Wildfire fallback (hectares):** 1,000 EONET fires over 90 days have a median of 5,701 ha, third quartile 7,075 ha, top decile 9,537 ha and a maximum of 43,703 ha; GDACS only lists fires from about 5,000 ha, US (IRWIN) fires are small (median 424 ha). The cut is the top decile for high (10,000 ha) and the third quartile for medium (7,000 ha), rounded: 8.5 % / 17.4 % / 74.1 % of that population.
- **Storms:** the 64 / 96 kts cut is the Saffir-Simpson hurricane / major-hurricane boundary. EONET storms are a series of advisories; the peak is rated because the latest advisory of a dissipating hurricane is a remnant (90 days: on the latest wind 0 of 42 storms are "high", on the peak 15).
- **Floods:** EONET reports no magnitude at all (0 of 180), so only the GDACS level can rate them.

**GDACS as an ingestion dependency** (`backend/src/services/gdacs.js`): one GET per GDACS event, cached per event id for 6 hours (levels move slowly), fetched 8 at a time with a 4-second timeout, failures remembered for 10 minutes. The news job waits for its lookups, the ingestion job only for those of the events it has not recorded yet (at most one timeout each). The public feed does not: it attaches the answers already known and lets the missing lookups run in the background; each answer is attached to the cached EONET events as soon as its lookup is done, so the next request shows what has arrived so far. Until then, and when GDACS is down, the events keep the EONET measurement and the drawer says "Severity rule applied to the burned area reported by EONET (no GDACS level for this fire)".

Every answer is also written to the `GdacsCache` table (key `eventtype:eventid`, level, score, affected countries, point, `fetchedAt`; batched 2 seconds after the first new answer) and loaded when the backend starts (a request waits at most 5 seconds for it; rows older than 30 days are deleted then; a failed load, e.g. while the database is still waking up, is tried again a minute later), so a restarted or woken backend starts with what it knew. Answers still waiting to be written are written on shutdown (at most 5 seconds). A stored answer older than 6 hours is still served while its refresh is pending or failing, by the feed and by the ingestion and news jobs, but never one older than 48 hours: that counts as unknown, and the EONET values apply. Without the table (migration not applied yet) the backend logs a warning and works from memory; `/health` shows only `store load failed (<Prisma code>)`, the full database message stays in the log. `GET /health` reports `gdacs: { disabled, cached, pending, requests, hits, failures, lastError, lastFetchAt, store: { loaded, saved, lastError } }`; `GDACS_TIMEOUT_MS` and `DISABLE_GDACS=1` configure it.

---

## News

`GET /news` is served from a cache that a background job refreshes (`backend/src/services/news.service.js`); requests never call a news provider themselves.

**Request budget.** Each refresh picks the ~10 most important feed events (high severity first, then newest; earthquakes only from the last 24 hours, although the feed shows 7 days), cleans their location text (`"Flood in Nepal 1104225"` → `Nepal`, `"53 km S of Kushiro, Japan"` → `Kushiro Japan`, in `newsLinking.js`) and folds them into at most **3 combined searches** (one per hazard type, the events' place words OR-ed) plus one general disaster search: **at most 4 requests per refresh**. Articles are then linked to events on our side (place words in the title or URL path, hazard words for the general search), deduplicated by URL and near-identical title, and filtered to the event's time window. That linking powers "Show on map" in the news panel and "Related news" in the event drawer.

**Providers** (`backend/src/services/newsProviders/`). Every provider runs and the panel shows their articles merged and deduplicated; each keeps its own last good share, so one that fails (429, timeout, backoff) keeps serving what it fetched before until that expires. **GDELT** DOC 2.0 (every 15 minutes, one broad request: it answers most requests with 429 and takes 15–18 s when it does answer; articles kept 72 h). **The Guardian** Open Platform when `GUARDIAN_API_KEY` is set (every 30 minutes, ≤ 4 requests, so ≤ 200 of the developer key's 500 requests/day; articles kept 24 h). **GDACS media news** (no key, every 30 minutes, articles kept 72 h): for each feed event that links to a GDACS report (EONET wildfires outside the US and floods), the Europe Media Monitor articles GDACS lists for that event, at most 25 events and 8 articles per event, spaced 0.5 s apart; these arrive linked to their event. `DISABLE_GDACS=1` switches it off together with the GDACS severity lookup. Every card says which provider it came from, and `/health` reports each provider's last attempt, last success and last error.

**Relevance.** Every article from every provider must pass the disaster-news rules (`backend/src/services/newsRelevance.js`): non-news sections and formats (sport, business, technology, opinion, culture, interactives, video, …) and review/listing headlines are dropped, as are sports listings ("vs.", "live stream"), product announcements ("tracker", "launches an app"), songs and staged hazards ("pretend typhoon"), retrospectives ("years after", "anniversary", "… after Hurricane Helene" with no impact word in the headline), historical pieces (a past 4-digit year, "N years ago", "World Series") and sports-team uses of a hazard word (a league or sport word and no impact word); idioms and names are removed before matching ("perfect storm", "storm of criticism", "Carolina Hurricanes", …); a clear hazard word in the headline keeps an article, an everyday one ("storm", "flood", "tremor") needs impact or weather context. Guardian searches are also restricted to regular articles matched on the headline and standfirst. GDACS media lists are noisy (on 2026-10-16, 30 of 45 articles were off-topic), so the same rules apply to them. The rules and the location check run again on the cached articles whenever the cache is rebuilt (including after a restart), so a rule change applies at once; a Guardian article is then dropped only by an explicit marker, since its standfirst is not cached. Article-event linking looks at the headline and the story slug only.

**Location and regions** (`backend/src/services/newsLocation.js`). Each article gets `location: { countries: ["TR"], regions: ["europe"], source }` or `null`. The country comes, in this order, from the linked feed event (its country, derived from the source place name), the article's Guardian keyword tags (`show-tags=keyword`; only the derived codes are kept), or the GDACS event it came with (its affected countries). A fixed ISO country → region table maps it to Africa, Americas, Asia, Europe, Middle East or Oceania (Türkiye under Europe; Russia by the event's longitude). GDACS media lists are noisy, so a GDACS article keeps its event's (or GDACS report's) country only when its headline or story slug names that country (name, alias, demonym), a place of the event label, or an unambiguous city of it (`backend/src/services/newsCities.js`: Istanbul → Türkiye, Padang → Indonesia; shared names such as Tripoli are left out); a city of another country contradicts it. Otherwise it stays unlocated rather than shown in a wrong country. Nothing is guessed: an article none of these place stays unlocated and is listed only under "All regions"; `?region=` never returns it. The panel's region chips are chosen by hand (no geolocation).

**Guardian licence** (developer key, non-commercial): headlines and links are passed through unchanged, Guardian cards never show an image, the "Powered by The Guardian" logo (linking to theguardian.com) is shown next to Guardian content, and Guardian rows are deleted from the cache 24 hours after they were fetched (`NewsCache.expiresAt`). No Guardian article text or article link is stored in the repository (only the logo links to the Guardian home page); the test fixture keeps the response shape with invented headlines and example.com URLs.

**Backoff.** GDELT allows one request every 5 seconds and answers violations with HTTP 429; The Guardian allows 1 request/second and 500/day. All three clients space their requests and, after any failure, back off exponentially with jitter (`backoff.js`: 30 s, 60 s, … up to 15 min, ± 25 %); calls made inside the window fail at once and send nothing, so a 429 is never retried immediately.

**Persistence.** Every successful refresh is written to the `NewsCache` table (one row per article) and loaded back when the backend starts, so a restart or a Render wake-up serves the previous articles immediately with the real `updatedAt`. A failed refresh keeps the previous articles and marks the response `stale: true`; with nothing cached at all the endpoint answers 503 and the panel shows a retry button. `stale: true` is set only when every provider that still contributes articles failed its last attempt (a rate-limited GDELT next to a fresh Guardian share is not stale). Response shape: `{ items: [{ title, url, domain, publishedAt, image, provider, relatedEvent, location }], count, updatedAt, stale, source, provider }`, filterable with `?type=`, `?region=` and `?event=`. `NewsCache.location` (added with the region filter) must exist before a backend that writes it starts: run `npm run db:push` in `backend` against the direct (non-pooler) database host before deploying.

---

## Event-driven notification pipeline

```
NASA EONET ──┐                                   ┌─> AlertSubscription rules
             ├─> backend ingestion job (5 min) ──┤   (type, min severity, radius)
USGS ────────┘   IngestedEvent (ON CONFLICT      │
                 DO NOTHING) -> only NEW events  ▼
                 ──publish──> Kafka topic ──> notification-service ──> Notification table
                              disaster-events    (consumer, pg)          │
Admin POST /events ──validate contract──┘                                ▼
                                                     backend GET /notifications ──> header bell
```

1. **Ingestion (backend, `src/jobs/ingest.js`)** runs at start-up and every 5 minutes: fetches NASA EONET and USGS (M ≥ 4.5, last 7 days), maps them to the event contract and inserts into `IngestedEvent` with `ON CONFLICT DO NOTHING` (`publishedAt = NULL`). It then drains the **outbox**: unpublished rows, oldest first, up to 500 per run, are published and marked `publishedAt`. The public `GET /disasters` feed is a separate path and is not affected.
2. **Kafka topic `disaster-events`** carries one JSON message per event (contract below).
3. **notification-service** validates each message, loads active `AlertSubscription` rows and creates a `Notification` when the rule matches (type is `any` or equal, event severity ≥ `minSeverity` where `unrated` ranks below `low` and is matched only by `minSeverity: "low"`, haversine distance ≤ `radiusKm`), the event is at most 48 h old and the subscription was created before the event. Inserts are `ON CONFLICT (userId, eventId) DO NOTHING`; invalid messages are logged and skipped, database errors make Kafka redeliver the message.
4. **Backend API** `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` (all scoped to the signed-in user) feed the **bell in the header**, which polls every 60 s.

Admin entries from `POST /disasters` are stored but **not** published; a verification step for manual entries comes in a later release. Admins can publish a test event with `POST /events`.

### Event contract (v1)

Defined in `backend/src/events/contract.js` and `notification-service/src/contract.js` (kept identical; both validate with zod).

| Field | Type | Notes |
|---|---|---|
| `v` | `1` | contract version |
| `eventId` | string | stable id from the source, `source:id` with `[A-Za-z0-9_.-]`: `nasa:EONET_1234`, `usgs:us7000abcd`, `manual:42` |
| `source` | `nasa` \| `usgs` \| `manual` | |
| `type` | string | lower-case hazard type, 1–40 chars: `earthquake`, `flood`, `wildfire`, `storm` |
| `severity` | `low` \| `medium` \| `high` \| `unrated` | `unrated` was added on 2026-10-15 as an additive v1 change: no GDACS level and no measurement (floods without a level, fires/storms without a value). Manual events are never unrated |
| `title` | string | 1–200 chars |
| `lat`, `lng` | number | WGS84 |
| `occurredAt` | string | ISO-8601 with timezone |

```json
{ "v": 1, "eventId": "usgs:us7000abcd", "source": "usgs", "type": "earthquake",
  "severity": "high", "title": "M6.1 earthquake, 12 km E of Izmit, Turkey",
  "lat": 40.77, "lng": 30.0, "occurredAt": "2026-10-13T23:40:00.000Z" }
```

### Reliability

- **Transactional outbox (producer).** Recording an event and publishing it are separate steps. `IngestedEvent.publishedAt` stays `NULL` until Kafka has accepted the message; a failed send (broker asleep, timeout) leaves the rows untouched and the next run retries them, so no event is lost. `GET /health` reports the number of rows still waiting as `outboxPending`.
- **Idempotent consumer.** Notifications are inserted with `ON CONFLICT (userId, eventId) DO NOTHING`, so a message delivered twice (a retried publish, a Kafka redelivery after a consumer error) produces exactly one notification.
- Together: **at-least-once delivery, at most one notification per user and event.**

### Scheduled wake-up

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

### E-mail alerts

Opt-in per user: `User.emailAlertsEnabled` is `false` until the user turns the switch on the Alerts page on; the request must carry `consent: true` and the consent time is stored. **Double opt-in:** registration does not verify addresses, so the first e-mail to an address is a confirmation link only (fixed text, nothing a user typed); alert e-mails start after its owner opened `/confirm-email` and pressed the button (`User.emailVerifiedAt`). Only notifications created after the consent are e-mailed, at most 24 hours after they were created.

The notification service (`src/email/`) sends, after a burst of new notifications (20 s debounce, at most 2 minutes) and every 10 minutes for retries, **one summary e-mail per user** with all of that user's new notifications (a user whose previous digest is still being retried waits for it). Claims run in one transaction under a transaction-level advisory lock (it also works through the Neon pooler); each send takes a short lease on its delivery row, so two instances never send the same digest.

- **Daily limit** (`EMAIL_DAILY_LIMIT`, default 90 per rolling 24 h; Resend free: 100/day; confirmation e-mails count too) counted from the `EmailDelivery` table (sent, pending, and failed ones that reached the provider), not from memory, since the service sleeps and restarts. Over the limit the notification is marked `emailSkipReason = "daily-limit"`; the in-app notification exists anyway.
- **Never twice:** a digest is a `pending` `EmailDelivery` row before the send; a notification belongs to at most one digest. `emailSentAt` is written only after Resend accepted the e-mail. The message is rendered once and stored with the delivery; a transient failure (network, 429, 5xx, Resend's 409 "concurrent request") leaves it pending and the next run sends the identical payload with the same `Idempotency-Key`, so a send that did go out is not repeated; other 4xx, 5 failures or 23 hours (Resend keeps keys 24 h) mark it failed (`send-failed`).
- **Content:** per event the title, type, severity, source, time (UTC), location with the map's "approximate" note, and a link to the event on the map; below, which alert matched, the alert settings link and the unsubscribe link. Plain text + HTML, only data from our database: no third-party text, no images, no tracking pixel.
- **Unsubscribe:** every e-mail has a link to `/unsubscribe?token=…` (no sign-in; one button press switches e-mail off and the page confirms it; opening the page changes nothing, so link scanners, even ones that run JavaScript, cannot unsubscribe anyone) and the headers `List-Unsubscribe: <APP_URL/api/email/unsubscribe?token=…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). The token is 32 random bytes, kept across opt-ins.
- **Honest status:** the service writes `EmailChannelStatus` on start and after every run; the Alerts page shows e-mail as "active" only when the service reports it configured (within 3 hours), and says when the daily limit is used up. `/health` of both services shows the e-mail status (configured, sent in the last 24 h, last error); no addresses. Logs mask addresses (`som***@example.com`).

### Operational notes

The user-facing limits (alerts hours late, free tiers, source coverage) are listed under [Limits](#limits).

- **Sleeping services catch up.** While the backend sleeps no ingestion runs and nothing is published; while the notification service sleeps nothing is consumed. Both catch up when they wake: Kafka keeps the messages, so the consumer resumes from its committed offset. With the broker powered off the backend keeps serving the public feed and events wait in the outbox.
- Events older than 48 hours and subscriptions created after an event never produce notifications, by design.
- **GDELT rate limits by source IP.** The news job backs off and keeps serving GDELT's last articles (72 h) next to The Guardian and GDACS media; `/health` → `news.providers.gdelt` shows the last success and error.
- **Deploy order: notification-service first, then the backend.** A consumer running an older build rejects messages with a value it does not know (such as `severity: "unrated"`) and commits their offsets, so those events never produce notifications unless the group offset is reset. On Render: 1) deploy the `notification-service` web service and wait for its `/health` to answer with `kafka: "connected"`; 2) only then deploy the backend. With auto-deploy from `main` on both services, suspend the backend's auto-deploy before merging a contract change, merge, let the notification-service build finish, then deploy the backend manually.

### Future work

- The "subscription must predate the event" rule compares against `occurredAt`; for long-running EONET events (a wildfire first seen days after it started) it should compare against the time the event entered the system so such events can still notify.
- Pre-filter subscriptions in SQL with a bounding box around the event before the haversine check, instead of loading every active subscription per message.
- An own sending domain for e-mail (Resend DNS records), so alerts reach every confirmed address.
- Password reset by e-mail.
- News: when the cache is empty and every provider failed, retry after a couple of minutes instead of waiting the full refresh interval; keep the first real provider error in `lastError` instead of the local backoff refusal that follows it.
- WebSocket live updates, SMS / push channels, metrics and tracing.

---

## Kafka demo (send a test event)

The consumer only accepts messages that follow the [event contract](#event-contract-v1) and only matches events that are at most 48 hours old, so the payload carries the current time. From the repository root, with the stack running:

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "{\"v\":1,\"eventId\":\"manual:demo-1\",\"source\":\"manual\",\"type\":\"earthquake\",\"severity\":\"high\",\"title\":\"Demo earthquake near Warsaw\",\"lat\":52.23,\"lng\":21.01,\"occurredAt\":\"$NOW\"}" \
| docker compose exec -T dw-kafka bash -lc "kafka-console-producer --bootstrap-server localhost:9092 --topic disaster-events"
```

Then check the consumer output:

```bash
docker compose logs notification
```

```
[consumer] manual:demo-1 (earthquake/high): 1 active subscription(s), 1 match(es), 1 notification(s) created
```

With no subscription within range the line ends in `0 match(es), 0 notification(s) created`. A message that violates the contract is logged as `[consumer] skipping message: <field>: <reason>` and skipped. To see a notification in the UI, sign in, create an alert on the Alerts page (type earthquake or any, minimum severity ≤ high, a centre within the radius of 52.23, 21.01), then send the message: a subscription only matches events that occurred after it was created, so the message has to be sent after the alert, not in the same second. The bell polls every 60 s; `GET /api/notifications` shows the row at once. The same payload can be sent as an admin with `POST /api/events` (JSON body, session cookie).

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

## Repository layout

```
.github/workflows/ci.yml     backend tests, notification-service tests, frontend lint + tests + build
.github/workflows/wake.yml   scheduled wake-up of the Render services (hourly on paper, every few hours in practice)
.nvmrc                       Node 24.13.0 (also in every package.json "engines", Dockerfile and CI)
docker-compose.yml           db, zookeeper, dw-kafka, backend, notification, frontend
backend/                     Express API, Prisma schema, ingestion + news jobs, Kafka producer, tests
  src/app.js                 the Express app (routes, CORS allow-list, helmet, JSON errors)
  src/index.js               entry point: HTTP server, news job, producer, ingestion
  src/events/contract.js     event contract v1 (zod)
  src/services/              feed (NASA/USGS cache), news providers, Kafka producer
  prisma/schema.prisma       User, AlertSubscription, Notification, IngestedEvent, EmailDelivery, EmailChannelStatus, NewsCache, GdacsCache, AdminAuditLog, Disaster
  tests/                     Vitest suites (TEST_DATABASE_URL only)
notification-service/        Kafka consumer: contract, matcher, pg writes, /health; e-mail dispatcher (src/email/); tests
disasterwatch-frontend/      React + TypeScript + Vite app, Nginx config for the Docker image (own README)
screenshots/                 README images
CONTRIBUTING.md              branch, review and no-risk-zone rules
```

Security notes: `.env` files are git-ignored and docker-ignored, only `.env.example` files are committed; sessions are `httpOnly` cookies (Secure in production); the API sends security headers (helmet), echoes only allow-listed CORS origins, limits JSON bodies to 100 kB and rate-limits registration and login.

---

## Screenshots

Captured on the first build (2026-03-09); the layout has been refined since, the behaviour is the same.

| | |
|---|---|
| **Dashboard** – KPIs, map, live feed<br>![Dashboard](screenshots/01-dashboard.png) | **Backend health through the proxy**<br>![API Health](screenshots/02-api-health.png) |
| **Normalized feed** (`/api/disasters`)<br>![API Disasters](screenshots/03-api-disasters.png) | **Feed, alternative capture**<br>![API Disasters Alt](screenshots/03-api-disasters-alt.png) |
| **All services up** (`docker compose ps`)<br>![Docker Compose PS](screenshots/04-compose-ps.png) | **Consumer receives an event**<br>![Kafka Event Received](screenshots/05-kafka-event-received.png) |
| **Topic exists** (`disaster-events`)<br>![Kafka Topics](screenshots/06-kafka-topics.png) | **Filter: earthquakes**<br>![Filter Earthquakes](screenshots/07-filter-earthquakes.png) |
| **Filter: wildfires**<br>![Filter Wildfires](screenshots/08-filter-wildfires.png) | **Search by country or city**<br>![Search](screenshots/09-search-country.png) |
| **Sort: newest**<br>![Sort Newest](screenshots/10-sort-newest.png) | **Sort: severity**<br>![Sort Severity](screenshots/10-sort-severity.png) |
| **Severity badges**<br>![Severity Badges](screenshots/11-severity-badges.png) | **Marker popup**<br>![Map Popup](screenshots/12-map-popup.png) |

---

## Tech stack

- **Frontend:** React 19, TypeScript, Vite 7, Leaflet / react-leaflet, React Router
- **Backend:** Node.js 24, Express 5, Prisma 6, Zod, helmet, express-rate-limit, KafkaJS
- **Notification service:** Node.js 24, KafkaJS, `pg`, Zod
- **Infra:** Docker, Docker Compose, Nginx, PostgreSQL 16, Confluent Kafka 7.6.1
- **Cloud (optional):** Render, Neon, Aiven, Resend
- **Tests / CI:** Vitest, supertest, Testing Library, ESLint, GitHub Actions

---

## Changelog

**2026-10-26**
- Scheduled wake-up: `POST /internal/ingest` answers within 60 seconds (202 while a long run goes on, the workflow follows it on `/health`); the ingestion job rates only the EONET events it has not recorded yet instead of refreshing every lookup of the last 30 days. Every backup run that cold-started the backend had failed on a 90-second timeout before.
- Scheduler: GitHub's scheduled workflow is the only wake-up (the external cron service was dropped: Render's edge refused its requests to a sleeping service, `hibernate-wake-error`); it runs every few hours in practice, so the Alerts page and this README say that alerts can be hours late. The e-mail channel counts as "unknown" after 12 hours without a report (was 3).

**2026-10-23**
- The public feed no longer waits for GDACS after a restart: known levels come from the new `GdacsCache` table, missing lookups finish in the background. First `/disasters` after a cold start, measured locally: 257 s before, 4–8 s after (bounded by the EONET download).
- Earthquakes: USGS weekly M 4.5+ feed (was the last 24 hours), the same window as the rest of the feed; the map's earthquake cap and a full feed page keep the strongest quakes.
- README brought up to date for the first public version: live link, architecture, methodology summary and the limits of the free setup and of the sources.

**2026-10-14 – 2026-10-21**
- Severity from the source (GDACS impact level, Saffir-Simpson on the peak wind, burned area, not rated), GDACS point as the event location, event clustering on the map, phone layout.
- News from GDELT, The Guardian and GDACS media with relevance rules, event linking and regions.
- Scheduled wake-up (`POST /internal/ingest`), opt-in e-mail alerts with double opt-in and one-click unsubscribe, privacy page, self-service account deletion, admin only for an address confirmed while signed in.

**2026-10-15**
- Clone-and-run verified on a fresh clone with deleted volumes: the backend container now runs `prisma db push` before starting, the notification service gets `DATABASE_URL`, and `backend/.env.example` ships a dev-only `JWT_SECRET` placeholder instead of the rejected `CHANGE_ME`.
- Node pinned to 24.13.0 (`.nvmrc`, `engines`, Dockerfiles, CI); images install with `npm ci`.
- README rewritten to match the code (env tables for all three services, HTTP API, feed contract, valid Kafka demo payload); `.env.example` for every service; frontend README, page title, favicon, meta description and `robots.txt`.
- Dead files removed (old demo routes and components, root `package.json`, `event.json`, unused CSS).

**2026-10-07**
- Azure Container Apps + ACR was the initial deployment plan; it was dropped because of cost and operational complexity in favour of a free-tier stack: Render, Neon and Aiven.
- Added `.dockerignore` files for the backend and notification service to keep the build context and images lean.

---

## Author

Orhan Izmirli — Computer Science student (Poland). Project focus: full-stack development, event-driven architecture, distributed systems and cloud-ready deployments.
