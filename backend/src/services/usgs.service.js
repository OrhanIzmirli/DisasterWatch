// backend/src/services/usgs.service.js

function toId(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

function severityFromMag(mag) {
  if (mag >= 6) return "high";
  if (mag >= 5) return "medium";
  return "low";
}

export async function fetchUsgsEarthquakes() {
  // More stable + small enough: all_day
  const url =
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`USGS request failed: ${res.status}`);

    const data = await res.json();
    return Array.isArray(data?.features) ? data.features : [];
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeUsgsEarthquakes(features, { minMag = 4.5, limit = 300 } = {}) {
  const arr = Array.isArray(features) ? features : [];

  const items = arr
    .map((f) => {
      const mag = Number(f?.properties?.mag);
      const place = String(f?.properties?.place || "Unknown location");
      const time = Number(f?.properties?.time); // ms

      const coords = f?.geometry?.coordinates; // [lng, lat, depth]
      const lng = Array.isArray(coords) ? Number(coords[0]) : null;
      const lat = Array.isArray(coords) ? Number(coords[1]) : null;

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      if (!Number.isFinite(mag) || mag < minMag) return null;
      if (!Number.isFinite(time)) return null;

      const timeMinutesAgo = Math.max(0, Math.floor((Date.now() - time) / 60000));
      const severity = severityFromMag(mag);

      return {
        id: toId(String(f?.id ?? place)),
        type: "earthquake",
        location: place,
        meta: `Mag ${mag.toFixed(1)} • ${timeMinutesAgo} min ago`,
        severity,
        timeMinutesAgo,
        description: `Earthquake detected • Magnitude ${mag.toFixed(1)}`,
        lat,
        lng,
      };
    })
    .filter(Boolean);

  // newest first (small minutesAgo)
  items.sort((a, b) => a.timeMinutesAgo - b.timeMinutesAgo);

  return items.slice(0, limit);
}
