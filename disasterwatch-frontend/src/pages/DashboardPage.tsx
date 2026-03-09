import { useEffect, useMemo, useRef, useState } from "react";
import MapView from "../components/MapView";

type DisasterType = "earthquake" | "flood" | "wildfire" | "storm";
type Severity = "high" | "medium" | "low";

type DisasterItem = {
  id: number;
  type: DisasterType;
  location: string;
  meta: string;
  severity: Severity;
  timeMinutesAgo: number;
  description: string;
  lat: number;
  lng: number;
};

type TimelineEvent = {
  time: string;
  title: string;
  summary: string;
  type: DisasterType;
  severity: Severity;
  locationHint?: string;
};

/* =========================
   FALLBACK (API ÇÖKERSE)
========================= */
const FALLBACK_DISASTERS: DisasterItem[] = [
  {
    id: 1,
    type: "earthquake",
    location: "İzmir, Turkey",
    meta: "Mag 6.2 • 12 min ago • Depth 10 km",
    severity: "high",
    timeMinutesAgo: 12,
    description:
      "A shallow earthquake near the Aegean coast. Local authorities are assessing structural damage in urban areas.",
    lat: 38.42,
    lng: 27.14,
  },
  {
    id: 2,
    type: "flood",
    location: "Rotterdam, Netherlands",
    meta: "River overflow • 1 h ago • Evacuations in progress",
    severity: "medium",
    timeMinutesAgo: 60,
    description:
      "Heavy rainfall combined with high river levels has caused localized flooding in low-lying districts.",
    lat: 51.92,
    lng: 4.48,
  },
  {
    id: 3,
    type: "wildfire",
    location: "California, USA",
    meta: "800 ha affected • 3 h ago • Strong winds",
    severity: "high",
    timeMinutesAgo: 180,
    description:
      "A fast-moving wildfire in dry forest areas. Firefighters are struggling with shifting wind patterns.",
    lat: 37.77,
    lng: -122.42,
  },
  {
    id: 4,
    type: "storm",
    location: "Osaka, Japan",
    meta: "Category 2 • 6 h ago • Heavy rainfall expected",
    severity: "low",
    timeMinutesAgo: 360,
    description:
      "A category 2 storm system approaching the Kansai region with sustained winds and intense rainfall.",
    lat: 34.69,
    lng: 135.5,
  },
];

/* =========================
   HELPERS
========================= */
const severityOrder: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

const getSeverityLabel = (severity: Severity): string => {
  switch (severity) {
    case "high":
      return "⚠ HIGH";
    case "medium":
      return "▲ MEDIUM";
    case "low":
      return "● LOW";
  }
};

const getTypeLabel = (type: DisasterType) => {
  switch (type) {
    case "earthquake":
      return "Earthquake";
    case "flood":
      return "Flood";
    case "wildfire":
      return "Wildfire";
    case "storm":
      return "Storm";
    default:
      return type;
  }
};

const getTypeIcon = (type: DisasterType) => {
  switch (type) {
    case "earthquake":
      return "⟡";
    case "flood":
      return "≈";
    case "wildfire":
      return "✶";
    case "storm":
      return "◌";
    default:
      return "•";
  }
};

const sevDotClass = (s: Severity) =>
  s === "high" ? "dot-high" : s === "medium" ? "dot-medium" : "dot-low";

/** Text normalize for search (lowercase + remove accents) */
const normalizeText = (s: string) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

/** Extract a "city hint" from the location string */
const getCityHint = (location: string) => {
  const loc = (location || "").trim();
  if (!loc) return "";
  const firstChunk = loc.includes(",") ? (loc.split(",")[0] || "").trim() : loc;
  const lower = firstChunk.toLowerCase();
  const ofIdx = lower.lastIndexOf(" of ");
  if (ofIdx >= 0) {
    return firstChunk.slice(ofIdx + 4).trim();
  }
  const cleaned = firstChunk
    .replace(/^\s*\d+(?:\.\d+)?\s*(km|mi)\b[^a-zA-Z]+/i, "")
    .trim();
  return cleaned || firstChunk;
};

/* =========================
   COUNTRIES AFFECTED (ACCURATE)
   - US state => USA
   - ISO-2 codes => English country name (Intl.DisplayNames)
========================= */
const US_STATES = new Set([
  "Alabama",
  "Alaska",
  "Arizona",
  "Arkansas",
  "California",
  "Colorado",
  "Connecticut",
  "Delaware",
  "Florida",
  "Georgia",
  "Hawaii",
  "Idaho",
  "Illinois",
  "Indiana",
  "Iowa",
  "Kansas",
  "Kentucky",
  "Louisiana",
  "Maine",
  "Maryland",
  "Massachusetts",
  "Michigan",
  "Minnesota",
  "Mississippi",
  "Missouri",
  "Montana",
  "Nebraska",
  "Nevada",
  "New Hampshire",
  "New Jersey",
  "New Mexico",
  "New York",
  "North Carolina",
  "North Dakota",
  "Ohio",
  "Oklahoma",
  "Oregon",
  "Pennsylvania",
  "Rhode Island",
  "South Carolina",
  "South Dakota",
  "Tennessee",
  "Texas",
  "Utah",
  "Vermont",
  "Virginia",
  "Washington",
  "West Virginia",
  "Wisconsin",
  "Wyoming",
  "District of Columbia",
]);

const US_STATE_ABBR = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "DC",
  "PR",
  "GU",
  "VI",
  "MP",
  "AS",
]);

const regionNames =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

const iso2ToEnglishCountry = (code2: string) => {
  const c = (code2 || "").trim().toUpperCase();
  if (!regionNames) return null;
  if (!/^[A-Z]{2}$/.test(c)) return null;
  const name = regionNames.of(c);
  return name || null;
};

const normalizeCountryToken = (raw: string) => {
  const s = (raw || "").trim();
  if (!s) return "Unknown";

  if (/^(us|u\.s\.|u\.s\.a\.|usa|united states)$/i.test(s)) return "USA";
  if (/^(uk|u\.k\.|united kingdom|great britain)$/i.test(s))
    return "United Kingdom";
  if (/^(uae|u\.a\.e\.|united arab emirates)$/i.test(s))
    return "United Arab Emirates";
  if (/^(turkiye|türkiye)$/i.test(s)) return "Turkey";

  const isoName = iso2ToEnglishCountry(s);
  if (isoName) return isoName;

  return s;
};

const isObviouslyNotACountry = (token: string) => {
  const t = normalizeText(token);
  if (!t) return true;

  if (/\d/.test(t)) return true;
  if (t.includes(" km") || t.includes("miles") || t.includes(" mi")) return true;

  if (t.includes("region")) return true;
  if (t.includes(" of ")) return true;
  if (t.includes("island") || t.includes("islands")) return true;
  if (t.includes("sea") || t.includes("ocean")) return true;
  if (t.includes("coast")) return true;

  if (t.length > 30) return true;

  return false;
};

const looksLikeUsgsPlace = (loc: string) => {
  const t = normalizeText(loc);
  return t.includes(" km ") || t.includes(" mi ") || t.includes(" of ");
};

/**
 * Extract country in a robust way:
 * - "..., Texas" / "... , CA" (USGS) => USA
 * - "... , MX" => Mexico (Intl)
 * - "... , Turkey" => Turkey
 */
const extractCountry = (location: string): string => {
  const loc = (location || "").trim();
  if (!loc) return "Unknown";

  const hasComma = loc.includes(",");
  const last = hasComma ? (loc.split(",").pop() || "").trim() : "";

  if (last && US_STATES.has(last)) return "USA";
  if (last && US_STATE_ABBR.has(last.toUpperCase())) {
    if (looksLikeUsgsPlace(loc)) return "USA";
  }

  if (last) {
    const norm = normalizeCountryToken(last);
    if (!isObviouslyNotACountry(norm) && norm.length >= 2) return norm;
  }

  const lower = loc.toLowerCase();
  for (const st of US_STATES) {
    if (lower.includes(st.toLowerCase())) return "USA";
  }

  if (looksLikeUsgsPlace(loc)) {
    for (const abbr of US_STATE_ABBR) {
      const re = new RegExp(`\\b${abbr}\\b`, "i");
      if (re.test(loc)) return "USA";
    }
  }

  return "Unknown";
};

/* =========================
   PERFORMANCE LIMITS
========================= */
const LIST_PAGE_SIZE = 50;
const MAP_MAX_MARKERS = 300;
const MAP_EARTHQUAKE_CAP = 15;

const DashboardPage = () => {
  const [disasters, setDisasters] = useState<DisasterItem[]>(FALLBACK_DISASTERS);
  const [activeFilter, setActiveFilter] = useState<"all" | DisasterType>("all");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"time" | "severity">("time");
  const [selectedDisaster, setSelectedDisaster] = useState<DisasterItem | null>(
    null
  );
  const [minutesSinceRefresh, setMinutesSinceRefresh] = useState(0);
  const [page, setPage] = useState(1);

  const listRef = useRef<HTMLDivElement | null>(null);

  const scrollListToTop = () => {
    listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const applyFilter = (f: "all" | DisasterType) => {
    setActiveFilter(f);
    setPage(1);
    scrollListToTop();
  };

  /* =========================
     FETCH – Backend (NASA EONET + USGS merged)
  ========================= */
  useEffect(() => {
    let cancelled = false;

    async function fetchDisasters() {
      try {
        const res = await fetch("/api/disasters");
        const data = res.ok ? await res.json() : { items: [] };
        const items: DisasterItem[] = Array.isArray(data?.items) ? data.items : [];

        const hasFlood = items.some((d) => d.type === "flood");
        const fallbackFloodsSafe: DisasterItem[] = hasFlood
          ? []
          : FALLBACK_DISASTERS.filter((d) => d.type === "flood").map((d, i) => ({
              ...d,
              id: 900000000 + i,
            }));

        const combined = [...items, ...fallbackFloodsSafe];

        if (!cancelled) {
          setDisasters(combined.length ? combined : FALLBACK_DISASTERS);
          setMinutesSinceRefresh(0);
        }
      } catch {
        if (!cancelled) setDisasters(FALLBACK_DISASTERS);
      }
    }

    fetchDisasters();
    return () => {
      cancelled = true;
    };
  }, []);

  /* =========================
     TIMER
  ========================= */
  useEffect(() => {
    const start = Date.now();
    const i = setInterval(() => {
      setMinutesSinceRefresh(Math.floor((Date.now() - start) / 60000));
    }, 60000);
    return () => clearInterval(i);
  }, []);

  /* =========================
     SMART SEARCH (country/city priority)
  ========================= */
  const getSearchScore = (d: DisasterItem, qRaw: string) => {
    const q = normalizeText(qRaw);
    if (!q) return 1;

    const locN = normalizeText(d.location);
    const descN = normalizeText(d.description);
    const metaN = normalizeText(d.meta);

    const country = extractCountry(d.location);
    const countryN = normalizeText(country);

    const city = getCityHint(d.location);
    const cityN = normalizeText(city);

    let score = 0;

    if (countryN === q) score += 200;
    else if (countryN.startsWith(q)) score += 160;
    else if (countryN.includes(q)) score += 120;

    if (cityN === q) score += 180;
    else if (cityN.startsWith(q)) score += 140;
    else if (cityN.includes(q)) score += 100;

    if (locN.startsWith(q)) score += 90;
    else if (locN.includes(q)) score += 60;

    if (descN.includes(q)) score += 25;
    if (metaN.includes(q)) score += 15;

    return score;
  };

  /* =========================
     filteredDisasters (correct + search scoring)
  ========================= */
  const filteredDisasters = useMemo(() => {
    let data = [...disasters];

    if (activeFilter !== "all") {
      data = data.filter((d) => d.type === activeFilter);
    }

    if (search.trim()) {
      const q = search.trim();
      data = data
        .map((d) => ({ d, score: getSearchScore(d, q) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.d.timeMinutesAgo - b.d.timeMinutesAgo)
        .map((x) => x.d);
    }

    if (!search.trim()) {
      data.sort((a, b) =>
        sortBy === "time"
          ? a.timeMinutesAgo - b.timeMinutesAgo
          : severityOrder[a.severity] - severityOrder[b.severity]
      );
    }

    return data;
  }, [disasters, activeFilter, search, sortBy]);

  /* =========================
     TODAY EVENTS (REAL DATA)
  ========================= */
  const todayEvents: TimelineEvent[] = useMemo(() => {
    const top = filteredDisasters
      .slice()
      .sort((a, b) => a.timeMinutesAgo - b.timeMinutesAgo)
      .slice(0, 4);

    const fmtTime = (mins: number) => {
      if (mins <= 0) return "Now";
      if (mins < 60) return `${mins}m ago`;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return m === 0 ? `${h}h ago` : `${h}h ${m}m ago`;
    };

    return top.map((d) => ({
      time: fmtTime(d.timeMinutesAgo),
      title: `${getTypeLabel(d.type)} reported`,
      summary: d.description || d.meta || d.location,
      type: d.type,
      severity: d.severity,
      locationHint: d.location,
    }));
  }, [filteredDisasters]);

  /* =========================
     KPI (FILTER-AWARE)
     (Search DOES NOT affect KPI, only filter does)
  ========================= */
  const kpiDisasters = useMemo(() => {
    if (activeFilter === "all") return disasters;
    return disasters.filter((d) => d.type === activeFilter);
  }, [disasters, activeFilter]);

  const totalDisasters = kpiDisasters.length;

  const activeAlerts = useMemo(
    () => kpiDisasters.filter((d) => d.severity === "high").length,
    [kpiDisasters]
  );

  const updatedLabel =
    minutesSinceRefresh === 0
      ? "Last updated: just now (NASA + USGS live data)"
      : `Last updated: ${minutesSinceRefresh} min ago (NASA + USGS live data)`;

  /* =========================
     MAP DATA
     - For earthquakes: show last 15 (even low)
     - For others: medium/high only + wildfire per-country cap
  ========================= */
  const MAX_WILDFIRE_PER_COUNTRY = 30;

  const mapDisasters = useMemo(() => {
    const countryCounter = new Map<string, number>();

    const showEarthquakes = activeFilter === "all" || activeFilter === "earthquake";

    const eq = showEarthquakes
      ? filteredDisasters
          .filter((d) => d.type === "earthquake")
          .slice()
          .sort((a, b) => a.timeMinutesAgo - b.timeMinutesAgo)
          .slice(0, MAP_EARTHQUAKE_CAP)
      : [];

    const baseNonEq = filteredDisasters.filter((d) => d.type !== "earthquake");

    const nonEq = baseNonEq
      .filter((d) => d.severity === "high" || d.severity === "medium")
      .filter((d) => {
        if (d.type !== "wildfire") return true;

        const country = extractCountry(d.location) || "Unknown";
        const current = countryCounter.get(country) ?? 0;

        if (current >= MAX_WILDFIRE_PER_COUNTRY) return false;

        countryCounter.set(country, current + 1);
        return true;
      });

    const merged = [...eq, ...nonEq].slice(0, MAP_MAX_MARKERS);
    return merged;
  }, [filteredDisasters, activeFilter]);

  /* =========================
     ✅ COUNTRIES AFFECTED (MAP-BASED + reverse geocode fallback)
     - “haritada gösterilen her ülkeyi saysın”
     - filtre değişince harita değişir => sayı da otomatik değişir
  ========================= */

  // Reverse geocode cache (coordKey -> countryName)
  const [reverseCountryByKey, setReverseCountryByKey] = useState<Record<string, string>>({});
  const inFlightKeysRef = useRef<Set<string>>(new Set());

  // Coordinate key (rounded for stable caching)
  const coordKey = (lat: number, lng: number) => {
    const la = Math.round(lat * 100) / 100;
    const lo = Math.round(lng * 100) / 100;
    return `${la},${lo}`;
  };

  const getCountryForMapItem = (d: DisasterItem) => {
    const direct = extractCountry(d.location);
    if (direct && direct !== "Unknown") return direct;

    if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) return "Unknown";

    const key = coordKey(d.lat, d.lng);
    const cached = reverseCountryByKey[key];
    if (cached) return cached;

    return "Unknown";
  };

  // Reverse geocode only for items that still have Unknown country
  useEffect(() => {
    let cancelled = false;

    const needs = new Map<string, { lat: number; lng: number }>();

    for (const d of mapDisasters) {
      const direct = extractCountry(d.location);
      if (direct !== "Unknown") continue;

      if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) continue;

      const key = coordKey(d.lat, d.lng);

      if (reverseCountryByKey[key]) continue;
      if (inFlightKeysRef.current.has(key)) continue;

      needs.set(key, { lat: d.lat, lng: d.lng });
    }

    if (!needs.size) return;

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    (async () => {
      for (const [key, coords] of needs) {
        if (cancelled) break;

        inFlightKeysRef.current.add(key);

        try {
          // Nominatim reverse geocode (browser fetch)
          const url =
            `https://nominatim.openstreetmap.org/reverse?` +
            `format=jsonv2&lat=${encodeURIComponent(coords.lat)}` +
            `&lon=${encodeURIComponent(coords.lng)}` +
            `&zoom=5&addressdetails=1&accept-language=en`;

          const res = await fetch(url, {
            method: "GET",
            headers: { Accept: "application/json" },
          });

          if (!res.ok) throw new Error("reverse geocode failed");

          const json = await res.json();

          const address = json?.address || {};
          const countryNameRaw: string | undefined = address?.country;
          const countryCodeRaw: string | undefined = address?.country_code;

          let resolved = "Unknown";

          // Prefer official country name
          if (countryNameRaw && String(countryNameRaw).trim()) {
            resolved = normalizeCountryToken(String(countryNameRaw).trim());
          } else if (countryCodeRaw && String(countryCodeRaw).trim()) {
            const cc = String(countryCodeRaw).trim().toUpperCase();
            const isoName = iso2ToEnglishCountry(cc);
            if (isoName) resolved = isoName;
          }

          if (!cancelled && resolved && resolved !== "Unknown") {
            setReverseCountryByKey((prev) => {
              if (prev[key] === resolved) return prev;
              return { ...prev, [key]: resolved };
            });
          }
        } catch {
          // ignore
        } finally {
          // polite delay to avoid hitting rate limits too hard
          await sleep(350);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mapDisasters, reverseCountryByKey]);

  // ✅ Countries affected now counts ONLY countries visible on map
  const countriesAffected = useMemo(() => {
    const set = new Set<string>();
    for (const d of mapDisasters) {
      const c = getCountryForMapItem(d);
      if (c && c !== "Unknown") set.add(c);
    }
    return set.size;
  }, [mapDisasters, reverseCountryByKey]);

  /* =========================
     PAGINATION (filteredDisasters)
  ========================= */
  const totalPages = Math.max(1, Math.ceil(filteredDisasters.length / LIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const pagedDisasters = useMemo(() => {
    const start = (safePage - 1) * LIST_PAGE_SIZE;
    return filteredDisasters.slice(start, start + LIST_PAGE_SIZE);
  }, [filteredDisasters, safePage]);

  const canPrev = safePage > 1;
  const canNext = safePage < totalPages;

  return (
    <>
      {/* Üst Başlık Alanı */}
      <section className="dashboard-header">
        <div>
          <h1 className="dashboard-title">Global Disaster Overview</h1>
          <p className="dashboard-subtitle">Live monitoring powered by NASA EONET + USGS.</p>
        </div>

        <div className="dashboard-header-meta">
          <span className="badge-live">LIVE</span>
          <span className="dashboard-updated">{updatedLabel}</span>
        </div>
      </section>

      {/* KPI Kartları */}
      <section className="dashboard-kpis">
        <div className="kpi-card">
          <span className="kpi-label">Disasters</span>
          <span className="kpi-value">{totalDisasters}</span>
          <span className="kpi-footnote">NASA + USGS</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">Active alerts</span>
          <span className="kpi-value kpi-value-warning">{activeAlerts}</span>
          <span className="kpi-footnote">High severity</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">Countries affected</span>
          <span className="kpi-value">{countriesAffected}</span>
          <span className="kpi-footnote">Unique countries</span>
        </div>
      </section>

      {/* Ana grid (map + liste) */}
      <main className="app-main">
        {/* MAP PANEL */}
        <section className="map-panel">
          <div className="panel-header">
            <h2>Map view</h2>
            <span className="panel-caption">
              Showing max {MAP_MAX_MARKERS} markers • Earthquakes: last {MAP_EARTHQUAKE_CAP}.
            </span>
          </div>

          {/* Leaflet marker cache sorunlarına karşı reset */}
          <MapView
            key={activeFilter}
            disasters={mapDisasters}
            highlightId={selectedDisaster?.id ?? null}
          />

          {/* YATAY LEGEND */}
          <div className="map-legend">
            <span className="legend-title">Legend</span>
            <div className="legend-pills">
              <div className="legend-pill">
                <span className="legend-dot legend-dot-earthquake" />
                <span>Earthquake</span>
              </div>
              <div className="legend-pill">
                <span className="legend-dot legend-dot-flood" />
                <span>Flood</span>
              </div>
              <div className="legend-pill">
                <span className="legend-dot legend-dot-wildfire" />
                <span>Wildfire</span>
              </div>
              <div className="legend-pill">
                <span className="legend-dot legend-dot-storm" />
                <span>Storm</span>
              </div>
            </div>
          </div>
        </section>

        {/* LIST PANEL */}
        <section className="list-panel">
          <div className="panel-header">
            <h2>Disaster feed</h2>
            <span className="panel-caption">
              Showing {LIST_PAGE_SIZE} per page • Total filtered: {filteredDisasters.length}
            </span>
          </div>

          {/* Filter + search + sort toolbar */}
          <div className="disaster-toolbar">
            <div className="disaster-filters">
              <button
                type="button"
                className={"filter-chip " + (activeFilter === "all" ? "filter-chip-active" : "")}
                onClick={() => applyFilter("all")}
              >
                All
              </button>

              <button
                type="button"
                className={
                  "filter-chip " + (activeFilter === "earthquake" ? "filter-chip-active" : "")
                }
                onClick={() => applyFilter("earthquake")}
              >
                Earthquakes
              </button>

              <button
                type="button"
                className={"filter-chip " + (activeFilter === "flood" ? "filter-chip-active" : "")}
                onClick={() => applyFilter("flood")}
              >
                Floods
              </button>

              <button
                type="button"
                className={
                  "filter-chip " + (activeFilter === "wildfire" ? "filter-chip-active" : "")
                }
                onClick={() => applyFilter("wildfire")}
              >
                Wildfires
              </button>

              <button
                type="button"
                className={"filter-chip " + (activeFilter === "storm" ? "filter-chip-active" : "")}
                onClick={() => applyFilter("storm")}
              >
                Storms
              </button>
            </div>

            <div className="disaster-tools">
              <input
                type="text"
                className="disaster-search"
                placeholder="Search city or country…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                  scrollListToTop();
                }}
              />
              <select
                className="disaster-sort"
                value={sortBy}
                onChange={(e) => {
                  setSortBy(e.target.value as "time" | "severity");
                  setPage(1);
                  scrollListToTop();
                }}
                disabled={!!search.trim()}
                title={search.trim() ? "Sorting is auto-prioritized while searching." : ""}
              >
                <option value="time">Sort: Newest</option>
                <option value="severity">Sort: Severity</option>
              </select>
            </div>
          </div>

          {/* Pagination controls */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <button
              type="button"
              className="filter-chip"
              disabled={!canPrev}
              onClick={() => {
                setPage((p) => Math.max(1, p - 1));
                scrollListToTop();
              }}
              style={{ opacity: canPrev ? 1 : 0.5, cursor: canPrev ? "pointer" : "not-allowed" }}
            >
              ◀ Prev
            </button>

            <span style={{ fontSize: 13, opacity: 0.9 }}>
              Page <strong>{safePage}</strong> / <strong>{totalPages}</strong>
            </span>

            <button
              type="button"
              className="filter-chip"
              disabled={!canNext}
              onClick={() => {
                setPage((p) => Math.min(totalPages, p + 1));
                scrollListToTop();
              }}
              style={{ opacity: canNext ? 1 : 0.5, cursor: canNext ? "pointer" : "not-allowed" }}
            >
              Next ▶
            </button>
          </div>

          {/* Scrollable list container */}
          <div ref={listRef} style={{ maxHeight: 520, overflowY: "auto", paddingRight: 6 }}>
            <ul className="disaster-list">
              {pagedDisasters.map((item) => (
                <li key={item.id} className="disaster-row" onClick={() => setSelectedDisaster(item)}>
                  <div className="disaster-row-main">
                    <div className="disaster-row-top">
                      <span
                        className={
                          "disaster-type-tag " +
                          (item.type === "earthquake"
                            ? "tag-earthquake"
                            : item.type === "flood"
                            ? "tag-flood"
                            : item.type === "wildfire"
                            ? "tag-wildfire"
                            : "tag-storm")
                        }
                      >
                        {getTypeLabel(item.type)}
                      </span>
                      <span className="disaster-location">{item.location}</span>
                    </div>
                    <div className="disaster-meta">{item.meta}</div>
                  </div>

                  <span
                    className={
                      "disaster-severity " +
                      (item.severity === "high"
                        ? "severity-high"
                        : item.severity === "medium"
                        ? "severity-medium"
                        : "severity-low")
                    }
                  >
                    {getSeverityLabel(item.severity)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* TODAY'S EVENTS (REAL DATA) */}
          <section className="timeline timeline-upgraded">
            <div className="timeline-header">
              <h3 className="timeline-title">Today&apos;s events</h3>
              <span className="timeline-hint">Hover on an item for details</span>
            </div>

            <ul className="timeline-list">
              {todayEvents.map((ev, idx) => (
                <li key={idx} className="timeline-item">
                  <div className="timeline-timewrap">
                    <span className="timeline-time">{ev.time}</span>
                  </div>

                  <div className="timeline-card">
                    <div className="timeline-line">
                      <span className={"timeline-dot " + sevDotClass(ev.severity)} />
                      <span className={"timeline-type-icon icon-" + ev.type}>
                        {getTypeIcon(ev.type)}
                      </span>
                      <span className="timeline-item-title">{ev.title}</span>
                    </div>

                    <p className="timeline-item-summary">{ev.summary}</p>

                    <div className="timeline-hovercard">
                      <div className="timeline-hovercard-top">
                        <span className={"timeline-mini-tag type-" + ev.type}>
                          {getTypeLabel(ev.type)}
                        </span>

                        <span
                          className={
                            "timeline-mini-sev " +
                            (ev.severity === "high"
                              ? "sev-high"
                              : ev.severity === "medium"
                              ? "sev-medium"
                              : "sev-low")
                          }
                        >
                          {ev.severity}
                        </span>
                      </div>

                      <div className="timeline-hovercard-body">
                        {ev.locationHint ? (
                          <div>
                            <strong>Location:</strong> {ev.locationHint}
                          </div>
                        ) : null}
                        <div style={{ marginTop: ev.locationHint ? 6 : 0 }}>{ev.summary}</div>
                      </div>

                      <div className="timeline-hovercard-foot">Live event</div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </section>
      </main>

      {/* DETAIL DRAWER */}
      {selectedDisaster && (
        <>
          <div className="detail-overlay" onClick={() => setSelectedDisaster(null)} />
          <aside className="detail-drawer">
            <header className="detail-header">
              <div className="detail-header-main">
                <span
                  className={
                    "disaster-type-tag " +
                    (selectedDisaster.type === "earthquake"
                      ? "tag-earthquake"
                      : selectedDisaster.type === "flood"
                      ? "tag-flood"
                      : selectedDisaster.type === "wildfire"
                      ? "tag-wildfire"
                      : "tag-storm")
                  }
                >
                  {getTypeLabel(selectedDisaster.type)}
                </span>
                <h3 className="detail-title">{selectedDisaster.location}</h3>
                <p className="detail-meta">{selectedDisaster.meta}</p>
              </div>
              <button type="button" className="detail-close-btn" onClick={() => setSelectedDisaster(null)}>
                ✕
              </button>
            </header>

            <div className="detail-body">
              <p className="detail-description">{selectedDisaster.description}</p>

              <div className="detail-footer">
                <span
                  className={
                    "disaster-severity " +
                    (selectedDisaster.severity === "high"
                      ? "severity-high"
                      : selectedDisaster.severity === "medium"
                      ? "severity-medium"
                      : "severity-low")
                  }
                >
                  {getSeverityLabel(selectedDisaster.severity)}
                </span>
                <span className="detail-footnote">
                  Live view • this panel can include links to external maps, emergency contacts and related news.
                </span>
              </div>
            </div>
          </aside>
        </>
      )}
    </>
  );
};

export default DashboardPage;

