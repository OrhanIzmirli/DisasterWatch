# DisasterWatch

[![CI](https://github.com/OrhanIzmirli/DisasterWatch/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/OrhanIzmirli/DisasterWatch/actions/workflows/ci.yml)

A real-time disaster monitoring platform. The backend aggregates **NASA EONET** and **USGS** into one feed, rates every event LOW / MEDIUM / HIGH, links news articles to events, and streams new events through **Kafka** to a notification service that matches them against users' location-based alert rules. The React frontend shows everything on a live map with a feed, news panel, alert subscriptions, in-app notifications and an admin console.

The whole stack runs on localhost with one `docker compose up`; the same images run in the cloud (Render + Neon + Aiven, free tiers).

---

## Contents

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

## Features

### 1) Multi-source disaster feed (NASA EONET + USGS)
- **USGS** earthquakes (M ≥ 4.5 by default) and **NASA EONET** wildfires, floods and storms.
- Heterogeneous responses are normalized into one model (`type`, `severity`, `title`, `lat`/`lng`, `country`, `occurredAt`, source ids).
- 5-minute server-side cache per source; the two sources are fetched independently, so one failing source degrades the feed instead of killing it (see [Feed contract](#feed-contract-get-disasters)).
- Pagination and marker caps keep the map responsive.

### 2) Live dashboard (map + feed + KPIs)
- Interactive world map (Leaflet) with severity-coloured markers and an event detail drawer (related news, USGS PAGER alert level, EONET sources).
- Nearby events are grouped into numbered clusters (supercluster, `src/utils/clustering.ts`) coloured by the highest severity inside, sized logarithmically, with a "7 events · 6 wildfires, 1 flood · highest: High" tooltip; clicking zooms to the cluster's bounds, or fans the events out when they share coordinates (spiderfy). The selected event is always drawn on its own, on top, so it never disappears inside a cluster.
- Live feed with filters (earthquake / wildfire / flood / storm), search by place, sorting by newest or severity.
- KPIs: total events, high-severity alerts, countries affected (derived by the backend from the source place names; events whose country cannot be derived, e.g. "North Atlantic Ocean", are not counted).
- Honest states: a skeleton while loading, a per-source note when one source is down, the last good feed flagged STALE when a refresh fails, an explicit error state with "Try again" when nothing is cached. There are no demo or fallback events anywhere.

### 3) Severity scoring (LOW / MEDIUM / HIGH)
- Earthquakes by rounded magnitude, EONET events by hazard type. Shown as badges in the feed and on the map.

### 4) News linked to events
- GDELT (primary) and The Guardian (optional fallback) are searched for the most important feed events; articles are linked to events on our side and shown in the news panel and the event drawer ("Show on map", "Related news"). Details in [News](#news).

### 5) Accounts, alerts and notifications
- Cookie-based sessions (JWT in an `httpOnly` cookie), registration and login with rate limiting.
- **Alert subscriptions:** hazard type (or any), minimum severity, a centre point and a radius in km.
- **Notifications:** new events that match a subscription appear in the bell in the header (polled every 60 s). Delivery is in-app only.

### 6) Admin console
- Accounts whose e-mail is listed in `ADMIN_EMAILS` get the `admin` role. Admins can list, disable, enable and delete users, read the audit log (every admin action is written in the same transaction as the action), create manual disaster entries and publish a test event to Kafka.

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

`backend/.env.example` ships with a **dev-only `JWT_SECRET` placeholder**; change it before exposing the app to anyone (see [Environment variables](#environment-variables)). To get an admin account, put your e-mail in `ADMIN_EMAILS` in `backend/.env` before registering.

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
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/disasterwatch KAFKA_BROKER=localhost:29092 NODE_ENV=development npm run dev
```

The other variables come from `backend/.env` (`dotenv`). `NODE_ENV=development` keeps the session cookie non-Secure for plain http.

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
| Backend (Vitest + supertest, 17 files) | `cd backend && npm test` | `TEST_DATABASE_URL`, a throwaway PostgreSQL |
| Notification service (Vitest, pure unit tests) | `cd notification-service && npm test` | nothing |
| Frontend | `cd disasterwatch-frontend && npm run build` | nothing (type check + production build) |

The backend suite **refuses to run against the application database**: `TEST_DATABASE_URL` must be set, must not share a host with `DATABASE_URL` (from the environment or `backend/.env`), and the target must not contain any user whose e-mail is not `@example.com`. It pushes the Prisma schema into that database and truncates the tables before every file. A throwaway database for local runs:

```bash
docker run -d --name dw-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=dwtest -p 55432:5432 postgres:16
cd backend && npx prisma generate
TEST_DATABASE_URL=postgresql://postgres:test@localhost:55432/dwtest npm test
```

`GET /disasters` (external NASA/USGS) is not covered by tests on purpose.

**CI** (`.github/workflows/ci.yml`, on every push and pull request): backend tests against a `postgres:16` service container, notification-service tests, frontend build. All jobs use the Node version from `.nvmrc`.

---

## Environment variables

Every service has a `.env.example` next to its code. Docker Compose sets the container-specific values (`DATABASE_URL`, `KAFKA_BROKER`, `NODE_ENV`, `PORT`) itself; `backend/.env` is loaded on top via `env_file` and is the place for secrets and optional keys.

### Backend (`backend/.env.example`)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | – | PostgreSQL connection string (Prisma). Compose sets the in-network value |
| `JWT_SECRET` | yes | dev placeholder | signs session tokens. **32+ characters**; with `NODE_ENV=production` the server refuses to start when it is missing, shorter or the literal `CHANGE_ME`. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| `JWT_EXPIRES_IN` | no | `1d` | token lifetime; keep in line with the 24 h cookie |
| `COOKIE_NAME` | no | `dw_session` | session cookie name |
| `ADMIN_EMAILS` | no | empty | comma-separated e-mails that get the `admin` role (case-insensitive). Synced on every login: added → promoted, removed → demoted. There is no other way to become admin |
| `NODE_ENV` | no | – | `production` enables the Secure cookie flag and the strict `JWT_SECRET` check; `test` disables the background jobs |
| `PORT` | no | `5000` | HTTP port (Render provides it) |
| `KAFKA_BROKER` | no | `dw-kafka:9092` | broker(s), comma-separated. `KAFKA_BROKERS` and `KAFKA_BOOTSTRAP_SERVERS` are accepted as aliases |
| `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD` | cloud | empty | when both are set the client connects with SASL_SSL (Aiven). One without the other is a configuration error |
| `KAFKA_SASL_MECHANISM` | no | `scram-sha-256` | `plain`, `scram-sha-256` or `scram-sha-512` |
| `KAFKA_SSL_CA` | cloud | empty | CA certificate (PEM) for providers with a private CA; `\n` accepted for newlines |
| `GUARDIAN_API_KEY` | no | empty | enables The Guardian as the fallback news provider ([News](#news)) |
| `GDELT_TIMEOUT_MS` | no | `8000` | per-request timeout for GDELT searches |
| `CORS_ORIGINS` | no | live frontend + `localhost:8080/5173/4173` | browser origins allowed to call the API directly; the `/api` proxy never needs it |
| `DISABLE_NEWS_JOB` | no | – | `1` switches off the background news refresh |
| `DISABLE_INGESTION` | no | – | `1` switches off the NASA/USGS ingestion job (no events reach Kafka) |
| `TEST_DATABASE_URL` | tests | – | throwaway database for `npm test` ([Tests and CI](#tests-and-ci)) |

### Notification service (`notification-service/.env.example`)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | – | the app database: reads `AlertSubscription`, writes `Notification` (plain `pg`, no Prisma). The service exits without it |
| `KAFKA_BROKER` | no | `dw-kafka:9092` | broker(s); same aliases as the backend |
| `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`, `KAFKA_SASL_MECHANISM`, `KAFKA_SSL_CA` | cloud | – | as for the backend |
| `PORT` | no | `3000` | health-check port (`GET /health`) |
| `NODE_ENV` | no | – | informational |

### Frontend (`disasterwatch-frontend/.env.example`)

The frontend reads **no** environment variables. It calls relative `/api/...` paths, which are rewritten to the backend by Nginx (Docker), by the Vite dev server (`vite.config.ts`) and by a Render rewrite rule (cloud).

---

## HTTP API

All paths are relative to the backend (`http://localhost:5000`) or to the proxy (`http://localhost:8080/api`). Responses are JSON; errors are `{ message }` (or `{ ok: false, error }` for `/events`).

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /health` | – | `{ ok, service, kafka, outboxPending, news: { provider, updatedAt, stale, articles }, time }` |
| `GET /disasters` | – | the public feed ([contract below](#feed-contract-get-disasters)) |
| `GET /news?type=&event=` | – | cached news articles linked to feed events ([News](#news)) |
| `POST /users/register`, `POST /users/login`, `POST /users/logout` | – | `{ email, password }`; sets or clears the session cookie. Rate limited |
| `GET /users/me` | user | the signed-in user |
| `GET /alerts`, `POST /alerts`, `PATCH /alerts/:id`, `DELETE /alerts/:id` | user | alert subscriptions (`type`, `minSeverity`, `label`, `centerLat`, `centerLng`, `radiusKm`, `active`) |
| `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` | user | in-app notifications of the signed-in user |
| `GET /disasters/manual`, `POST /disasters` | user / admin | manual disaster entries (stored, not published to Kafka) |
| `POST /events` | admin | validates the body against the event contract and publishes it to Kafka |
| `GET /admin/users`, `GET /admin/users/:id`, `POST /admin/users/:id/disable`, `POST /admin/users/:id/enable`, `DELETE /admin/users/:id`, `GET /admin/audit` | admin | user management and the audit log |

Authenticated routes read the user from the database on every request, so a disabled or deleted account loses access immediately.

---

## Feed contract: `GET /disasters`

Query parameters (anything outside the range is clamped; non-numeric input falls back to the default):

| Parameter | Default | Range | Meaning |
|---|---|---|---|
| `minutes` | `10080` (7 days) | 60 … 43200 | look-back window |
| `limit` | `50` | 1 … 200 | maximum number of items |
| `minMag` | `4.5` | 0 … 10 | minimum earthquake magnitude (USGS) |

There is **no** parameter to force a live fetch or shorten the cache: the lifetime is fixed on the server (5 minutes per source), so anonymous callers cannot turn the backend into a NASA/USGS proxy.

Response `200`:

| Field | Type | Meaning |
|---|---|---|
| `items` | array | normalized events (see below) |
| `count` | number | `items.length` |
| `source` | string | `NASA + USGS`, `NASA` or `USGS` when live data was fetched in this call, `CACHE` when served from the 5-minute cache, `CACHE-FALLBACK` when both sources failed |
| `stale` | boolean | `true` when both sources failed and the previous feed is being served |
| `partial` | boolean | `true` when one source is missing from this answer |
| `sources` | object | `{ nasa, usgs }`, each `"ok"`, `"stale"` (last good data ≤ 60 min old is served) or `"error"` (older data was dropped) |
| `sourcesUpdatedAt` | object | `{ nasa, usgs }` ISO timestamps of each source's last good fetch (`null` when none) |
| `updatedAt` | string | ISO timestamp of the newest source data; the dashboard derives every "ago" label from it |
| `params` | object | the effective `minutesWindow`, `limit`, `minMag` after clamping |

Each item: `id`, `type` (`earthquake` | `wildfire` | `flood` | `storm`), `location`, `meta` (one-line summary), `severity` (`low` | `medium` | `high`), `timeMinutesAgo`, `description`, `lat`, `lng`, `country` (derived from the USGS place or the EONET title, `null` when not derivable) and `details`: source-faithful fields for the event drawer (`eventId` such as `usgs:us7000abcd`, `source`, `category`, `cleanTitle`, `place`, `occurredAt`, `updatedAt`, `status`, `sources` [{ name, url }], `magnitude`, `magnitudeLabel`, `magType`, `depthKm`, `pagerAlert`, `tsunami`, `feltReports` for USGS; `magnitudeValue`/`magnitudeUnit` for EONET; `severity`, `severityReason`, `severitySource`). Polygon events (GDACS floods) are placed at the polygon centroid.

Failure behaviour: a source that fails keeps serving its last good data while it is at most 60 minutes old; a source that has never returned data is retried after 10 seconds, otherwise after a minute. When both sources fail and nothing is cached the endpoint answers `503 { message: "Live disaster sources are not responding", retryAfterSeconds: 60 }`. Upstream error details never leave the server log.

---

## News

`GET /news` is served from a cache that a background job refreshes (`backend/src/services/news.service.js`); requests never call a news provider themselves.

**Request budget.** Each refresh picks the ~10 most important feed events (high severity first, then newest), cleans their location text (`"Flood in Nepal 1104225"` → `Nepal`, `"53 km S of Kushiro, Japan"` → `Kushiro Japan`, in `newsLinking.js`) and folds them into at most **3 combined searches** (one per hazard type, the events' place words OR-ed) plus one general disaster search: **at most 4 requests per refresh**. Articles are then linked to events on our side (place words in the title or URL path, hazard words for the general search), deduplicated by URL and near-identical title, and filtered to the event's time window. That linking powers "Show on map" in the news panel and "Related news" in the event drawer.

**Providers and failover** (`backend/src/services/newsProviders/`). GDELT DOC 2.0 is the primary provider; The Guardian Open Platform is the fallback and is only enabled when `GUARDIAN_API_KEY` is set. A refresh runs the same plan on GDELT first and, only if that produced nothing (rate limit, timeouts, backoff), on The Guardian. The provider that served the cache sets the next refresh interval: GDELT 15 minutes, The Guardian 30 minutes (≤ 4 requests per refresh, so ≤ 200 of the developer key's 500 requests/day). Every card says which provider it came from and the response carries `source` and `provider`.

**Relevance.** Guardian searches are restricted to regular articles (no live blogs, galleries or interactives) and matched on the headline and standfirst only. General-search results from any provider are kept only when the headline or standfirst names a hazard (earthquake, flood, wildfire, bushfire, storm, hurricane, cyclone, typhoon, tsunami, eruption, landslide, …). Article-event linking looks at the headline and the story slug only; section segments such as `/australia-news/live/` never link an article to a place.

**Guardian licence** (developer key, non-commercial): headlines and links are passed through unchanged, Guardian cards never show an image, the "Powered by The Guardian" logo (linking to theguardian.com) is shown next to Guardian content, and Guardian rows are deleted from the cache 24 hours after they were fetched (`NewsCache.expiresAt`). No Guardian text is stored in the repository; the test fixture keeps the response shape with paraphrased headlines.

**Backoff.** GDELT allows one request every 5 seconds and answers violations with HTTP 429; The Guardian allows 1 request/second and 500/day. Both clients space their requests and, after any failure, back off exponentially with jitter (`backoff.js`: 30 s, 60 s, … up to 15 min, ± 25 %); calls made inside the window fail at once and send nothing, so a 429 is never retried immediately.

**Persistence.** Every successful refresh is written to the `NewsCache` table (one row per article) and loaded back when the backend starts, so a restart or a Render wake-up serves the previous articles immediately with the real `updatedAt`. A failed refresh keeps the previous articles and marks the response `stale: true`; with nothing cached at all the endpoint answers 503 and the panel shows a retry button. Response shape: `{ items: [{ title, url, domain, publishedAt, image, provider, relatedEvent }], count, updatedAt, stale, source, provider }`, filterable with `?type=` and `?event=`.

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

1. **Ingestion (backend, `src/jobs/ingest.js`)** runs at start-up and every 5 minutes: fetches NASA EONET and USGS (M ≥ 4.5), maps them to the event contract and inserts into `IngestedEvent` with `ON CONFLICT DO NOTHING` (`publishedAt = NULL`). It then drains the **outbox**: unpublished rows, oldest first, up to 500 per run, are published and marked `publishedAt`. The public `GET /disasters` feed is a separate path and is not affected.
2. **Kafka topic `disaster-events`** carries one JSON message per event (contract below).
3. **notification-service** validates each message, loads active `AlertSubscription` rows and creates a `Notification` when the rule matches (type is `any` or equal, event severity ≥ `minSeverity`, haversine distance ≤ `radiusKm`), the event is at most 48 h old and the subscription was created before the event. Inserts are `ON CONFLICT (userId, eventId) DO NOTHING`; invalid messages are logged and skipped, database errors make Kafka redeliver the message.
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
| `severity` | `low` \| `medium` \| `high` | |
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

### Known limitations

- **Render free tier sleeps** after ~15 minutes without traffic. While the backend sleeps no ingestion runs and nothing is published; while the notification service sleeps nothing is consumed. Both catch up when they wake: Kafka keeps the messages, so the consumer resumes from its committed offset.
- **Aiven free Kafka powers off** after a period without traffic and has to be started from the Aiven console. The backend keeps serving the public feed without Kafka; events recorded meanwhile wait in the outbox and are published once the broker is back.
- Notifications are **in-app only**; there is no e-mail, SMS or push channel.
- Events older than 48 hours and subscriptions created after an event never produce notifications, by design.
- **GDELT rate limits by source IP.** Render's shared egress IP can be throttled (HTTP 429) by other tenants' traffic. The news job then backs off, falls back to The Guardian when `GUARDIAN_API_KEY` is set, and otherwise serves the last cached articles from the database as stale.
- **Deploy order:** deploy the consumer before (or together with) producer changes that alter the event contract. A consumer running an older build commits offsets for messages it cannot handle, so those events never produce notifications unless the group offset is reset.

### Future work

- The "subscription must predate the event" rule compares against `occurredAt`; for long-running EONET events (a wildfire first seen days after it started) it should compare against the time the event entered the system so such events can still notify.
- Pre-filter subscriptions in SQL with a bounding box around the event before the haversine check, instead of loading every active subscription per message.
- Frontend lint: `npm run lint` reports 5 errors (setState inside effects in `NewsPanel` and `RelatedNews`, non-component exports in `NewsPanel`, an impure call during render in `MapView`); fix them and add `npm run lint` to CI.
- News: when the cache is empty and every provider failed, retry after a couple of minutes instead of waiting the full refresh interval; keep the first real provider error in `lastError` instead of the local backoff refusal that follows it.
- Wildfire severity is always rated high; when EONET reports an area, derive the severity from it.
- WebSocket live updates, e-mail / SMS / push channels, metrics and tracing.

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
Create two **Web Services** from this repository with the **Docker** runtime, root directories `backend` and `notification-service`, and health check path `/health`. Set the variables from the [Environment variables](#environment-variables) tables: both services need `DATABASE_URL` (pooler host is fine at runtime), `KAFKA_BROKER`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD` and, unless `letsencrypt_sasl` is enabled on the Aiven service, `KAFKA_SSL_CA`; the backend additionally needs `JWT_SECRET`, `NODE_ENV=production` and `ADMIN_EMAILS`, optionally `GUARDIAN_API_KEY` and `CORS_ORIGINS`. Render provides `PORT`.

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
.github/workflows/ci.yml     backend tests, notification-service tests, frontend build
.nvmrc                       Node 24.13.0 (also in every package.json "engines", Dockerfile and CI)
docker-compose.yml           db, zookeeper, dw-kafka, backend, notification, frontend
backend/                     Express API, Prisma schema, ingestion + news jobs, Kafka producer, tests
  src/app.js                 the Express app (routes, CORS allow-list, helmet, JSON errors)
  src/index.js               entry point: HTTP server, news job, producer, ingestion
  src/events/contract.js     event contract v1 (zod)
  src/services/              feed (NASA/USGS cache), news providers, Kafka producer
  prisma/schema.prisma       User, AlertSubscription, Notification, IngestedEvent, NewsCache, AdminAuditLog, Disaster
  tests/                     Vitest suites (TEST_DATABASE_URL only)
notification-service/        Kafka consumer: contract, matcher, pg writes, /health; unit tests
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
- **Cloud (optional):** Render, Neon, Aiven
- **Tests / CI:** Vitest, supertest, GitHub Actions

---

## Changelog

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
