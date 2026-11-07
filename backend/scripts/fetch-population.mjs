#!/usr/bin/env node
/**
 * Downloads the GeoNames "cities5000" gazetteer (places of 5,000 people or more,
 * CC BY 4.0, https://download.geonames.org/export/dump/readme.txt) and writes
 * the compact table the exposure term of the priority score reads:
 *
 *   data/population.json  { source, licence, attribution, downloadedAt, places: [[lat, lng, population], ...] }
 *
 *   node scripts/fetch-population.mjs [out.json]
 *
 * Run by the Dockerfile at build time, so the running service never downloads
 * it and the repository holds no copy (data/ is git-ignored). Exits 0 with a
 * warning when the download fails: exposure is then "unknown".
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

export const GEONAMES_URL = "https://download.geonames.org/export/dump/cities5000.zip";
const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? path.join(here, "..", "data", "population.json");

/** The first file of a zip archive (stored or deflated), read via the central directory. */
export function unzipFirst(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("zip central directory not found");
  const method = buf.readUInt16LE(cd + 10);
  const compressed = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("zip local header not found");
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + compressed);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`zip method ${method} not supported`);
}

/**
 * Feature codes left out: sections of a city (PPLX, counted in the city
 * already), historical, abandoned and destroyed places.
 */
const SKIPPED_CODES = new Set(["PPLX", "PPLH", "PPLQ", "PPLW", "PPLCH"]);

/** GeoNames tab-separated rows -> [[lat, lng, population]] (lat/lng to 3 decimals, populated places only). */
export function parseGeonames(text) {
  const places = [];
  for (const line of text.split("\n")) {
    const c = line.split("\t");
    if (c.length < 15) continue;
    const lat = Number(c[4]);
    const lng = Number(c[5]);
    const pop = Number(c[14]);
    if (c[6] !== "P" || SKIPPED_CODES.has(c[7]) || !Number.isFinite(lat) || !Number.isFinite(lng) || !(pop > 0)) continue;
    places.push([Math.round(lat * 1000) / 1000, Math.round(lng * 1000) / 1000, pop]);
  }
  return places;
}

async function main() {
  try {
    const res = await fetch(GEONAMES_URL, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const places = parseGeonames(unzipFirst(Buffer.from(await res.arrayBuffer())).toString("utf8"));
    if (places.length < 10_000) throw new Error(`only ${places.length} places`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      out,
      JSON.stringify({
        source: GEONAMES_URL,
        licence: "CC BY 4.0",
        attribution: "GeoNames (https://www.geonames.org), CC BY 4.0",
        downloadedAt: new Date().toISOString(),
        places,
      })
    );
    console.log(`population: ${places.length} places written to ${out}`);
  } catch (err) {
    console.warn(`population: GeoNames download failed (${err.message}); exposure will be unknown`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
