# HTTP API

The backend's HTTP API and the contract of the public feed. Back to the [README](../README.md).

## Endpoints

All paths are relative to the backend (`http://localhost:5000`) or to the proxy (`http://localhost:8080/api`). Responses are JSON; errors are `{ message }` (or `{ ok: false, error }` for `/events`).

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /health` | – | `{ ok, service, kafka, outboxPending, ingest: { running, lastRunAt, lastTrigger, lastErrorSources, lastStats, lastWakeAt, lastWakeOutcome, eonetFallbackRecorded }, news: { provider, updatedAt, stale, articles, providers: { <name>: { articles, located, lastAttemptAt, lastSuccessAt, lastError, lastErrorKind, droppedOffTopic } }, storms }, gdacs: { disabled, cached, pending, requests, hits, failures, lastError, lastFetchAt, store }, email: { state, dailyLimit, sentLast24h, reportedAt, lastSentAt, lastError, lastErrorAt } (null when the database is unreachable), time }` |
| `GET /disasters` | – | the public feed ([contract below](#feed-contract-get-disasters)) |
| `GET /news?type=&region=&event=` | – | cached news articles, linked to feed events and placed in a region ([News](news.md)) |
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
| `severityRules` | object | the thresholds that rated the items, from `backend/src/utils/severity.js` (`SEVERITY_RULES`): `{ earthquake, wildfire, storm }`, each `{ basis, unit, medium, high, step }` where `medium` and `high` are the lower bounds of those levels and `step` the display precision (`0.1` for magnitudes), and `gdacs: { levels: { green, orange, red } → severity, appliesTo }`. The frontend draws the drawer's severity scale from it and keeps no copy |

Each item: `id`, `type` (`earthquake` | `wildfire` | `flood` | `storm`), `location`, `meta` (one-line summary), `severity` (`low` | `medium` | `high` | `unrated`), `timeMinutesAgo`, `description`, `lat`, `lng`, `country` (derived from the USGS place or the EONET title, `null` when not derivable) and `details`: source-faithful fields for the event drawer (`eventId` such as `usgs:us7000abcd`, `source`, `category`, `cleanTitle`, `place`, `occurredAt`, `updatedAt`, `status`, `sources` [{ name, url }], `magnitude`, `magnitudeLabel`, `magType`, `depthKm`, `pagerAlert`, `tsunami`, `feltReports` for USGS; `magnitudeValue`/`magnitudeUnit` as reported by EONET plus `areaHa` (wildfire area normalised to hectares), `peakKts`/`currentKts` (storms), `gdacsLevel`/`gdacsScore` (wildfires and floods rated by GDACS; `null` otherwise); `severity`, `severityReason`, `severitySource`; `locationPrecision`). An event that links to GDACS is placed at the GDACS event point; otherwise at the EONET point or polygon centroid. When the GDACS point and the EONET geometry lie more than 100 km apart, `details.locationPrecision` is `approximate` with the reason, and the drawer and e-mails show an "approximate" note.

Failure behaviour: a source that fails keeps serving its last good data while it is at most 60 minutes old; a source that has never returned data is retried after 10 seconds, otherwise after a minute. When both sources fail and nothing is cached the endpoint answers `503 { message: "Live disaster sources are not responding", retryAfterSeconds: 60 }`. Upstream error details never leave the server log.
