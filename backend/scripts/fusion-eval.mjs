#!/usr/bin/env node
/**
 * Live evaluation of the cross-source matching (docs/scoring.md).
 *
 *   node scripts/fusion-eval.mjs [out.json]
 *
 * Fetches the real sources once, matches them and prints a summary: how many
 * events each source attached to, how many were ambiguous, the spread of the
 * time and distance differences, and the near misses (a USGS quake with an
 * EMSC entry just outside the rule). The JSON written to out.json (default
 * reports/fusion-eval-<date>.json, git-ignored) lists every attached pair and
 * every near miss for review by hand: it holds real third-party data, so it
 * is never committed. Needs no database; FIRMS only with FIRMS_MAP_KEY.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFeedService } from "../src/services/feed.service.js";
import { buildEvents } from "../src/api/v1/events.js";
import { createConfirmingSources } from "../src/services/sources/index.js";
import { matchSources, quakeCost } from "../src/services/fusion/match.js";
import { distanceKm } from "../src/services/sources/firms.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? path.join(here, "..", "..", "reports", `fusion-eval-${new Date().toISOString().slice(0, 10)}.json`);
const quiet = { warn: () => {}, error: () => {}, log: () => {} };

const feed = createFeedService({ log: quiet });
const snap = await feed.snapshot();
const now = Date.now();
const events = buildEvents(snap.served, now);
const sources = createConfirmingSources({ enabled: true, log: console });
const [emsc, nhc] = await Promise.all([sources.emsc.get(), sources.nhc.get()]);
const fires = events.filter((e) => e.type === "wildfire" && now - Date.parse(e.occurredAt) <= 72 * 3600_000);
if (sources.firms.enabled) await sources.firms.refresh(fires);
const firms = sources.firms.enabled ? sources.firms.peek(fires) : null;
const matches = matchSources(events, { emsc: emsc.data, nhc: nhc.data, firms });

const pct = (xs, p) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);
const byType = {};
const pairs = [];
for (const e of events) {
  const m = matches.get(e.id);
  const t = (byType[e.type] ??= { events: 0, ambiguous: 0, bySource: {} });
  t.events++;
  if (m.ambiguous.length) t.ambiguous++;
  for (const s of m.sources.slice(1)) {
    const k = `${s.source}:${s.role}`;
    t.bySource[k] = (t.bySource[k] ?? 0) + 1;
    pairs.push({ event: e.id, title: e.title, ...s });
  }
}

// near misses: a USGS quake without an EMSC entry, but one within 5 min and 300 km
const nearMisses = [];
for (const e of events.filter((x) => x.type === "earthquake" && !matches.get(x.id).sources.some((s) => s.source === "emsc") && !matches.get(x.id).ambiguous.length)) {
  for (const o of emsc.data ?? []) {
    const dt = Math.abs(Date.parse(e.occurredAt) - o.time) / 1000;
    if (dt > 300) continue;
    const dist = distanceKm(e.lat, e.lng, o.lat, o.lng);
    if (dist > 300) continue;
    nearMisses.push({ event: e.id, title: e.title, magnitude: e.measurements.magnitude, emsc: o.sourceId, emscMagnitude: o.magnitude, agency: o.agency, dtSec: Math.round(dt), distanceKm: Math.round(dist), withinRule: quakeCost(e, o) !== null });
  }
}

const emscPairs = pairs.filter((p) => p.source === "emsc");
const summary = {
  at: new Date(now).toISOString(),
  sources: { feed: snap.sources, emsc: emsc.status, nhc: nhc.status, firms: firms ? "ok" : "off" },
  events: events.length,
  byType,
  emsc: {
    observations: emsc.data?.length ?? 0,
    timeDeltaSec: { p50: pct(emscPairs.map((p) => p.timeDeltaSec), 50), p95: pct(emscPairs.map((p) => p.timeDeltaSec), 95), max: pct(emscPairs.map((p) => p.timeDeltaSec), 100) },
    distanceKm: { p50: pct(emscPairs.map((p) => p.distanceKm), 50), p95: pct(emscPairs.map((p) => p.distanceKm), 95), max: pct(emscPairs.map((p) => p.distanceKm), 100) },
    nearMisses: nearMisses.length,
  },
};
console.log(JSON.stringify(summary, null, 2));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ summary, pairs, nearMisses }, null, 2));
console.log(`pairs and near misses written to ${out} (real data: do not commit)`);
