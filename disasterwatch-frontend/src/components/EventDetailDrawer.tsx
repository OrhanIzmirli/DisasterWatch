import { useEffect, useRef } from "react";
import { formatDateTime, relativeTime } from "../utils/formatDate";
import { cleanTitle, eventRelativeTime } from "../utils/eventText";

export type EventSource = { name: string; url: string };

/** Rich, source-faithful fields from the backend (`details` on a feed item). */
export type EventDetails = {
  eventId: string | null;
  source: "usgs" | "nasa";
  category: string | null;
  cleanTitle: string;
  place: string | null;
  occurredAt: string | null;
  updatedAt: string | null;
  status: string | null;
  sources: EventSource[];
  magnitude: number | null;
  /** Display text for the magnitude ("6.1"), formatted once by the backend for every surface. */
  magnitudeLabel?: string | null;
  magType: string | null;
  depthKm: number | null;
  pagerAlert: "green" | "yellow" | "orange" | "red" | null;
  tsunami: boolean | null;
  feltReports: number | null;
  magnitudeValue: number | null;
  magnitudeUnit: string | null;
  /** Wildfires: burned area normalised to hectares by the backend (acres × 0.40469); null otherwise. */
  areaHa?: number | null;
  /** Storms: highest advisory wind of the series (the rated value) and the latest one, in kts. */
  peakKts?: number | null;
  currentKts?: number | null;
  /** GDACS impact level when GDACS rates this event (wildfires, floods). */
  gdacsLevel?: "green" | "orange" | "red" | null;
  gdacsScore?: number | null;
  severity: "high" | "medium" | "low" | "unrated";
  severityReason: string;
  severitySource: string;
};

export type DrawerEvent = {
  id: number;
  type: "earthquake" | "flood" | "wildfire" | "storm";
  severity: "high" | "medium" | "low" | "unrated";
  location: string;
  meta: string;
  description: string;
  lat: number;
  lng: number;
  /** Feed minutes-ago counter; used for the relative time when `details.occurredAt` is missing. */
  timeMinutesAgo?: number;
  details?: EventDetails;
};

type Props = {
  event: DrawerEvent;
  onClose: () => void;
  onZoomTo: () => void;
  /**
   * Reserved for the news integration: when provided, a "Related news"
   * section is rendered. Nothing is shown while it is undefined.
   */
  relatedNews?: React.ReactNode;
};

const TYPE_LABELS: Record<DrawerEvent["type"], string> = {
  earthquake: "Earthquake",
  flood: "Flood",
  wildfire: "Wildfire",
  storm: "Storm",
};

const SEVERITY_LABELS = { high: "High", medium: "Medium", low: "Low", unrated: "Not rated" } as const;

/** USGS PAGER alert levels, as documented by USGS (estimated impact). */
const PAGER_TEXT: Record<NonNullable<EventDetails["pagerAlert"]>, string> = {
  green: "Green: little or no impact expected (USGS PAGER)",
  yellow: "Yellow: localised impact possible (USGS PAGER)",
  orange: "Orange: significant impact likely, regional response (USGS PAGER)",
  red: "Red: severe impact likely, national or international response (USGS PAGER)",
};

const NOT_REPORTED = "Not reported by source";

const UNIT_LABELS: Record<string, string> = {
  hectare: "hectares",
  acres: "acres",
  kts: "kts wind speed",
  "NM^2": "square nautical miles",
};

function fmtCoord(n: number) {
  return n.toFixed(3);
}

function utcString(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="edd-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="edd-section">
      <h4 className="edd-section-title">{title}</h4>
      {children}
    </section>
  );
}

const EventDetailDrawer = ({ event, onClose, onZoomTo, relatedNews }: Props) => {
  const d = event.details;
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes the drawer (the opener restores focus, see DashboardPage);
  // the close button takes focus on open so keyboard users start inside the dialog.
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const title = d?.cleanTitle || cleanTitle(event.location);
  const occurredAt = d?.occurredAt ?? null;
  const occurredRelative = eventRelativeTime(event); // falls back to the feed's minutes-ago counter
  const isQuake = event.type === "earthquake";

  const isStorm = event.type === "storm";
  const sizeLabel = isQuake ? "Magnitude" : isStorm ? "Wind" : "Size";
  const stormCategory = (kts: number) =>
    kts >= 137 ? "Cat-5" : kts >= 113 ? "Cat-4" : kts >= 96 ? "Cat-3" : kts >= 83 ? "Cat-2" : kts >= 64 ? "Cat-1" : "tropical storm";
  // The magnitude text comes pre-formatted from the backend so this row, the
  // title, the feed row, the tooltip and the severity reason all agree.
  // Wildfire areas are shown in hectares (normalised by the backend); when the
  // source reported acres the original figure follows in brackets.
  const sizeValue = isQuake
    ? d?.magnitudeLabel
      ? `M ${d.magnitudeLabel}${d.magType ? ` (${d.magType})` : ""}`
      : null
    : isStorm && d?.peakKts !== null && d?.peakKts !== undefined
    ? `Peaked ${Math.round(d.peakKts).toLocaleString("en-GB")} kts (${stormCategory(d.peakKts)}), now ${Math.round(d.currentKts ?? d.peakKts).toLocaleString("en-GB")} kts`
    : event.type === "wildfire" && d?.areaHa !== null && d?.areaHa !== undefined
    ? `${Math.round(d.areaHa).toLocaleString("en-GB")} ha${
        d.magnitudeUnit && /^acres?$/i.test(d.magnitudeUnit) && d.magnitudeValue !== null ? ` (${d.magnitudeValue.toLocaleString("en-GB")} acres)` : ""
      }`
    : d?.magnitudeValue !== null && d?.magnitudeValue !== undefined
    ? `${d.magnitudeValue.toLocaleString("en-GB")} ${UNIT_LABELS[d.magnitudeUnit ?? ""] ?? d.magnitudeUnit ?? ""}`.trim()
    : null;

  const hasImpact =
    isQuake && d && (d.pagerAlert !== null || d.tsunami === true || (d.feltReports !== null && d.feltReports > 0));

  return (
    <>
      <div className="detail-overlay" onClick={onClose} />
      <div className="detail-drawer edd" role="dialog" aria-modal="true" aria-label={title}>
        <div className="detail-header">
          <div className="detail-header-main">
            <div className="edd-tags">
              <span className={`disaster-type-tag tag-${event.type}`}>{TYPE_LABELS[event.type]}</span>
              <span className={`disaster-severity severity-${event.severity}`}>
                {SEVERITY_LABELS[event.severity]}
              </span>
              {d?.status && <span className="edd-status">{d.status}</span>}
            </div>
            <h3 className="detail-title">{title}</h3>
            {d?.category && <p className="detail-meta">{d.category}</p>}
          </div>
          <button ref={closeRef} type="button" className="detail-close-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="detail-body edd-body">
          <Section title="When">
            <dl className="edd-rows">
              <Row label="Occurred">
                {occurredRelative ? (
                  <>
                    <strong>{occurredRelative}</strong>
                    {occurredAt && (
                      <div className="edd-sub">
                        {formatDateTime(occurredAt)} local · {utcString(occurredAt)}
                      </div>
                    )}
                  </>
                ) : (
                  NOT_REPORTED
                )}
              </Row>
              {d?.updatedAt && d.updatedAt !== occurredAt && (
                <Row label="Last update">
                  {relativeTime(d.updatedAt)}
                  <div className="edd-sub">{utcString(d.updatedAt)}</div>
                </Row>
              )}
            </dl>
          </Section>

          <Section title="Where">
            <dl className="edd-rows">
              <Row label="Place">{d?.place ?? (cleanTitle(event.location) || NOT_REPORTED)}</Row>
              <Row label="Coordinates">
                {fmtCoord(event.lat)}, {fmtCoord(event.lng)}
              </Row>
              {isQuake && (
                <Row label="Depth">{d?.depthKm !== null && d?.depthKm !== undefined ? `${d.depthKm.toFixed(1)} km` : NOT_REPORTED}</Row>
              )}
            </dl>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onZoomTo}>
              Zoom to
            </button>
          </Section>

          <Section title={sizeLabel}>
            <p className="edd-text">{sizeValue ?? NOT_REPORTED}</p>
          </Section>

          {hasImpact && d && (
            <Section title="Impact">
              <dl className="edd-rows">
                {d.pagerAlert && (
                  <Row label="PAGER">
                    <span className={`edd-pager edd-pager-${d.pagerAlert}`}>{d.pagerAlert}</span>
                    <div className="edd-sub">{PAGER_TEXT[d.pagerAlert]}</div>
                  </Row>
                )}
                {d.tsunami === true && <Row label="Tsunami">Tsunami flag set by USGS</Row>}
                {d.feltReports !== null && d.feltReports > 0 && (
                  <Row label="Felt reports">{d.feltReports.toLocaleString("en-GB")} (USGS "Did You Feel It?")</Row>
                )}
              </dl>
            </Section>
          )}

          <Section title="Why it's on the map">
            <p className="edd-text">{d?.severityReason ?? `${SEVERITY_LABELS[event.severity]} severity`}</p>
            {d?.severitySource && <p className="edd-sub">{d.severitySource}</p>}
            {d?.gdacsLevel && (
              <p className="edd-sub">
                <span className={`edd-gdacs edd-gdacs-${d.gdacsLevel}`}>{d.gdacsLevel}</span> GDACS impact level
                {d.gdacsScore !== null && d.gdacsScore !== undefined ? ` (score ${d.gdacsScore})` : ""} ·{" "}
                <a href="https://www.gdacs.org/" target="_blank" rel="noreferrer">
                  gdacs.org
                </a>
              </p>
            )}
          </Section>

          {relatedNews !== undefined && <Section title="Related news">{relatedNews}</Section>}

          <Section title="Sources">
            {d?.sources?.length ? (
              <ul className="edd-sources">
                {d.sources.map((s) => (
                  <li key={s.url}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-link">
                      {s.name}
                    </a>
                    <span className="edd-sub"> {new URL(s.url).hostname}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="edd-text">{NOT_REPORTED}</p>
            )}
          </Section>
        </div>
      </div>
    </>
  );
};

export default EventDetailDrawer;
