# Architecture

How DisasterWatch is built: the services, the methodology behind the feed, the event-driven notification pipeline and the repository layout. Scheduling, e-mail delivery and day-to-day operation are in [Operations](operations.md). Back to the [README](../README.md).

## Overview

A real-time disaster monitoring platform. The backend aggregates **NASA EONET** and **USGS** into one feed, rates every event LOW / MEDIUM / HIGH (or not rated) from what the sources publish, links news articles to events, and streams new events through **Kafka** to a notification service that matches them against users' location-based alert rules and sends in-app and opt-in e-mail alerts. The React frontend shows everything on a live map with a feed, news panel, alert subscriptions, notifications and an admin console.

The whole stack runs on localhost with one `docker compose up`; the same images run in the cloud (Render + Neon + Aiven + Resend, free tiers).


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

- **Sources.** Earthquakes of the last 30 days from USGS (magnitude 4.5 and above, the monthly feed); wildfires, floods and severe storms from NASA EONET (open and closed events of the last 30 days; the feed shows the last 7 days by default). Every feed item keeps its source id and links, and nothing is invented: when the sources fail the feed says so instead of showing demo data.
- **Location.** USGS gives a point. For EONET events reported by GDACS the GDACS event point wins over the EONET geometry when GDACS can be reached (otherwise the EONET geometry is used, see `ingest.eonetFallbackRecorded`); when the two are more than 100 km apart the event is marked *approximate* and the drawer says why. Countries come from the source place names; an event whose country cannot be derived (open sea) is not counted as a country.
- **Severity.** Taken from the source wherever it publishes one: GDACS impact level (Green / Orange / Red) for wildfires and floods, magnitude for earthquakes, the Saffir-Simpson scale on the peak advisory wind for storms, burned area for fires GDACS does not cover. An event the source gives no intensity for is shown as *not rated*, never guessed. The wildfire area cut was set from 90 days of EONET data; storms use the Saffir-Simpson boundaries ([Severity](severity.md)).
- **News.** At most four requests per provider and refresh (up to three combined searches for the most important events plus one general search; GDELT makes only the general one), plus the media lists GDACS keeps for up to 25 GDACS-linked events. Every article passes the same relevance rules (sport, retrospectives, idioms and similar are dropped). GDELT and Guardian articles are linked to an event by headline or story slug; GDACS media articles come with the GDACS event they are listed under. An article gets a country from its linked event, its Guardian tags or its GDACS event, and a country inherited from GDACS is kept only when the headline or slug names it; otherwise the article stays unlocated ([News](news.md)).
- **Alerts.** A subscription is a hazard type, a minimum severity and a circle (centre + radius). New events are recorded once, published through a transactional outbox and matched by distance; each user gets at most one notification per event and, if they opted in and confirmed their address, one summary e-mail per run ([Event-driven notification pipeline](#event-driven-notification-pipeline)).

---

## Features in detail

### 1) Multi-source disaster feed (NASA EONET + USGS)
- **USGS** earthquakes (M ≥ 4.5, last 30 days; the alert ingestion reads the last 7) and **NASA EONET** wildfires, floods and storms.
- Heterogeneous responses are normalized into one model (`type`, `severity`, `title`, `lat`/`lng`, `country`, `occurredAt`, source ids).
- 5-minute server-side cache per source; the two sources are fetched independently, so one failing source degrades the feed instead of killing it (see [Feed contract](api.md#feed-contract-get-disasters)).
- Computed when data arrives, not per request (`backend/src/services/feedView.js`): while the backend is awake a warmer runs once a minute, refreshes each source before its cache expires and builds the dashboard response (items, fusion scores, JSON body and ETag) right away. A request sends the prepared body, or a 304 when the browser already holds it, and never waits for NASA, USGS or the scoring. The warmer also starts at boot, so a woken service fetches before the first visitor asks.
- Pagination and marker caps keep the map responsive: the map shows the 15 strongest earthquakes of the feed page, and when a week has more quakes than the page has room for, the page keeps the strongest, not the newest.

### 2) Live dashboard (map + feed + KPIs)
- Interactive world map (Leaflet) with markers coloured by event type, sized by priority and outlined by confidence, and an event detail drawer (related news, USGS PAGER alert level, EONET sources).
- Nearby events are grouped into numbered clusters (supercluster, `src/utils/clustering.ts`) coloured by event type like the markers: one solid colour when a single type is inside, a ring split proportionally to the type counts for a mix, with the count on a dark disc. Clusters are sized logarithmically and carry a "7 events · 6 wildfires, 1 flood · highest: High" tooltip (severity lives in the tooltip, not in the colour); clicking zooms to the cluster's bounds, or fans the events out when they share coordinates (spiderfy). The selected event is always drawn on its own, on top, so it never disappears inside a cluster.
- Live feed with filters (earthquake / wildfire / flood / storm), search by place, sorting by newest or severity.
- KPIs: total events, significant events (high + medium severity), countries affected (derived by the backend from the source place names; events whose country cannot be derived, e.g. "North Atlantic Ocean", are not counted).
- Honest states: a skeleton while loading, a per-source note when one source is down, the last good feed flagged STALE when a refresh fails, an explicit error state with "Try again" when nothing is cached. There are no demo or fallback events anywhere.

### 3) Severity from the source (LOW / MEDIUM / HIGH, or NOT RATED)
- Decided in `backend/src/utils/severity.js` (the single source of truth; the explanation sentence is generated from the same rules):
  - **earthquake:** rounded magnitude ≥ 6.0 high, 5.0–5.9 medium, < 5.0 low
  - **wildfire and flood: the GDACS impact level is primary** (Red → high, Orange → medium, Green → low). GDACS, the source behind every non-US fire and every flood in EONET, publishes its own impact level per event; the backend looks it up on gdacs.org by the event id in EONET's source link (see [Severity](severity.md)).
  - **wildfire without a GDACS level** (US/IRWIN fires, GDACS unreachable): burned area normalised to hectares (`hectare` as is, `acres` × 0.40469): ≥ 10,000 ha high, 7,000–9,999 ha medium, < 7,000 ha low
  - **storm:** Saffir-Simpson on the **peak** advisory wind of the event (highest `magnitudeValue` of the series): ≥ 96 kts high (category 3+), 64–95 kts medium (category 1–2), < 64 kts low; the current wind is shown next to the peak ("Peaked 135 kts (Cat-4), now 55 kts")
  - flood without a GDACS level, no value, unknown unit: **not rated** (`unrated`, "Not rated: the source reports no intensity for this event")
  - manual (admin) entries keep the severity the admin chose (low / medium / high, never unrated)
- Shown as badges in the feed, in the map tooltip and in the drawer, each with the reason sentence and the GDACS attribution where it applies. Not-rated events sort last and wear a neutral stone-grey pill, distinct from the storm marker grey. The **"Significant events"** KPI counts high + medium (never not-rated); it is unrelated to the users' alert subscriptions.

### 4) News linked to events
- GDELT and The Guardian (optional) are searched for the most important feed events, and GDACS media news is listed per GDACS event; articles are linked to events on our side, placed in a country and region, and shown in the news panel (hazard and region filters) and the event drawer ("Show on map", "Related news"). Details in [News](news.md).

### 5) Accounts, alerts and notifications
- Cookie-based sessions (JWT in an `httpOnly` cookie), registration and login with rate limiting.
- **Alert subscriptions:** hazard type (or any), minimum severity, a centre point and a radius in km. Minimum `low` means every event, including not-rated ones; `medium` and `high` never match a not-rated event.
- **Notifications:** new events that match a subscription appear in the bell in the header (polled every 60 s).
- **E-mail alerts (opt-in):** off by default; a switch with the consent text on the Alerts page turns them on. One summary e-mail per user per run, a daily limit, one-click unsubscribe ([E-mail alerts](operations.md#e-mail-alerts)).
- **Privacy and deletion:** a plain-language privacy page (`/privacy`, linked from the footer of every content page and from sign-up) lists what is stored, who processes it (Render, Neon, Resend), how long it is kept and how to delete it. On *My account* a user deletes their own account after entering the password again; subscriptions and notifications go with it, the e-mail records are anonymised. An `ADMIN_EMAILS` address confirms only while signed in to its account (so whoever registered the owner's address first cannot become admin through the owner's click).

### 6) Admin console
- Accounts whose e-mail is listed in `ADMIN_EMAILS` **and confirmed while signed in** get the `admin` role: the double opt-in link of the e-mail alerts, opened in a browser that is signed in to that account, sets `emailConfirmedSignedInAt` (password and mailbox proven together). Registering does not prove an address and a click on the link proves only the mailbox, so a new account, or one confirmed without its session, is never an admin, not even when its address is added to the list later. The role is worked out on every request, so a list change applies to open sessions at once. To become admin: register the listed address, sign in, turn e-mail alerts on, open the confirmation link in the same browser (alerts can be turned off again afterwards). Admins can list, disable, enable and delete users, read the audit log (every admin action is written in the same transaction as the action), create manual disaster entries and publish a test event to Kafka.

### 7) Event-driven architecture (Kafka)
- The backend records new NASA/USGS events in an outbox table and publishes them to the topic `disaster-events`; the notification service consumes them and creates notifications. At-least-once delivery, at most one notification per user and event. Details in [Event-driven notification pipeline](#event-driven-notification-pipeline).

### 8) Dockerized services
- `frontend` (React build served by Nginx, which also proxies `/api`), `backend` (Node.js + Express + Prisma), `db` (PostgreSQL 16), `dw-kafka` + `zookeeper` (Confluent 7.6.1), `notification` (Kafka consumer). One Compose file, one command.

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
docs/                        detailed documentation (architecture, API, severity, news, operations, screenshots)
CHANGELOG.md                 notable changes
CONTRIBUTING.md              branch, review and no-risk-zone rules
```

Security notes: `.env` files are git-ignored and docker-ignored, only `.env.example` files are committed; sessions are `httpOnly` cookies (Secure in production); the API sends security headers (helmet), echoes only allow-listed CORS origins, limits JSON bodies to 100 kB and rate-limits registration and login.
