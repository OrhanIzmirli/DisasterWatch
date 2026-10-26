/**
 * Feed ingestion job with a transactional outbox.
 *
 * Every run has two independent phases:
 *  (a) record: fetch NASA EONET + USGS, map them to the event contract and
 *      INSERT ... ON CONFLICT DO NOTHING into IngestedEvent (publishedAt NULL);
 *  (b) publish the outbox: rows with publishedAt IS NULL, oldest first, at
 *      most OUTBOX_BATCH per run, are published to Kafka and then marked
 *      publishedAt = now(). A failed publish leaves the rows NULL, so they
 *      are retried on the next run instead of being lost (Aiven's free
 *      tier powers off when idle, so this happens in practice).
 *
 * Together with the consumer's unique (userId, eventId) constraint this
 * gives at-least-once delivery with at most one notification per event.
 * The public GET /disasters feed is untouched by this job.
 *
 * Dependencies are injectable so tests can run it without network or Kafka.
 */
import { Prisma } from "@prisma/client";
import defaultPrisma from "../prisma.js";
import { fetchNasaEvents } from "../services/nasa.service.js";
import { fetchUsgsEarthquakes } from "../services/usgs.service.js";
import { gdacsClient } from "../services/gdacs.js";
import { publishDisasterEvents } from "../services/kafkaProducer.js";
import { nasaEventsToContract, usgsFeaturesToContract, nasaEventId } from "../events/mappers.js";

export const INGEST_INTERVAL_MS = 5 * 60 * 1000;
export const OUTBOX_BATCH = 500; // rows considered per run
export const PUBLISH_CHUNK = 50; // rows per Kafka send; marked after each successful send
const INSERT_CHUNK = 200;
const USGS_MIN_MAG = 4.5; // same threshold as the public feed; micro-quakes are not alerts

/**
 * Inserts events and returns the subset that was newly inserted.
 * One round trip per chunk thanks to RETURNING.
 */
export async function recordNewEvents(events, { prisma = defaultPrisma, approximate = new Set() } = {}) {
  const inserted = [];
  for (let i = 0; i < events.length; i += INSERT_CHUNK) {
    const chunk = events.slice(i, i + INSERT_CHUNK);
    const rows = await prisma.$queryRaw`
      INSERT INTO "IngestedEvent" ("eventId", "source", "type", "severity", "title", "lat", "lng", "occurredAt", "locationPrecision")
      VALUES ${Prisma.join(
        chunk.map(
          (e) =>
            Prisma.sql`(${e.eventId}, ${e.source}, ${e.type}, ${e.severity}, ${e.title}, ${e.lat}, ${e.lng}, ${new Date(e.occurredAt)}, ${approximate.has(e.eventId) ? "approximate" : "exact"})`
        )
      )}
      ON CONFLICT ("eventId") DO NOTHING
      RETURNING "eventId"
    `;
    const insertedIds = new Set(rows.map((r) => r.eventId));
    for (const e of chunk) if (insertedIds.has(e.eventId)) inserted.push(e);
  }
  return inserted;
}

/** IngestedEvent row -> contract message. */
function rowToEvent(row) {
  return {
    v: 1,
    eventId: row.eventId,
    source: row.source,
    type: row.type,
    severity: row.severity,
    title: row.title,
    lat: row.lat,
    lng: row.lng,
    occurredAt: row.occurredAt.toISOString(),
  };
}

/** Number of events still waiting in the outbox (surfaced on /health). */
export async function countPendingOutbox({ prisma = defaultPrisma } = {}) {
  return prisma.ingestedEvent.count({ where: { publishedAt: null } });
}

/**
 * Publishes unpublished rows (oldest first, up to `batch`) in chunks and
 * marks each chunk as published right after its send succeeds. On a failure
 * the remaining rows stay unpublished and the error is returned, not thrown.
 * Returns { published, pending, error }.
 */
export async function publishOutbox({
  prisma = defaultPrisma,
  publish = publishDisasterEvents,
  batch = OUTBOX_BATCH,
  chunkSize = PUBLISH_CHUNK,
  log = console,
} = {}) {
  const rows = await prisma.ingestedEvent.findMany({
    where: { publishedAt: null },
    orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
    take: batch,
  });

  let published = 0;
  let error = null;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    try {
      await publish(chunk.map(rowToEvent));
    } catch (err) {
      error = err?.message || String(err);
      log.error(`[outbox] publish failed after ${published} row(s); ${rows.length - published} stay pending:`, error);
      break;
    }

    await prisma.ingestedEvent.updateMany({
      where: { id: { in: chunk.map((r) => r.id) }, publishedAt: null },
      data: { publishedAt: new Date() },
    });
    published += chunk.length;
  }

  const pending = await countPendingOutbox({ prisma });
  return { published, pending, error };
}

/**
 * The raw EONET events not yet in IngestedEvent (by contract eventId). An
 * event is recorded once (ON CONFLICT DO NOTHING), so only these need the
 * GDACS level and point before they are mapped; the recorded ones would be
 * looked up for nothing. Returns { fresh, known } (known: the count skipped).
 */
export async function unrecordedNasaEvents(rawEvents, { prisma = defaultPrisma } = {}) {
  const list = Array.isArray(rawEvents) ? rawEvents : [];
  const ids = [...new Set(list.map(nasaEventId).filter(Boolean))];
  const recorded = new Set();
  for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
    const rows = await prisma.ingestedEvent.findMany({ where: { eventId: { in: ids.slice(i, i + INSERT_CHUNK) } }, select: { eventId: true } });
    for (const r of rows) recorded.add(r.eventId);
  }
  const fresh = list.filter((e) => !recorded.has(nasaEventId(e)));
  return { fresh, known: list.length - fresh.length };
}

/**
 * One ingestion run: record new feed events, then drain the outbox.
 * Never throws for a single failing source (that source is skipped and the
 * error is logged); a publish failure is reported in `errors` and retried
 * next run.
 *
 * Only the EONET events not yet recorded are rated (GDACS level and point,
 * same client and rules as the public feed): a run after a long sleep used
 * to refresh the lookups of every event of the last 30 days first (hundreds,
 * minutes when GDACS is slow) although none of them is recorded again.
 */
export async function ingestOnce({
  prisma = defaultPrisma,
  fetchNasa = fetchNasaEvents, // raw EONET events; the new ones are rated by `rateNasa`
  rateNasa = (events) => gdacsClient.enrich(events), // attaches the GDACS level and point (waits for the lookups)
  fetchUsgs = fetchUsgsEarthquakes,
  publish = publishDisasterEvents,
  log = console,
} = {}) {
  const events = [];
  const fallback = new Set(); // eventIds placed on the EONET geometry because GDACS was unreachable
  const approximate = new Set(); // eventIds whose location the map marks "approximate"
  const stats = { fetched: 0, known: 0, dropped: 0, inserted: 0, eonetFallback: 0, published: 0, pending: 0, errors: [] };

  const sources = [
    [
      "nasa",
      async () => {
        const { fresh, known } = await unrecordedNasaEvents(await fetchNasa(), { prisma });
        stats.known += known;
        return nasaEventsToContract(await rateNasa(fresh));
      },
    ],
    ["usgs", async () => usgsFeaturesToContract(await fetchUsgs(), { minMag: USGS_MIN_MAG })],
  ];

  for (const [name, load] of sources) {
    try {
      const { events: mapped, dropped, eonetFallback = [], approximate: approx = [] } = await load();
      events.push(...mapped);
      for (const id of eonetFallback) fallback.add(id);
      for (const id of approx) approximate.add(id);
      stats.fetched += mapped.length;
      stats.dropped += dropped;
    } catch (err) {
      stats.errors.push(`${name}: ${err?.message || err}`);
      log.error(`[ingest] ${name} fetch failed:`, err?.message || err);
    }
  }

  stats.fetched += stats.known; // the recorded EONET events count as fetched too: they were delivered, only not rated again

  if (events.length > 0) {
    const fresh = await recordNewEvents(events, { prisma, approximate });
    stats.inserted = fresh.length;
    // recorded once and for good (insert-once): these keep the EONET point even after GDACS is back
    const ids = fresh.filter((e) => fallback.has(e.eventId)).map((e) => e.eventId);
    stats.eonetFallback = ids.length;
    if (ids.length) log.warn(`[ingest] ${ids.length} event(s) recorded with the EONET point because GDACS was unreachable: ${ids.join(", ")}`);
  }

  // Outbox runs even when nothing new was fetched: earlier failures are retried here.
  const outbox = await publishOutbox({ prisma, publish, log });
  stats.published = outbox.published;
  stats.pending = outbox.pending;
  if (outbox.error) stats.errors.push(`publish: ${outbox.error}`);

  return stats;
}

/** A wake-up call within this long after the last run does nothing (the hourly wake is idempotent). */
export const WAKE_MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * One ingestion runner shared by the 5-minute timer and the scheduled wake
 * endpoint (POST /internal/ingest), so the two never run at the same time:
 *
 *   run(trigger)  runs now, or joins the run already in progress;
 *   wake()        the endpoint's entry: does nothing when a run finished
 *                 without errors in the last WAKE_MIN_INTERVAL_MS (a service
 *                 that just woke up has already ingested on start; an awake
 *                 one ingests every 5 minutes), joins a run in progress,
 *                 otherwise runs.
 *   status()      last run time, trigger and counts, for /health.
 *
 * Never throws: a failed run is logged and reported in its result.
 */
export function createIngestRunner({ ingest = ingestOnce, now = () => Date.now(), minIntervalMs = WAKE_MIN_INTERVAL_MS, log = console, ...deps } = {}) {
  let inflight = null;
  let last = null; // { at, trigger, stats | null, error | null }
  let lastWake = null; // { at, outcome }
  const startedAt = now();
  let eonetFallbackTotal = 0; // since this process started (the free plan restarts it after every sleep)

  function run(trigger) {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const stats = await ingest({ log, ...deps });
        last = { at: now(), trigger, stats, error: null };
        eonetFallbackTotal += stats.eonetFallback ?? 0;
        log.log(
          `[ingest] (${trigger}) fetched=${stats.fetched} known=${stats.known ?? 0} new=${stats.inserted} published=${stats.published} pending=${stats.pending}` +
            (stats.errors.length ? ` errors=${stats.errors.join(" | ")}` : "")
        );
      } catch (err) {
        last = { at: now(), trigger, stats: null, error: err?.message || String(err) };
        log.error(`[ingest] (${trigger}) run failed:`, last.error);
      } finally {
        inflight = null;
      }
      return last;
    })();
    return inflight;
  }

  const succeeded = (r) => r && !r.error && !(r.stats?.errors?.length);

  async function wake() {
    const t = now();
    // only a recent run that worked makes a wake-up redundant; a failed one is retried
    if (!inflight && succeeded(last) && t - last.at < minIntervalMs) {
      lastWake = { at: t, outcome: "skipped-recent" };
      return { ran: false, reason: "recent", last };
    }
    const joined = Boolean(inflight);
    const result = await run("wake");
    lastWake = { at: t, outcome: joined ? "joined-running" : result.error ? "failed" : "ran" };
    return { ran: !joined, reason: joined ? "in-progress" : "ran", last: result };
  }

  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  function status() {
    return {
      running: Boolean(inflight),
      lastRunAt: iso(last?.at),
      lastTrigger: last?.trigger ?? null,
      // which part failed ("run", "nasa", "usgs", "publish"), never the upstream message: /health is public
      lastErrorSources: last?.error ? ["run"] : last?.stats?.errors?.length ? last.stats.errors.map((e) => String(e).split(":")[0]) : [],
      lastStats: last?.stats ? { fetched: last.stats.fetched, inserted: last.stats.inserted, eonetFallback: last.stats.eonetFallback ?? 0, published: last.stats.published, pending: last.stats.pending } : null,
      lastWakeAt: iso(lastWake?.at),
      lastWakeOutcome: lastWake?.outcome ?? null,
      // events recorded with the EONET point because GDACS was unreachable (they keep it: insert-once);
      // the event ids are in the log line "[ingest] ... recorded with the EONET point"
      eonetFallbackRecorded: { total: eonetFallbackTotal, since: iso(startedAt) },
    };
  }

  return { run, wake, status };
}

/** Process-wide runner used by index.js (timer) and the wake endpoint. */
export const ingestRunner = createIngestRunner();

/**
 * Runs an ingestion now and then every `intervalMs` through the shared
 * runner. Never throws; failures are logged and the next tick runs normally.
 */
export function startIngestion({ intervalMs = INGEST_INTERVAL_MS, runner = ingestRunner } = {}) {
  const tick = () => runner.run("timer");
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return { stop: () => clearInterval(timer), runNow: tick };
}
