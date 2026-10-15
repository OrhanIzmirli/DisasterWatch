# DisasterWatch

[![CI](https://github.com/OrhanIzmirli/DisasterWatch/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/OrhanIzmirli/DisasterWatch/actions/workflows/ci.yml)

A cloud-ready, real-time disaster monitoring platform that aggregates global disaster signals using **NASA EONET + USGS**, normalizes multi-source API responses into a single schema, visualizes events on an interactive map, and uses **Kafka** for event-driven processing via producer/consumer microservices.

Note: The project is designed to be **fully runnable on localhost** via Docker Compose (cloud deployment is optional). This makes it easy to demo in interviews without requiring cloud credentials.

---

## Features

### 1) Multi-Source Disaster Data (NASA EONET + USGS)
- Fetches global disaster data from:
  - **USGS** (Earthquakes)
  - **NASA EONET** (Wildfires, floods, storms, etc.)
- Normalizes heterogeneous API responses into a single unified model
- Performance-safe rendering (pagination + marker caps)

### 2) Live Dashboard (Map + Feed + KPI)
- Interactive **world map** with disaster markers
- Live disaster feed with pagination
- KPI overview:
  - Total disasters
  - Active alerts (high severity)
  - Countries affected (derived by the backend from the source place names; events whose country cannot be derived, e.g. "North Atlantic Ocean", are not counted)
- Honest feed states: a skeleton while loading, an explicit error state with "Try again" when the sources are down, and the last successful feed flagged STALE when a refresh fails. Nothing on the dashboard is simulated: there are no demo or fallback events anywhere.

### 3) Filtering, Search, Sorting
- Filter by disaster type:
  - Earthquakes
  - Wildfires
  - Floods
  - Storms
- Search by country/city keyword
- Sorting options:
  - Newest
  - Severity

### 4) Severity Scoring (LOW / MEDIUM / HIGH)
- Each event is classified into severity levels
- Severity badges shown directly in the feed
- Helps prioritize critical events

### 5) Event-Driven Architecture (Kafka)
DisasterWatch streams disaster events through Kafka to decouple ingestion from processing.

**Producer (Backend)**
- After processing/normalizing disaster data, backend publishes structured messages to Kafka topic:
  - `disaster-events`

Example message:
```json
{
  "type": "earthquake",
  "location": "Turkey",
  "severity": "high",
  "timestamp": "2026-03-08T22:25:00Z"
}
```

**Consumer (Notification Service)**
- Subscribes to `disaster-events`
- Logs received events (ready for future alert pipelines: Email/SMS/WebSocket push)

### 6) Dockerized Microservices (Local + Cloud-Ready)
- Fully containerized services:
  - frontend (React build served by Nginx)
  - backend (Node.js + Express)
  - db (PostgreSQL)
  - kafka (Confluent Kafka) + zookeeper
  - notification-service (Kafka consumer)
- Runs locally with a single Docker Compose command

### 7) Bonus UI Modules (Demo-Ready)
- Alerts page UI (demo)
- Admin console UI (demo)
- News modal UI (demo)

---

## App Screenshots

### 1) Main Dashboard (KPI + Map + Live Feed)
Shows the complete overview: KPIs at the top, map markers, and live feed on the right.  
![Dashboard](screenshots/01-dashboard.png)

---

### 2) Backend Health (API Proof)
Confirms backend is running and reachable through the reverse proxy `/api`.  
![API Health](screenshots/02-api-health.png)

---

### 3) Disasters API Response (Normalized Output)
Shows normalized disasters data returned by the backend.  
![API Disasters](screenshots/03-api-disasters.png)

---

### 4) Disasters API Response (Alt View)
Alternative capture (useful to show larger payload / different portion).  
![API Disasters Alt](screenshots/03-api-disasters-alt.png)

---

### 5) Docker Compose (All Services Up)
Proves that frontend, backend, database, Kafka, zookeeper, and notification service are all running together.  
![Docker Compose PS](screenshots/04-compose-ps.png)

---

### 6) Kafka Consumer Receives Event (End-to-End Proof)
Shows the notification-service consuming a message from Kafka topic.  
![Kafka Event Received](screenshots/05-kafka-event-received.png)

---

### 7) Kafka Topics (Topic Exists)
Confirms the `disaster-events` topic exists.  
![Kafka Topics](screenshots/06-kafka-topics.png)

---

### 8) Filter Example — Earthquakes
Clicking Earthquakes updates the feed and map context.  
![Filter Earthquakes](screenshots/07-filter-earthquakes.png)

---

### 9) Filter Example — Wildfires
Switching to Wildfires updates markers and feed.  
![Filter Wildfires](screenshots/08-filter-wildfires.png)

---

### 10) Search Example (Country/City)
Search input filters events by keyword (country/city).  
![Search](screenshots/09-search-country.png)

---

### 11) Sort Example — Newest
Sort dropdown configured for Newest (time-based monitoring).  
![Sort Newest](screenshots/10-sort-newest.png)

---

### 12) Sort Example — Severity
Sort dropdown configured for Severity (critical-first view).  
![Sort Severity](screenshots/10-sort-severity.png)

---

### 13) Severity Badges (LOW / MEDIUM / HIGH)
Shows severity classification badges inside the feed.  
![Severity Badges](screenshots/11-severity-badges.png)

---

### 14) Map Marker Popup / Detail
Clicking a marker reveals detail popup.  
![Map Popup](screenshots/12-map-popup.png)

---

### 15) Alerts Page (Demo UI)
Demo UI for alert rules & channels (future persistence ready).  
![Alerts Page](screenshots/16-alerts-page.png)

---

### 16) Admin Console (Demo UI)
Demo operator panel for creating demo disaster entries.  
![Admin Console](screenshots/17-admin-console.png)

---

### 17) News Modal (Demo UI)
In-app modal showing disaster-related news.  
![News Modal](screenshots/18-news-modal.png)

---

## News

`GET /news` is served from a cache that a background job refreshes (`src/services/news.service.js`); requests never call a news provider themselves.

**Request budget.** Each refresh picks the ~10 most important feed events (high severity first, then newest), cleans their location text (`"Flood in Nepal 1104225"` -> `Nepal`, `"53 km S of Kushiro, Japan"` -> `Kushiro Japan`, in `src/services/newsLinking.js`) and folds them into at most **3 combined searches** (one per hazard type, the events' place words OR-ed: `(earthquake OR quake OR tremor) (kushiro OR japan OR kokopo OR papua OR guinea)`) plus one general disaster search: **at most 4 requests per refresh** instead of one per event. Articles are then linked to events on our side (`linkArticlesToEvents`: place words in the title or URL path, hazard words for the general search), deduplicated by URL and near-identical title, and filtered to the event's time window. That linking powers the "Show on map" button in the news panel and the "Related news" section of the event drawer.

**Providers and failover** (`src/services/newsProviders/`). GDELT DOC 2.0 is the primary provider; The Guardian Open Platform is the fallback and is only enabled when `GUARDIAN_API_KEY` is set (without it the service runs on GDELT plus the database cache). A refresh runs the same plan on GDELT first and, only if that produced nothing (rate limit, timeouts, backoff), on The Guardian. The provider that served the cache sets the next refresh interval: GDELT 15 minutes, The Guardian 30 minutes (<= 4 requests per refresh, so <= 200 of the developer key's 500 requests/day). Every card says which provider it came from (`via GDELT` / `via The Guardian`) and the response carries `source` and `provider`.

**Relevance.** Guardian searches are restricted to regular articles (`type=article`, so no live blogs, galleries or interactives; "– as it happened" titles and `/live/` URLs are dropped locally as well) and matched on the headline and standfirst only (`query-fields=headline,trailText`). General-search results from any provider are kept only when the headline or standfirst names a hazard (earthquake, flood, wildfire, bushfire, storm, hurricane, cyclone, typhoon, tsunami, eruption, landslide, ...). Article-event linking looks at the headline and the story slug only; section segments such as `/australia-news/live/` never link an article to a place.

**Guardian licence** (developer key, non-commercial): headlines and links are passed through unchanged, Guardian cards never show an image, the "Powered by The Guardian" logo (linking to theguardian.com) is shown next to Guardian content, and Guardian rows are deleted from the cache 24 hours after they were fetched (`NewsCache.expiresAt`).

**Backoff.** GDELT allows one request every 5 seconds and answers violations with HTTP 429 and a plain-text body; The Guardian allows 1 request/second and 500/day. Both clients space their requests and, after any failure, back off exponentially with jitter (`src/services/backoff.js`: 30 s, 60 s, ... up to 15 min, +/- 25 %); calls made inside the window fail at once with kind `backoff` and send nothing, so a 429 is never retried immediately.

**Persistence.** Every successful refresh is written to the `NewsCache` table (one row per article) and loaded back when the backend starts, so a restart or a Render wake-up serves the previous articles immediately with the real `updatedAt`. A failed refresh keeps the previous articles (in memory and in the table) and marks the response `stale: true`; with nothing cached at all the endpoint answers 503 and the panel shows a retry button. `GET /health` reports `news: { provider, updatedAt, stale, articles }`. Response shape: `{ items: [{ title, url, domain, publishedAt, image, provider, relatedEvent }], count, updatedAt, stale, source, provider }`, filterable with `?type=` and `?event=`.

---
## Event-Driven Notification Pipeline

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

`GET /disasters` (the public feed) answers `{ items, count, source, stale, partial, sources, sourcesUpdatedAt, updatedAt, params }` from a 5-minute in-memory cache per source (`src/services/feed.service.js`). The cache lifetime is fixed on the server: there is no query parameter to force a live fetch or shorten the cache, so anonymous callers cannot turn the backend into a NASA/USGS proxy; `limit` is clamped to 1..200, `minutes` to 60..43200 and `minMag` to 0..10. NASA and USGS are fetched independently, with at most one upstream request per source in flight (concurrent callers share it). A source that fails keeps serving its last good data while that data is at most 60 minutes old (`sources.<name> = "stale"`, `sourcesUpdatedAt: { nasa, usgs }` says how old); older data is dropped (`"error"`, `partial: true`) and the failed source is retried after a minute (after 10 seconds while it has never returned data, so a cold start during a network blip does not answer 503 for a whole minute). The dashboard shows a per-source note ("USGS unreachable: showing earthquakes from 12 minutes ago" / "NASA EONET unavailable: wildfires, storms and floods are missing from this update") instead of the offline state, and every "ago" label on the page derives from the backend's `updatedAt`, not from when the browser fetched. When both fail the previous feed is served with `stale: true`; with nothing cached the endpoint answers 503 `{ message: "Live disaster sources are not responding", retryAfterSeconds }`. Upstream error details stay in the server log and never reach the response or the UI. Each item carries `country` (from the USGS place or the EONET title, `null` when not derivable) and polygon events (GDACS floods) are placed at the polygon centroid.

Admin entries from `POST /disasters` are stored but **not** published yet; a verification step for manual entries comes in a later release. Admins can publish a test event with `POST /events`.

### Event contract (v1)

Defined in `backend/src/events/contract.js` and `notification-service/src/contract.js` (kept identical; both validate with zod).

| Field | Type | Notes |
|---|---|---|
| `v` | `1` | contract version |
| `eventId` | string | stable id from the source: `nasa:EONET_1234`, `usgs:us7000abcd`, `manual:42` |
| `source` | `nasa` \| `usgs` \| `manual` | |
| `type` | string | lower-case hazard type: `earthquake`, `flood`, `wildfire`, `storm` |
| `severity` | `low` \| `medium` \| `high` | |
| `title` | string | 1–200 chars |
| `lat`, `lng` | number | WGS84 |
| `occurredAt` | string | ISO-8601 with timezone |

```json
{ "v": 1, "eventId": "usgs:us7000abcd", "source": "usgs", "type": "earthquake",
  "severity": "high", "title": "M6.1 earthquake, 12 km E of Izmit, Turkey",
  "lat": 40.77, "lng": 30.0, "occurredAt": "2026-10-13T23:40:00.000Z" }
```

### Known limitations

- **Render free tier sleeps** after ~15 minutes without traffic. While the backend sleeps no ingestion runs and nothing is published; while the notification service sleeps nothing is consumed. Both catch up when they wake: Kafka keeps the messages, so the consumer resumes from its committed offset.
- **Aiven free Kafka powers off** after a period without traffic and has to be started from the Aiven console. The backend keeps serving the public feed without Kafka; events recorded meanwhile wait in the outbox and are published once the broker is back (see Reliability).
- Notifications are **in-app only**; there is no e-mail, SMS or push channel.
- Events older than 48 hours and subscriptions created after an event never produce notifications, by design.
- **GDELT rate limits by source IP.** Render's shared egress IP can be throttled (HTTP 429) by other tenants' traffic, not only ours. The news job then backs off, falls back to The Guardian when `GUARDIAN_API_KEY` is set, and otherwise serves the last cached articles from the database as stale.
- **Deploy order:** deploy the consumer before (or together with) producer changes that alter the event contract. A consumer running an older build commits offsets for messages it cannot handle, so those events never produce notifications unless the group offset is reset.

### Reliability

- **Transactional outbox (producer).** Recording an event and publishing it are separate steps. `IngestedEvent.publishedAt` stays `NULL` until Kafka has accepted the message; a failed send (broker asleep, timeout) leaves the rows untouched and the next run retries them, so no event is lost. `GET /health` reports the number of rows still waiting as `outboxPending`.
- **Idempotent consumer.** Notifications are inserted with `ON CONFLICT (userId, eventId) DO NOTHING`, so a message delivered twice (a retried publish, a Kafka redelivery after a consumer error) produces exactly one notification.
- Together: **at-least-once delivery, at most one notification per user and event.**

### Future work

- The "subscription must predate the event" rule compares against `occurredAt`; for long-running EONET events (a wildfire first seen days after it started) it should compare against the time the event entered the system (`firstSeenAt` / the Kafka message time) so such events can still notify.
- Pre-filter subscriptions in SQL with a bounding box around the event before the haversine check, instead of loading every active subscription per message.
- Clean up the 6 ESLint errors and 1 warning in the frontend (`any` in `api/client.ts` and `api/config.ts`, setState-in-effect in `RelatedNews`/`NewsPanel`, a non-component export in `NewsPanel`) and add `npm run lint` to CI.
- News: when the cache is empty and every provider failed, retry after a couple of minutes instead of waiting the full refresh interval (shorter cold start after a Render wake-up).
- News: keep the first real provider error (the 429 or timeout) in `lastError` instead of the local backoff refusal that follows it, so `/health` and the 503 body explain the cause.
- Wildfire severity is always rated high. EONET reports an area for some fires (for example 9,965 ha); when it is present the severity should be derived from the area instead.

---

## Tech Stack
- **Frontend:** React, TypeScript, Vite, Leaflet  
- **Backend:** Node.js, Express, Prisma ORM, Zod, REST API  
- **Streaming:** Kafka (Confluent), KafkaJS Producer/Consumer  
- **Infra:** Docker, Docker Compose, Nginx reverse proxy  
- **Cloud (optional):** Render (frontend + services), Neon (PostgreSQL), Aiven (Kafka)

---

## Setup (Important)
This project runs locally via Docker Compose.

### 1) Create env file

```bash
cp backend/.env.example backend/.env
```

### 2) Run with Docker

```bash
docker compose up --build
```

### URLs
- **Frontend:** http://localhost:8080  
- **Backend health:** http://localhost:5000/health  
- **Proxy health:** http://localhost:8080/api/health  
- **Proxy disasters:** http://localhost:8080/api/disasters  

---

## Kafka Demo (Send a test event)

### Send a test message to `disaster-events`

```bash
echo "{\"type\":\"test\",\"location\":\"Warsaw\",\"severity\":\"low\",\"timestamp\":\"2026-03-08T22:25:00Z\"}" \
| docker compose exec -T dw-kafka bash -lc "kafka-console-producer --bootstrap-server localhost:9092 --topic disaster-events"
```

Then check the consumer output:

```bash
docker compose logs notification
```

---

## Cloud Deployment (Free Tiers)

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
Create a database and copy its connection string (keep `?sslmode=require`). Push the Prisma schema once from your machine:

```bash
cd backend
npm install
DATABASE_URL="postgresql://...neon.tech/...?sslmode=require" npm run db:push
```

### 3) Backend and notification service (Render)
Create two **Web Services** from this repository with the **Docker** runtime, root directories `backend` and `notification-service`, and health check path `/health`.

| Variable | Backend | Notification | Example |
|---|---|---|---|
| `DATABASE_URL` | yes | yes | Neon connection string (pooler host). The notification service reads subscriptions and writes notifications with it |
| `JWT_SECRET` | yes | | a long random string (32+ chars; production refuses to start otherwise) |
| `ADMIN_EMAILS` | yes | | comma-separated e-mails that get the admin role, e.g. `owner@example.com,ops@example.com` |
| `COOKIE_NAME` | optional | | session cookie name (default `dw_session`) |
| `GDELT_TIMEOUT_MS` | optional | | per-request timeout for GDELT news searches (default `8000`; GDELT is often slower than that, see News) |
| `GUARDIAN_API_KEY` | optional | | Guardian Open Platform developer key; enables The Guardian as the fallback news provider (see News) |
| `CORS_ORIGINS` | optional | | comma-separated browser origins allowed to call the API directly (default: the live frontend and localhost 8080/5173/4173); the frontend's own `/api` proxy never needs it |
| `DISABLE_NEWS_JOB` | optional | | `1` disables the background news refresh |
| `NODE_ENV` | yes | | `production` (enables the Secure cookie flag and the JWT secret check) |
| `KAFKA_BROKER` | yes | yes | `kafka-xxxx.aivencloud.com:12345` (comma-separated for several brokers) |
| `KAFKA_SASL_USERNAME` | yes | yes | `avnadmin` |
| `KAFKA_SASL_PASSWORD` | yes | yes | from Aiven |
| `KAFKA_SASL_MECHANISM` | optional | optional | `scram-sha-256` (default), `scram-sha-512` or `plain` |
| `KAFKA_SSL_CA` | yes* | yes* | CA certificate (PEM); newlines may be written as `\n` |

\* Not needed if `letsencrypt_sasl` is enabled on the Aiven service, since a public CA is used then.

**Admin accounts:** roles are driven by `ADMIN_EMAILS`. An account whose e-mail is in the list gets the `admin` role at registration, and on every login the stored role is re-synced with the list (promoted if added, demoted if removed). There is no other way to become admin.

Render provides `PORT` automatically; both services read it. Free Render web services sleep after inactivity, so the consumer only processes messages while the service is awake.

### 4) Frontend (Render Static Site)
- Root directory: `disasterwatch-frontend`
- Build command: `npm ci && npm run build`
- Publish directory: `dist`
- Redirects/Rewrites, in this order:
  - `/api/*` → `https://<backend-service>.onrender.com/*` (Rewrite)
  - `/*` → `/index.html` (Rewrite)

The frontend calls relative `/api/...` paths, so the first rule plays the role of the Nginx proxy used locally.

---

### Notes on Security

- .env, .env.local, .env.docker are excluded from version control
- Secrets are not committed
- Only .env.example is included

---

### Future Improvements

- WebSocket live broadcasting (real-time UI updates)
- E-mail / SMS / push delivery channels (in-app notifications exist today)
- Persist alert rules in DB
- Observability: metrics + tracing (Prometheus/Grafana)
- Multi-region cloud deployment hardening

---

### Deployment Status / Changelog

**2026-10-07**

- Azure Container Apps + ACR was the initial deployment plan; it was dropped because of cost and operational complexity in favor of a free-tier stack: Render, Neon and Aiven.
- Removed the Azure-specific comments from `backend/Dockerfile`.
- Added `.dockerignore` files for the backend and notification service to keep the build context and images lean (no host `node_modules` or `.env` files).
- Currently going live: a custom domain will be purchased and DNS and SSL will be configured.

---

### Author

Orhan Izmirli
Computer Science Student (Poland)
Project focus: Full-stack development, event-driven architecture, distributed systems, and cloud-ready deployments.
