/**
 * Feed ingestion job.
 *
 * Every run fetches NASA EONET + USGS, maps them to the event contract,
 * inserts them into IngestedEvent with ON CONFLICT DO NOTHING and publishes
 * ONLY the rows that were actually inserted (= never seen before) to Kafka.
 * The public GET /disasters feed is untouched by this; it keeps its own
 * cache and fetch path.
 *
 * Dependencies are injectable so tests can run it without network or Kafka.
 */
import { Prisma } from "@prisma/client";
import defaultPrisma from "../prisma.js";
import { fetchNasaEvents } from "../services/nasa.service.js";
import { fetchUsgsEarthquakes } from "../services/usgs.service.js";
import { publishDisasterEvents } from "../services/kafkaProducer.js";
import { nasaEventsToContract, usgsFeaturesToContract } from "../events/mappers.js";

export const INGEST_INTERVAL_MS = 5 * 60 * 1000;
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

/**
 * One ingestion pass. Returns counts; never throws for a single failing
 * source (that source is skipped and the error is logged).
 */
export async function ingestOnce({
  prisma = defaultPrisma,
  fetchNasa = fetchNasaEvents,
  fetchUsgs = fetchUsgsEarthquakes,
  publish = publishDisasterEvents,
  log = console,
} = {}) {
  const events = [];
  const stats = { fetched: 0, dropped: 0, inserted: 0, published: 0, errors: [] };

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

  if (events.length === 0) return stats;

  const fresh = await recordNewEvents(events, { prisma });
  stats.inserted = fresh.length;

  if (fresh.length > 0) {
    try {
      await publish(fresh);
      stats.published = fresh.length;
    } catch (err) {
      // Rows are already recorded, so these events will not be re-published
      // later; log loudly. (A future pass could add a "published" flag.)
      stats.errors.push(`publish: ${err?.message || err}`);
      log.error(`[ingest] publishing ${fresh.length} event(s) failed:`, err?.message || err);
    }
  }

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
        `[ingest] fetched=${s.fetched} new=${s.inserted} published=${s.published}` +
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
