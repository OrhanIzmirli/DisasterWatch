import { useEffect, useState } from "react";
import {
  apiIdOf,
  BAND_LABELS,
  confidenceBand,
  matchDescription,
  priorityBand,
  SOURCE_NAMES,
  type FeedScores,
  type ScoreExplanation,
} from "../utils/scores";

const SCORING_DOC = "https://github.com/OrhanIzmirli/DisasterWatch/blob/main/docs/scoring.md";

type Props = {
  /** Compact scores from the feed: shown at once. */
  scores: FeedScores | undefined;
  /** Feed event id ("usgs:…", "nasa:EONET_…"); the terms are fetched from the public API with it. */
  eventId: string | null | undefined;
};

type State = { status: "loading" } | { status: "ready"; data: ScoreExplanation } | { status: "error" };

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");

/**
 * "Why these scores?" in the event drawer: the confidence terms (points), the
 * priority terms (value × weight) and every source matched to the event, from
 * GET /api/v1/disasters/{id}. The scores themselves come with the feed, so
 * they show even when the explanation cannot be loaded.
 */
export default function EventScores({ scores, eventId }: Props) {
  const apiId = apiIdOf(eventId);
  const [state, setState] = useState<State>({ status: "loading" });

  const hasScores = !!scores;

  useEffect(() => {
    if (!apiId || !hasScores) return; // nothing to explain without scores
    const ctl = new AbortController(); // the drawer keys this component by event, so the state starts as "loading"
    fetch(`/api/v1/disasters/${encodeURIComponent(apiId)}`, { signal: ctl.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { data: ScoreExplanation }) => setState({ status: "ready", data: body.data }))
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name !== "AbortError") setState({ status: "error" });
      });
    return () => ctl.abort();
  }, [apiId, hasScores]);

  if (!scores) {
    return <p className="edd-sub">No scores for this event right now: the confirming sources could not be checked.</p>;
  }

  const data = state.status === "ready" ? state.data : null;
  const confirming = data?.sources.filter((s) => s.role !== "primary") ?? [];

  return (
    <div className="edd-scores">
      <dl className="edd-score-pills">
        <div className={`edd-score-pill edd-score-${priorityBand(scores.priority)}`}>
          <dt>Priority</dt>
          <dd>
            {scores.priority}
            <span className="edd-score-band"> {BAND_LABELS[priorityBand(scores.priority)]}</span>
          </dd>
        </div>
        <div className={`edd-score-pill edd-score-${confidenceBand(scores.confidence)}`}>
          <dt>Confidence</dt>
          <dd>
            {scores.confidence}
            <span className="edd-score-band"> {BAND_LABELS[confidenceBand(scores.confidence)]}</span>
          </dd>
        </div>
      </dl>
      <p className="edd-sub">
        {scores.confirmations === 0
          ? "No independent source confirms it yet."
          : `Confirmed by ${scores.confirmations} independent source${scores.confirmations === 1 ? "" : "s"}.`}
      </p>

      {state.status === "loading" && apiId && <p className="edd-sub" role="status">Loading how the scores were computed…</p>}
      {(state.status === "error" || !apiId) && <p className="edd-sub">The breakdown cannot be loaded right now; the scores above are current.</p>}

      {data?.confidence && (
        <table className="edd-score-table">
          <caption>Confidence {data.confidence.score}: is the event real and current?</caption>
          <thead>
            <tr>
              <th scope="col">Reason</th>
              <th scope="col" className="num">
                Points
              </th>
            </tr>
          </thead>
          <tbody>
            {data.confidence.components.map((c, i) => (
              <tr key={i}>
                <td>{c.reason}</td>
                <td className="num">{signed(c.points)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Confidence</th>
              <td className="num">{data.confidence.score}</td>
            </tr>
          </tfoot>
        </table>
      )}

      {data?.priority && (
        <table className="edd-score-table">
          <caption>Priority {data.priority.score}: which events matter most now?</caption>
          <thead>
            <tr>
              <th scope="col">Term</th>
              <th scope="col" className="num">
                Value
              </th>
              <th scope="col" className="num">
                Weight
              </th>
            </tr>
          </thead>
          <tbody>
            {data.priority.components.map((c) => (
              <tr key={c.term}>
                <td>
                  <span className="edd-score-term">{c.term[0].toUpperCase() + c.term.slice(1)}</span>
                  <span className="edd-sub"> {c.basis}</span>
                </td>
                <td className="num">{c.value ?? "unknown"}</td>
                <td className="num">{c.weight.toLocaleString("en-GB", { maximumFractionDigits: 2 })}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={2}>
                Priority (weighted sum)
              </th>
              <td className="num">{data.priority.score}</td>
            </tr>
          </tfoot>
        </table>
      )}

      {data && (
        <>
          <h5 className="edd-score-subtitle">Sources checked</h5>
          {confirming.length === 0 ? (
            <p className="edd-sub">Only the original source reports this event so far.</p>
          ) : (
            <ul className="edd-score-sources">
              {confirming.map((s, i) => (
                <li key={`${s.source}-${i}`}>
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-link">
                      {SOURCE_NAMES[s.source]}
                    </a>
                  ) : (
                    SOURCE_NAMES[s.source]
                  )}
                  <span className="edd-sub"> {matchDescription(s)}</span>
                </li>
              ))}
            </ul>
          )}
          {data.ambiguousSources.length > 0 && (
            <p className="edd-sub">
              {data.ambiguousSources.map((s) => SOURCE_NAMES[s as keyof typeof SOURCE_NAMES] ?? s).join(", ")}: two candidates fitted almost equally well, so neither
              was counted.
            </p>
          )}
        </>
      )}

      <p className="edd-sub">
        <a href={SCORING_DOC} target="_blank" rel="noopener noreferrer" className="text-link">
          How the scores are computed
        </a>{" "}
        · indicative, not an official warning
      </p>
    </div>
  );
}
