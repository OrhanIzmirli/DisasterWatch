import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useSearchParams } from "react-router-dom";
import FeedRow from "../components/FeedRow";
import { kpiFromCounts, kpiFromItems, readCounts, type FeedCounts } from "../utils/kpi";
import RelatedNews from "../components/RelatedNews";
import EventDetailDrawer, { type EventDetails } from "../components/EventDetailDrawer";
import { relativeTime } from "../utils/formatDate";
import { cleanTitle, eventRelativeTime, eventTitle } from "../utils/eventText";
import { getCachedFeed, isFeedFresh, setCachedFeed, type FeedSources, type FeedSourcesUpdatedAt } from "../services/feedCache";
import HeadlineStrip from "../components/HeadlineStrip";
import { headlineText } from "../utils/headline";
import { pulseIds } from "../utils/liveness";
import { usePrefersReducedMotion } from "../utils/usePrefersReducedMotion";
import { PHONE_QUERY, useMediaQuery } from "../utils/useMediaQuery";

// Leaflet and the map code load on demand, only when a map is on screen.
const MapView = lazy(() => import("../components/MapChunk"));

type DisasterType = "earthquake" | "flood" | "wildfire" | "storm";
type Severity = "high" | "medium" | "low" | "unrated";

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
  /** Country derived by the backend from the source place name; null when not derivable. */
  country?: string | null;
  /** Rich, source-faithful fields (present for live NASA/USGS items). */
  details?: EventDetails;
};

type FeedStatus = "loading" | "ready" | "error";

/** Feed row title: clean title from the backend, else the raw location minus a trailing id. */
const displayTitle = (item: DisasterItem) => eventTitle(item);

/**
 * Feed row meta: "M 6.1 · 1 hour ago" / "Wildfires · 21 hours ago". The time
 * is always relative (from occurredAt, else the minutes-ago counter) and the
 * magnitude is the backend's pre-formatted label, so no surface rounds on
 * its own. The raw backend meta line ("240 min ago") is never rendered.
 */
const displayMeta = (item: DisasterItem) => {
  const rel = eventRelativeTime(item);
  const lead =
    item.type === "earthquake"
      ? item.details?.magnitudeLabel
        ? `M ${item.details.magnitudeLabel}`
        : null
      : item.details?.category ?? getTypeLabel(item.type);
  return [lead, rel].filter(Boolean).join(" · ");
};

/** Narrows the backend's `sources` field; anything unexpected counts as "not reported". */
const readSources = (raw: unknown): FeedSources | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown): v is "ok" | "stale" | "error" => v === "ok" || v === "stale" || v === "error";
  return ok(r.nasa) && ok(r.usgs) ? { nasa: r.nasa, usgs: r.usgs } : null;
};

/** Narrows the backend's `sourcesUpdatedAt` field (ISO strings or null per source). */
const readSourcesUpdatedAt = (raw: unknown): FeedSourcesUpdatedAt | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const t = (v: unknown) => (typeof v === "string" && !Number.isNaN(new Date(v).getTime()) ? v : null);
  return { nasa: t(r.nasa), usgs: t(r.usgs) };
};

/** ISO string or null; used for the backend's `updatedAt`. */
const readIso = (raw: unknown): string | null => (typeof raw === "string" && !Number.isNaN(new Date(raw).getTime()) ? raw : null);

const SOURCE_LABEL = { nasa: "NASA EONET", usgs: "USGS" } as const;
const SOURCE_ITEMS = { nasa: "wildfires, storms and floods", usgs: "earthquakes" } as const;

type TimelineEvent = {
  time: string;
  title: string;
  summary: string;
  type: DisasterType;
  severity: Severity;
  locationHint?: string;
};

/* =========================
   HELPERS
========================= */
// sort by severity puts not-rated events last
const severityOrder: Record<Severity, number> = { high: 0, medium: 1, low: 2, unrated: 3 };

const getSeverityLabel = (severity: Severity): string => {
  switch (severity) {
    case "high":
      return "⚠ HIGH";
    case "medium":
      return "▲ MEDIUM";
    case "low":
      return "● LOW";
    case "unrated":
      return "○ NOT RATED";
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
  s === "high" ? "dot-high" : s === "medium" ? "dot-medium" : s === "low" ? "dot-low" : "dot-unrated";

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
   PERFORMANCE LIMITS
========================= */
const LIST_PAGE_SIZE = 50;
const MAP_MAX_MARKERS = 300;
const MAP_EARTHQUAKE_CAP = 15;

/** Phone layout: map or feed, one at a time; the choice is kept for the browser session. */
type PhoneView = "map" | "feed";
const VIEW_KEY = "dw.dashboardView";
const readView = (): PhoneView => {
  try {
    return sessionStorage.getItem(VIEW_KEY) === "feed" ? "feed" : "map";
  } catch {
    return "map";
  }
};

type DashboardProps = {
  /** Only changes the wording under the alerts call-to-action. */
  signedIn?: boolean;
};

const DashboardPage = ({ signedIn = false }: DashboardProps) => {
  // Start from the feed cached by the previous visit (survives route changes), else the fallback rows.
  // Start from the feed cached by the previous visit (survives route changes); otherwise the
  // list is empty and the skeleton is shown until the backend answers. Never demo rows.
  const [disasters, setDisasters] = useState<DisasterItem[]>(() => getCachedFeed<DisasterItem>()?.items ?? []);
  const [feedStatus, setFeedStatus] = useState<FeedStatus>(() => (getCachedFeed() ? "ready" : "loading"));
  const [feedStale, setFeedStale] = useState(() => getCachedFeed()?.stale ?? false);
  // Per-source status from the backend; a feed with one source in error is "partial"
  const [feedSources, setFeedSources] = useState<FeedSources | null>(() => getCachedFeed()?.sources ?? null);
  const [feedSourcesUpdatedAt, setFeedSourcesUpdatedAt] = useState<FeedSourcesUpdatedAt | null>(() => getCachedFeed()?.sourcesUpdatedAt ?? null);
  // When the data was fetched from the sources, as reported by the backend: every "ago" label
  // on the page derives from this, never from the time the browser received the response.
  const [feedUpdatedAt, setFeedUpdatedAt] = useState<string | null>(() => getCachedFeed()?.updatedAt ?? null);
  // Whole-window counts from the backend (null until the first live answer)
  const [feedCounts, setFeedCounts] = useState<FeedCounts | null>(null);
  // The feed row that opened the drawer; it gets focus back when the drawer closes
  const openerRef = useRef<HTMLElement | null>(null); // the feed row button
  const [activeFilter, setActiveFilter] = useState<"all" | DisasterType>("all");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"time" | "severity">("time");
  const [selectedDisaster, setSelectedDisaster] = useState<DisasterItem | null>(
    null
  );
  // re-renders the relative "ago" labels once a minute
  const [, setClockTick] = useState(0);
  const [page, setPage] = useState(1);

  // Deep link from the news panel: /?event=<feed id> selects that event
  // (the existing highlight -> flyTo mechanism does the rest), then the
  // parameter is removed so a refresh does not re-select it.
  const [searchParams, setSearchParams] = useSearchParams();
  const mapPanelRef = useRef<HTMLElement | null>(null);

  // Phones show the map or the feed, not both stacked (desktop and tablets are unchanged).
  const isPhone = useMediaQuery(PHONE_QUERY);
  const [phoneView, setPhoneViewState] = useState<PhoneView>(readView);
  const setPhoneView = useCallback((view: PhoneView) => {
    setPhoneViewState(view);
    try {
      sessionStorage.setItem(VIEW_KEY, view);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  }, []);
  const showMap = !isPhone || phoneView === "map";
  // The feed stays mounted (hidden) in the phone Map view so the skip link always has its target.
  const showFeed = !isPhone || phoneView === "feed";

  // The skip link targets the feed: on a phone in the Map view, switch to the Feed first
  // (synchronously, so the link can focus the first row right after).
  useEffect(() => {
    const onSkip = (e: Event) => {
      if ((e as CustomEvent<string>).detail === "disaster-feed" && isPhone) flushSync(() => setPhoneView("feed"));
    };
    window.addEventListener("dw:skip-to", onSkip);
    return () => window.removeEventListener("dw:skip-to", onSkip);
  }, [isPhone, setPhoneView]);

  useEffect(() => {
    const raw = searchParams.get("event");
    if (!raw) return;
    const id = Number(raw);
    const hit = disasters.find((d) => d.id === id);
    if (!hit) return; // feed not loaded yet (or unknown id): keep waiting
    if (isPhone) setPhoneView("map");
    setSelectedDisaster(hit);
    // On narrow layouts the map sits below the KPI cards: bring it into view so the flyTo is seen.
    if (!isPhone) mapPanelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const next = new URLSearchParams(searchParams);
    next.delete("event");
    setSearchParams(next, { replace: true });
  }, [searchParams, disasters, setSearchParams, isPhone, setPhoneView]);

  // Phone: the event opens as a bottom sheet over the lower half of the screen; the map is
  // scrolled to the top of the viewport so the selected marker stays visible above the sheet.
  const selectedId = selectedDisaster?.id ?? null;
  useEffect(() => {
    if (selectedId === null || !isPhone || phoneView !== "map") return;
    // next frame: the lazily loaded map (or its placeholder) is in the DOM by then
    const frame = requestAnimationFrame(() => {
      const map = mapPanelRef.current?.querySelector<HTMLElement>(".map-leaflet-container") ?? mapPanelRef.current;
      if (!map) return;
      const header = document.querySelector<HTMLElement>(".app-header")?.offsetHeight ?? 0; // sticky
      window.scrollTo({ top: map.getBoundingClientRect().top + window.scrollY - header - 8 });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId, isPhone, phoneView]);

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
     - success: real items only (an empty feed stays empty)
     - per-source trouble: a source the backend could not reach is either
       "stale" (its recent items are still served, the note says how old) or
       "error" (its items are missing from this update)
     - failure: the previous real feed (if any) with a stale warning, else an
       explicit error state with "Try again"; demo rows are never shown.
       Upstream error details are never shown (the backend does not send them).
  ========================= */
  const loadFeed = useCallback(async (signal?: AbortSignal) => {
    const hasCache = Boolean(getCachedFeed());
    if (!hasCache) setFeedStatus("loading");
    try {
      // The whole window (the API's maximum page), so severity sort can bring every
      // significant event to the top; the KPIs use the backend's full-window counts.
      const res = await fetch("/api/disasters?limit=200", { signal });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`Feed request failed (${res.status})`);
      const items: DisasterItem[] = Array.isArray(data?.items) ? data.items : [];
      if (signal?.aborted) return;
      setFeedCounts(readCounts(data?.counts));
      const stale = Boolean(data?.stale);
      const sources = readSources(data?.sources);
      const sourcesUpdatedAt = readSourcesUpdatedAt(data?.sourcesUpdatedAt);
      const updatedAt = readIso(data?.updatedAt);
      setCachedFeed(items, { stale, sources, sourcesUpdatedAt, updatedAt });
      setDisasters(items);
      setFeedStale(stale);
      setFeedSources(sources);
      setFeedSourcesUpdatedAt(sourcesUpdatedAt);
      setFeedUpdatedAt(updatedAt);
      setFeedStatus("ready");
    } catch {
      if (signal?.aborted) return;
      const cached = getCachedFeed<DisasterItem>();
      if (cached) {
        // keep the last real data on screen, flagged as stale; its age is still the backend's updatedAt
        setDisasters(cached.items);
        setFeedStale(true);
        setFeedSources(cached.sources);
        setFeedSourcesUpdatedAt(cached.sourcesUpdatedAt);
        setFeedUpdatedAt(cached.updatedAt);
        setFeedStatus("ready");
      } else {
        setDisasters([]);
        setFeedStatus("error");
      }
    }
  }, []);

  useEffect(() => {
    // A feed fetched less than FEED_FRESH_MS ago (previous visit to the
    // dashboard in this tab) is used as is; the backend's own ingestion runs
    // every 5 minutes, so nothing newer would come back anyway.
    if (isFeedFresh()) return;
    const controller = new AbortController();
    loadFeed(controller.signal);
    return () => controller.abort();
  }, [loadFeed]);

  /* =========================
     TIMER
  ========================= */
  useEffect(() => {
    const i = setInterval(() => setClockTick((n) => n + 1), 60000);
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

    const countryN = normalizeText(d.country ?? "");

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

    // Same relative-time and clean-title helpers as the feed rows, so no
    // "240m ago" or "Flood in Nepal 1104225" shows up here either.
    return top.map((d) => ({
      time: eventRelativeTime(d) ?? "Now",
      title: `${getTypeLabel(d.type)} reported`,
      summary: d.description ? cleanTitle(d.description) : eventTitle(d),
      type: d.type,
      severity: d.severity,
      locationHint: d.details?.place ?? eventTitle(d),
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

  // KPIs over the WHOLE feed window (backend counts), not the loaded page;
  // the loaded items are the fallback when an old cached payload has no counts.
  const { total: totalDisasters, significant: significantEvents } = useMemo(
    () => (feedCounts ? kpiFromCounts(feedCounts, activeFilter) : kpiFromItems(kpiDisasters, activeFilter)),
    [feedCounts, kpiDisasters, activeFilter]
  );

  // same wording as every other relative time in the UI ("5 minutes ago")
  const hasData = feedStatus === "ready" && disasters.length > 0;
  // Source whose items are missing because it failed on the backend while the other answered
  const unavailableSource: "nasa" | "usgs" | null =
    feedStatus === "ready" && !feedStale && feedSources
      ? feedSources.nasa === "error" && feedSources.usgs !== "error"
        ? "nasa"
        : feedSources.usgs === "error" && feedSources.nasa !== "error"
          ? "usgs"
          : null
      : null;
  // Per-source notes (not shown while the whole feed is stale: the stale banner covers that)
  const sourceNotes =
    feedStatus === "ready" && !feedStale && feedSources
      ? (["nasa", "usgs"] as const)
          .filter((name) => feedSources[name] !== "ok")
          .map((name) =>
            feedSources[name] === "stale"
              ? `${SOURCE_LABEL[name]} unreachable: showing ${SOURCE_ITEMS[name]} from ${relativeTime(feedSourcesUpdatedAt?.[name]) ?? "the last successful fetch"}.`
              : `${SOURCE_LABEL[name]} unavailable: ${SOURCE_ITEMS[name]} are missing from this update.`
          )
      : [];
  const sourcesLabel = unavailableSource === "nasa" ? "USGS only, NASA unavailable" : unavailableSource === "usgs" ? "NASA only, USGS unavailable" : "NASA + USGS";
  // Data age as reported by the backend (never the browser's fetch time)
  const dataAge = relativeTime(feedUpdatedAt) ?? "unknown";
  const updatedLabel =
    feedStatus === "loading"
      ? "Loading live data (NASA + USGS)…"
      : feedStatus === "error"
        ? "Live data unavailable"
        : `Last updated: ${dataAge} (${sourcesLabel}${feedStale ? ", last successful fetch" : ", live data"})`;
  // KPI numbers only exist for real data
  const kpi = (n: number) => (hasData ? n : "—");

  /* =========================
     MAP DATA
     - For earthquakes: show last 15 (even low)
     - For others: medium/high only + wildfire per-country cap
  ========================= */
  const MAX_WILDFIRE_PER_COUNTRY = 30;

  const mapMarkers = useMemo(() => {
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

    // Every type and severity goes on the map (clustering handles the density);
    // only the per-country wildfire cap and the total marker cap apply.
    const nonEq = baseNonEq
      .filter((d) => {
        if (d.type !== "wildfire") return true;

        const country = d.country ?? "Unknown";
        const current = countryCounter.get(country) ?? 0;

        if (current >= MAX_WILDFIRE_PER_COUNTRY) return false;

        countryCounter.set(country, current + 1);
        return true;
      });

    const merged = [...eq, ...nonEq].slice(0, MAP_MAX_MARKERS);
    return { list: merged, earthquakesShown: eq.length, earthquakesTotal: showEarthquakes ? filteredDisasters.filter((d) => d.type === "earthquake").length : 0 };
  }, [filteredDisasters, activeFilter]);
  const mapDisasters = mapMarkers.list;

  /* =========================
     MAP LIVENESS
     - the newest marker and up to 3 significant events from the last 24 h
       pulse; nothing pulses with prefers-reduced-motion
  ========================= */
  const reducedMotion = usePrefersReducedMotion();
  const pulsing = useMemo(() => pulseIds(mapDisasters, { reducedMotion }), [mapDisasters, reducedMotion]);

  /* =========================
     HEADLINE (whole feed, every type; same numbers as the KPI definitions)
  ========================= */
  const wholeFeed = useMemo(() => (feedCounts ? kpiFromCounts(feedCounts, "all") : kpiFromItems(disasters, "all")), [feedCounts, disasters]);
  const headline = headlineText({
    status: feedStatus,
    significant: wholeFeed.significant,
    total: wholeFeed.total,
    items: disasters,
    stale: feedStale,
    dataAge: relativeTime(feedUpdatedAt),
  });
  const headlineTone =
    feedStatus === "loading" ? "loading" : feedStatus === "error" ? "offline" : wholeFeed.significant > 0 ? "significant" : "quiet";

  /* =========================
     COUNTRIES AFFECTED
     - distinct countries among the events shown on the map; the country is
       derived by the backend from the source place name (USGS place, EONET
       title) and is null when it cannot be derived, so nothing is guessed
       and no reverse geocoding happens in the browser
  ========================= */
  const countriesAffected = useMemo(() => {
    const set = new Set<string>();
    for (const d of mapDisasters) if (d.country) set.add(d.country);
    return set.size;
  }, [mapDisasters]);

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
      {/* Page header */}
      <section className="dashboard-header" aria-labelledby="dashboard-title">
        <div>
          <h1 id="dashboard-title" className="dashboard-title">Global Disaster Overview</h1>
          <p className="dashboard-subtitle">Live monitoring powered by NASA EONET + USGS.</p>
        </div>

        <div className="dashboard-header-meta">
          {/* LIVE only while real, fresh data is on screen */}
          {hasData && !feedStale && <span className="badge-live">LIVE</span>}
          {hasData && feedStale && <span className="badge-stale">STALE</span>}
          {feedStatus === "error" && <span className="badge-stale">OFFLINE</span>}
          <span className="dashboard-updated">{updatedLabel}</span>
        </div>
      </section>

      <HeadlineStrip text={headline} tone={headlineTone} signedIn={signedIn} />

      {/* KPI cards */}
      <section className="dashboard-kpis" aria-label="Key figures">
        <div className="kpi-card">
          <span className="kpi-label">Disasters</span>
          <span className="kpi-value">{kpi(totalDisasters)}</span>
          <span className="kpi-footnote">
            {feedStatus === "error" ? "Feed offline" : unavailableSource === "nasa" ? "USGS only" : unavailableSource === "usgs" ? "NASA only" : "NASA + USGS"}
          </span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">Significant events</span>
          <span className="kpi-value kpi-value-warning">{kpi(significantEvents)}</span>
          <span className="kpi-footnote">
            {feedStatus === "error" ? "Feed offline" : hasData && significantEvents === 0 ? "None right now (high or medium severity)" : "High or medium severity"}
          </span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">Countries affected</span>
          <span className="kpi-value">{kpi(countriesAffected)}</span>
          <span className="kpi-footnote">{feedStatus === "error" ? "Feed offline" : "From source place names"}</span>
        </div>
      </section>

      {/* Main grid (map + list) */}
      <main className={isPhone ? `app-main app-main-phone${selectedDisaster ? " app-main-sheet-open" : ""}` : "app-main"}>
        {isPhone && (
          <div className="view-toggle" role="group" aria-label="Show map or feed">
            <button type="button" aria-pressed={phoneView === "map"} onClick={() => setPhoneView("map")}>
              Map
            </button>
            <button type="button" aria-pressed={phoneView === "feed"} onClick={() => setPhoneView("feed")}>
              Feed
            </button>
          </div>
        )}

        {/* MAP PANEL */}
        {showMap && (
          <section className="map-panel" ref={mapPanelRef}>
            <div className="panel-header">
              <h2>Map view</h2>
              <span className="panel-caption">
                {feedStatus === "loading" ? (
                  "Loading markers…"
                ) : feedStatus === "error" ? (
                  "No markers while the feed is offline."
                ) : mapDisasters.length === 0 ? (
                  disasters.length === 0 ? "No events to plot right now." : "No events to plot for this filter or search."
                ) : (
                  <>
                    Showing {mapDisasters.length} marker{mapDisasters.length === 1 ? "" : "s"} • Earthquakes: {mapMarkers.earthquakesShown}
                    {mapMarkers.earthquakesTotal > mapMarkers.earthquakesShown ? ` of ${mapMarkers.earthquakesTotal} (latest ${MAP_EARTHQUAKE_CAP})` : ""}.
                  </>
                )}
                {hasData && feedUpdatedAt && (
                  <span className="panel-caption-updated">
                    {" "}
                    {feedStale ? "Last successful update" : "Updated"} {dataAge}
                  </span>
                )}
              </span>
            </div>

            {/* Reset to work around Leaflet marker cache issues */}
            <Suspense fallback={<div className="map-leaflet-container map-loading" aria-hidden="true" />}>
              <MapView
                key={activeFilter}
                disasters={mapDisasters}
                pulseIds={pulsing}
                highlightId={selectedDisaster?.id ?? null}
                onSelect={(id) => {
                  const hit = disasters.find((d) => d.id === id);
                  if (hit) setSelectedDisaster(hit);
                }}
              />
            </Suspense>

            {/* HORIZONTAL LEGEND */}
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
              {/* clusters take the event colours: one colour for a single type, a split ring for a mix */}
              <span className="legend-divider" aria-hidden="true" />
              <span className="legend-title legend-title-sub">Clusters</span>
              <div className="legend-pills legend-clusters">
                <div className="legend-pill">
                  <span className="legend-cluster legend-cluster-single" aria-hidden="true">
                    <span className="legend-cluster-count">3</span>
                  </span>
                  <span className="legend-cluster legend-cluster-split" aria-hidden="true">
                    <span className="legend-cluster-count">7</span>
                  </span>
                  <span className="legend-cluster-caption">Clusters use the event colours; mixed clusters are split</span>
                </div>
              </div>
              {pulsing.size > 0 && (
                <div className="legend-pill">
                  <span className="legend-pulse" aria-hidden="true" />
                  <span>Pulsing: newest event and recent significant ones (24 h)</span>
                </div>
              )}
            </div>
          </section>
        )}

        {/* LIST PANEL */}
        <section className="list-panel" id="disaster-feed" aria-labelledby="disaster-feed-title" hidden={!showFeed}>
          <div className="panel-header">
            <h2 id="disaster-feed-title" tabIndex={-1} data-skip-fallback>
              Disaster feed
            </h2>
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
                aria-label="Search city or country"
                placeholder="Search city or country…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                  scrollListToTop();
                }}
              />
              <label htmlFor="feed-sort" className="sr-only">
                Sort events
              </label>
              <select
                id="feed-sort"
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

          {/* Pagination controls (only when there is more than one page) */}
          {totalPages > 1 && (
            <div className="feed-pager" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
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
          )}

          {feedStale && feedStatus === "ready" && (
            <div className="feed-stale-banner" role="status">
              Live sources could not be reached; showing the last successful update ({dataAge}).
              <button type="button" className="btn btn-primary btn-sm" onClick={() => loadFeed()}>
                Try again
              </button>
            </div>
          )}

          {sourceNotes.length > 0 && (
            <div className="feed-partial-note" role="status">
              <div>
                {sourceNotes.map((note) => (
                  <div key={note}>{note}</div>
                ))}
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => loadFeed()}>
                Try again
              </button>
            </div>
          )}

          {feedStatus === "loading" && (
            <ul className="disaster-list feed-skeleton" aria-busy="true" aria-label="Loading disasters">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <li key={i} className="disaster-row disaster-row-skeleton">
                  <div className="disaster-row-main">
                    <div className="news-skel news-skel-meta" />
                    <div className="news-skel news-skel-title" />
                    <div className="news-skel news-skel-title short" />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {feedStatus === "error" && (
            <div className="feed-state" role="alert">
              <p className="feed-state-text">Live sources are not responding right now. Nothing on this page is simulated.</p>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => loadFeed()}>
                Try again
              </button>
            </div>
          )}

          {feedStatus === "ready" && filteredDisasters.length === 0 && (
            <div className="feed-state muted">
              {disasters.length === 0 ? (
                <p className="feed-state-quiet">No events reported by NASA EONET or USGS in the last 7 days. The feed refreshes every few minutes.</p>
              ) : (
                <>
                  <p className="feed-state-quiet">No events match the current filter or search.</p>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setSearch("");
                      applyFilter("all");
                    }}
                  >
                    Show all events
                  </button>
                </>
              )}
            </div>
          )}

          {/* Scrollable list container */}
          <div ref={listRef} className="feed-scroll" style={{ maxHeight: 520, overflowY: "auto", paddingRight: 6 }}>
            <ul className="disaster-list">
              {pagedDisasters.map((item) => (
                <FeedRow
                  key={item.id}
                  typeLabel={getTypeLabel(item.type)}
                  typeClass={
                    item.type === "earthquake" ? "tag-earthquake" : item.type === "flood" ? "tag-flood" : item.type === "wildfire" ? "tag-wildfire" : "tag-storm"
                  }
                  title={displayTitle(item)}
                  meta={displayMeta(item)}
                  severityLabel={getSeverityLabel(item.severity)}
                  severityClass={
                    item.severity === "high"
                      ? "severity-high"
                      : item.severity === "medium"
                      ? "severity-medium"
                      : item.severity === "low"
                      ? "severity-low"
                      : "severity-unrated"
                  }
                  onSelect={(element) => {
                    openerRef.current = element;
                    setSelectedDisaster(item);
                  }}
                />
              ))}
            </ul>
          </div>

          {/* TODAY'S EVENTS (REAL DATA) */}
          <section className="timeline timeline-upgraded">
            <div className="timeline-header">
              <h3 className="timeline-title">Today&apos;s events</h3>
              <span className="timeline-hint">Hover on an item for details</span>
            </div>

            {feedStatus !== "ready" && <p className="muted timeline-empty">{feedStatus === "loading" ? "Loading…" : "Unavailable while the feed is offline."}</p>}
            {feedStatus === "ready" && todayEvents.length === 0 && (
              <p className="muted timeline-empty">{disasters.length === 0 ? "Nothing reported yet in this feed window." : "No events for this filter or search."}</p>
            )}
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
                              : ev.severity === "low"
                              ? "sev-low"
                              : "sev-unrated")
                          }
                        >
                          {ev.severity === "unrated" ? "not rated" : ev.severity}
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

      {/* DETAIL DRAWER (shared by list rows and map markers) */}
      {selectedDisaster && (
        <EventDetailDrawer
          event={selectedDisaster}
          relatedNews={<RelatedNews eventId={selectedDisaster.id} />}
          onClose={() => {
            setSelectedDisaster(null);
            // back to the row (or marker) that opened the drawer, for keyboard users
            const opener = openerRef.current;
            openerRef.current = null;
            if (opener && document.contains(opener)) window.setTimeout(() => opener.focus(), 0);
          }}
          onZoomTo={() => {
            // Re-trigger the map's flyTo for the same id by clearing and re-setting the selection
            const current = selectedDisaster;
            setSelectedDisaster(null);
            window.setTimeout(() => setSelectedDisaster(current), 0);
          }}
        />
      )}
    </>
  );
};

export default DashboardPage;

