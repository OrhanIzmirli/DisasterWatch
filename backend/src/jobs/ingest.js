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
import { fetchNasaEventsRated } from "../services/nasa.service.js";
import { fetchUsgsEarthquakes } from "../services/usgs.service.js";
import { publishDisasterEvents } from "../services/kafkaProducer.js";
import { nasaEventsToContract, usgsFeaturesToContract } from "../events/mappers.js";

export const INGEST_INTERVAL_MS = 5 * 60 * 1000;
export const OUTBOX_BATCH = 500; // rows considered per run
export const PUBLISH_CHUNK = 50; // rows per Kafka send; marked after each successful send
const INSERT_CHUNK = 200;
const USGS_MIN_MAG = 4.5; // same threshold as the public feed; micro-quakes are not alerts

/**
 * Inserts events and returns the subset that was newly inserted.
 * One round trip per chunk thanks to RETURNING.
 */
export async function recordNewEvents(events, { prisma = defaultPrisma } = {}) {
  const inserted = [];
  for (let i = 0; i < events.length; i += INSERT_CHUNK) {
    const chunk = events.slice(i, i + INSERT_CHUNK);
    const rows = await prisma.$queryRaw`
      INSERT INTO "IngestedEvent" ("eventId", "source", "type", "severity", "title", "lat", "lng", "occurredAt")
      VALUES ${Prisma.join(
        chunk.map(
          (e) =>
            Prisma.sql`(${e.eventId}, ${e.source}, ${e.type}, ${e.severity}, ${e.title}, ${e.lat}, ${e.lng}, ${new Date(e.occurredAt)})`
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
 * One ingestion run: record new feed events, then drain the outbox.
 * Never throws for a single failing source (that source is skipped and the
 * error is logged); a publish failure is reported in `errors` and retried
 * next run.
 */
export async function ingestOnce({
  prisma = defaultPrisma,
  fetchNasa = fetchNasaEventsRated, // same GDACS-rated events as the public feed
  fetchUsgs = fetchUsgsEarthquakes,
  publish = publishDisasterEvents,
  log = console,
} = {}) {
  const events = [];
  const stats = { fetched: 0, dropped: 0, inserted: 0, published: 0, pending: 0, errors: [] };

  const sources = [
    ["nasa", async () => nasaEventsToContract(await fetchNasa())],
    ["usgs", async () => usgsFeaturesToContract(await fetchUsgs(), { minMag: USGS_MIN_MAG })],
  ];

  for (const [name, load] of sources) {
    try {
      const { events: mapped, dropped } = await load();
      events.push(...mapped);
      stats.fetched += mapped.length;
      stats.dropped += dropped;
    } catch (err) {
      stats.errors.push(`${name}: ${err?.message || err}`);
      log.error(`[ingest] ${name} fetch failed:`, err?.message || err);
    }
  }

  if (events.length > 0) {
    const fresh = await recordNewEvents(events, { prisma });
    stats.inserted = fresh.length;
  }

  // Outbox runs even when nothing new was fetched: earlier failures are retried here.
  const outbox = await publishOutbox({ prisma, publish, log });
  stats.published = outbox.published;
  stats.pending = outbox.pending;
  if (outbox.error) stats.errors.push(`publish: ${outbox.error}`);

  return stats;
}

/**
 * Runs ingestOnce now and then every `intervalMs`. Never throws; failures are
 * logged and the next tick runs normally.
 */
export function startIngestion({ intervalMs = INGEST_INTERVAL_MS, log = console, ...deps } = {}) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const s = await ingestOnce({ log, ...deps });
      log.log(
        `[ingest] fetched=${s.fetched} new=${s.inserted} published=${s.published} pending=${s.pending}` +
          (s.errors.length ? ` errors=${s.errors.join(" | ")}` : "")
      );
    } catch (err) {
      log.error("[ingest] run failed:", err?.message || err);
    } finally {
      running = false;
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return { stop: () => clearInterval(timer), runNow: tick };
}
