import { useEffect, useState } from "react";

type Impact = {
  populationAffected: number | null;
  reported: { kind: string; value: number; region: string | null; country: string | null }[];
};

type Props = { eventtype: string; eventid: string };

/**
 * GDACS impact figures for one event, loaded when the drawer opens
 * (GET /api/disasters/impact). Shows "unknown" for anything GDACS does not
 * publish; never estimates.
 */
const EventImpact = ({ eventtype, eventid }: Props) => {
  const key = `${eventtype}:${eventid}`;
  const [result, setResult] = useState<{ key: string; impact: Impact | null; failed: boolean } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/disasters/impact?eventtype=${encodeURIComponent(eventtype)}&eventid=${encodeURIComponent(eventid)}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as Impact;
        if (!controller.signal.aborted) setResult({ key, impact: data, failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key, impact: null, failed: true });
      });
    return () => controller.abort();
  }, [eventtype, eventid, key]);

  const current = result && result.key === key ? result : null;
  if (!current) return <p className="edd-sub">Asking GDACS for impact figures…</p>;
  if (current.failed || !current.impact) {
    return <p className="edd-sub">GDACS is not reachable right now, so the impact figures are unknown.</p>;
  }
  const { populationAffected, reported } = current.impact;
  return (
    <dl className="edd-rows">
      <div className="edd-row">
        <dt>People in the area</dt>
        <dd>
          {populationAffected !== null ? (
            <>
              {populationAffected.toLocaleString("en-GB")}
              <div className="edd-sub">GDACS estimate of people living in the affected area</div>
            </>
          ) : (
            <>
              Unknown
              <div className="edd-sub">GDACS publishes no population estimate for this event</div>
            </>
          )}
        </dd>
      </div>
      <div className="edd-row">
        <dt>Reported</dt>
        <dd>
          {reported.length ? (
            <ul className="edd-reported">
              {reported.map((r, i) => (
                <li key={`${r.kind}-${r.region}-${i}`}>
                  <strong>{r.value.toLocaleString("en-GB")}</strong> {r.kind}
                  {r.region ? <span className="edd-sub"> · {r.region}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <>
              None reported
              <div className="edd-sub">GDACS lists no reported casualties or damage for this event</div>
            </>
          )}
        </dd>
      </div>
    </dl>
  );
};

export default EventImpact;
