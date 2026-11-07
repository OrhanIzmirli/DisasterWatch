import { useEffect, useRef } from "react";
import type { SeverityRules } from "../services/feedCache";
import EventImpact from "./EventImpact";
import EventScores from "./EventScores";
import type { FeedScores } from "../utils/scores";
import { gdacsRefFromSources } from "../utils/gdacsRef";
import EventTimeline, { type TimelinePoint } from "./EventTimeline";
import { formatDateTime, relativeTime } from "../utils/formatDate";
import { cleanTitle, eventRelativeTime } from "../utils/eventText";
import {
  GDACS_MEANING,
  depthClass,
  lifecycle,
  quakeClass,
  severityScale,
  stormCategory,
  summarySentence,
} from "../utils/eventInsights";

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
  /**
   * EONET events: "approximate" when GDACS's event point (the marker) and the
   * EONET geometry lie more than 100 km apart; absent for USGS quakes.
   */
  locationPrecision?: "exact" | "approximate";
  locationSource?: "gdacs" | "eonet";
  locationReason?: string;
  locationOffsetKm?: number | null;
  severityReason: string;
  severitySource: string;
  /** Earthquakes: the named place USGS measures from; null when USGS names a region only. */
  nearestPlace?: { name: string; distanceKm: number; direction: string } | null;
  /** Wildfires and floods: ISO 3166-1 alpha-2 codes GDACS lists; null when GDACS has no answer. */
  affectedCountries?: string[] | null;
  /** Storms and wildfires: the EONET series, oldest first; null when the source gives one entry only. */
  timeline?: TimelinePoint[] | null;
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
  /** Confidence and priority from the feed (null when they could not be computed). */
  scores?: FeedScores;
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
  /** Other feed events close to this one, nearest first (see utils/eventInsights). */
  nearby?: { event: DrawerEvent; distanceKm: number }[];
  /** Opens another event in the drawer (used by the nearby list). */
  onSelectEvent?: (id: number) => void;
  /** Rating thresholds served with the feed; the scale shows levels without ranges when absent. */
  severityRules?: SeverityRules | null;
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

const REGION_NAMES = typeof Intl !== "undefined" && "DisplayNames" in Intl ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
function countryName(code: string) {
  try {
    return REGION_NAMES?.of(code) ?? code;
  } catch {
    return code;
  }
}

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

function Fact({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="edd-fact">
      <dt className="edd-fact-label">{label}</dt>
      <dd className="edd-fact-value">
        {value}
        {note && <span className="edd-fact-note">{note}</span>}
      </dd>
    </div>
  );
}

const EventDetailDrawer = ({ event, onClose, onZoomTo, relatedNews, nearby, onSelectEvent, severityRules = null }: Props) => {
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

  // The magnitude text comes pre-formatted from the backend so this panel, the
  // title, the feed row, the tooltip and the severity reason all agree.
  const quakeMag = isQuake && d?.magnitude !== null && d?.magnitude !== undefined ? d.magnitude : null;
  const sizeFact: { label: string; value: string | null; note?: string } = isQuake
    ? {
        label: "Magnitude",
        value: d?.magnitudeLabel ? `M ${d.magnitudeLabel}` : null,
        note: quakeMag !== null ? quakeClass(quakeMag).label : undefined,
      }
    : isStorm && d?.peakKts !== null && d?.peakKts !== undefined
    ? {
        label: "Peak wind",
        value: `${Math.round(d.peakKts).toLocaleString("en-GB")} kts`,
        note: stormCategory(d.peakKts),
      }
    : event.type === "wildfire" && d?.areaHa !== null && d?.areaHa !== undefined
    ? {
        label: "Burned area",
        value: `${Math.round(d.areaHa).toLocaleString("en-GB")} ha`,
        note: `${(d.areaHa / 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })} km²${
          d.magnitudeUnit && /^acres?$/i.test(d.magnitudeUnit) && d.magnitudeValue !== null
            ? ` · reported as ${d.magnitudeValue.toLocaleString("en-GB")} acres`
            : ""
        }`,
      }
    : d?.magnitudeValue !== null && d?.magnitudeValue !== undefined
    ? {
        label: "Size",
        value: `${d.magnitudeValue.toLocaleString("en-GB")} ${UNIT_LABELS[d.magnitudeUnit ?? ""] ?? d.magnitudeUnit ?? ""}`.trim(),
      }
    : { label: "Size", value: null };

  const depth = isQuake && d?.depthKm !== null && d?.depthKm !== undefined ? d.depthKm : null;
  const scale = severityScale(event, severityRules);
  const life = lifecycle(event);
  const gdacsRef = gdacsRefFromSources(d?.sources);
  const hasImpact =
    isQuake && d && (d.pagerAlert !== null || d.tsunami === true || (d.feltReports !== null && d.feltReports > 0));

  return (
    <>
      <div className="detail-overlay" onClick={onClose} />
      <div className="detail-drawer edd" data-map-obstruction role="dialog" aria-modal="true" aria-label={title}>
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
          <section className="edd-section edd-intro">
            <p className="edd-summary">{summarySentence(event)}</p>
            <button type="button" className="btn btn-primary btn-sm edd-map-btn" onClick={onZoomTo}>
              Show on map
            </button>
          </section>

          <Section title="At a glance">
            <dl className="edd-facts">
              <Fact label={sizeFact.label} value={sizeFact.value ?? NOT_REPORTED} note={sizeFact.note} />
              {isQuake ? (
                <Fact
                  label="Depth"
                  value={depth !== null ? `${depth.toFixed(1)} km` : NOT_REPORTED}
                  note={depth !== null ? depthClass(depth).label : undefined}
                />
              ) : (
                <Fact label="Status" value={d?.status ?? NOT_REPORTED} />
              )}
              <Fact
                label="When"
                value={occurredRelative ?? NOT_REPORTED}
                note={occurredAt ? `${formatDateTime(occurredAt)} local` : undefined}
              />
              <Fact label="Severity" value={SEVERITY_LABELS[event.severity]} note={scale.basis} />
            </dl>
          </Section>

          <Section title="How serious is it">
            <ol className="edd-scale" aria-label={`Severity scale by ${scale.basis.toLowerCase()}`}>
              {scale.steps.map((s) => (
                <li
                  key={s.level}
                  className={`edd-scale-step edd-scale-${s.level}${scale.current === s.level ? " is-current" : ""}`}
                  aria-current={scale.current === s.level ? "true" : undefined}
                >
                  <span className="edd-scale-label">{s.label}</span>
                  {s.range && <span className="edd-scale-range">{s.range}</span>}
                </li>
              ))}
            </ol>
            {scale.current === null && (
              <p className="edd-sub">Not rated: the source reports no intensity for this event, so no level is guessed.</p>
            )}
            <p className="edd-text">{d?.severityReason ?? `${SEVERITY_LABELS[event.severity]} severity`}</p>
            {d?.severitySource && <p className="edd-sub">{d.severitySource}</p>}

            <ul className="edd-context">
              {quakeMag !== null && (
                <li>
                  <strong>{quakeClass(quakeMag).label} earthquake:</strong> {quakeClass(quakeMag).meaning}.
                </li>
              )}
              {depth !== null && (
                <li>
                  <strong>{depthClass(depth).label}:</strong> {depthClass(depth).meaning}.
                </li>
              )}
              {isStorm && d?.peakKts !== null && d?.peakKts !== undefined && (
                <li>
                  <strong>{stormCategory(d.peakKts)} at its peak</strong>
                  {d.currentKts !== null && d.currentKts !== undefined && d.currentKts < d.peakKts
                    ? `; the latest advisory reports ${Math.round(d.currentKts).toLocaleString("en-GB")} kts (${stormCategory(d.currentKts).toLowerCase()}).`
                    : "."}
                </li>
              )}
              {d?.gdacsLevel && (
                <li>
                  <span className={`edd-gdacs edd-gdacs-${d.gdacsLevel}`}>{d.gdacsLevel}</span> GDACS level:{" "}
                  {GDACS_MEANING[d.gdacsLevel]}
                  {d.gdacsScore !== null && d.gdacsScore !== undefined ? ` (score ${d.gdacsScore})` : ""} ·{" "}
                  <a href="https://www.gdacs.org/" target="_blank" rel="noreferrer" className="text-link">
                    gdacs.org
                  </a>
                </li>
              )}
            </ul>

            {hasImpact && d && (
              <dl className="edd-rows edd-impact">
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
            )}
          </Section>

          {event.scores !== undefined && (
            <Section title="Why these scores?">
              <EventScores key={d?.eventId ?? event.id} scores={event.scores} eventId={d?.eventId} />
            </Section>
          )}

          <Section title="Where">
            <p className="edd-text">{d?.place ?? (cleanTitle(event.location) || NOT_REPORTED)}</p>
            {d?.locationPrecision === "approximate" && (
              <p className="edd-sub edd-approx">Approximate location — sources disagree on the exact area</p>
            )}
            {life && <p className="edd-sub edd-life">{life}</p>}
            {isQuake && (
              <dl className="edd-rows edd-where-rows">
                <Row label="Nearest place">
                  {d?.nearestPlace ? (
                    <>
                      {d.nearestPlace.name}
                      <div className="edd-sub">
                        {Math.round(d.nearestPlace.distanceKm).toLocaleString("en-GB")} km {d.nearestPlace.direction} of it (USGS)
                      </div>
                    </>
                  ) : (
                    <>
                      Unknown
                      <div className="edd-sub">USGS names a region here, not a place to measure from</div>
                    </>
                  )}
                </Row>
              </dl>
            )}
            {(event.type === "wildfire" || event.type === "flood") && (
              <dl className="edd-rows edd-where-rows">
                <Row label="Countries">
                  {d?.affectedCountries?.length ? (
                    <>
                      {d.affectedCountries.map(countryName).join(", ")}
                      <div className="edd-sub">Affected countries listed by GDACS</div>
                    </>
                  ) : (
                    <>
                      Unknown
                      <div className="edd-sub">GDACS has no answer for this event</div>
                    </>
                  )}
                </Row>
              </dl>
            )}
          </Section>

          {(event.type === "wildfire" || event.type === "flood" || event.type === "storm") && (
            <Section title="Impact">
              {gdacsRef ? (
                <EventImpact eventtype={gdacsRef.eventtype} eventid={gdacsRef.eventid} />
              ) : (
                <p className="edd-sub">Unknown: GDACS does not cover this event, and no other source reports its impact.</p>
              )}
            </Section>
          )}

          {(isStorm || event.type === "wildfire") && (
            <Section title="How it developed">
              {d?.timeline?.length ? (
                <EventTimeline points={d.timeline} unitLabel={isStorm ? "kts" : "ha"} />
              ) : (
                <p className="edd-sub">
                  Unknown: the source reports this {isStorm ? "storm" : "fire"} once, without a series to show its development.
                </p>
              )}
            </Section>
          )}

          {nearby && nearby.length > 0 && (
            <Section title="Nearby in this feed">
              <ul className="edd-nearby">
                {nearby.map(({ event: n, distanceKm }) => (
                  <li key={n.id}>
                    <button type="button" className="edd-nearby-btn" onClick={() => onSelectEvent?.(n.id)}>
                      <span className={`edd-nearby-dot sev-${n.severity}`} aria-hidden="true" />
                      <span className="edd-nearby-main">
                        <span className="edd-nearby-title">{n.details?.cleanTitle || cleanTitle(n.location)}</span>
                        <span className="edd-sub">
                          {TYPE_LABELS[n.type]} · {SEVERITY_LABELS[n.severity]} · {Math.round(distanceKm).toLocaleString("en-GB")} km away
                          {eventRelativeTime(n) ? ` · ${eventRelativeTime(n)}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          )}

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

          <details className="edd-section edd-tech">
            <summary className="edd-section-title">Technical details</summary>
            <dl className="edd-rows">
              <Row label="Occurred">{occurredAt ? utcString(occurredAt) : NOT_REPORTED}</Row>
              {d?.updatedAt && d.updatedAt !== occurredAt && (
                <Row label="Last update">
                  {utcString(d.updatedAt)}
                  <div className="edd-sub">{relativeTime(d.updatedAt)}</div>
                </Row>
              )}
              <Row label="Coordinates">
                {fmtCoord(event.lat)}, {fmtCoord(event.lng)}
              </Row>
              {d?.locationSource && (
                <Row label="Location from">
                  {d.locationSource === "gdacs" ? "GDACS event point" : "NASA EONET geometry"}
                  {d.locationOffsetKm !== null && d.locationOffsetKm !== undefined
                    ? ` (sources ${Math.round(d.locationOffsetKm).toLocaleString("en-GB")} km apart)`
                    : ""}
                </Row>
              )}
              {isQuake && d?.magType && <Row label="Magnitude type">{d.magType}</Row>}
              {!isQuake && d?.magnitudeValue !== null && d?.magnitudeValue !== undefined && (
                <Row label="Source value">
                  {d.magnitudeValue.toLocaleString("en-GB")} {d.magnitudeUnit ?? ""}
                </Row>
              )}
              {d?.eventId && <Row label="Event id">{d.eventId}</Row>}
            </dl>
          </details>
        </div>
      </div>
    </>
  );
};

export default EventDetailDrawer;
