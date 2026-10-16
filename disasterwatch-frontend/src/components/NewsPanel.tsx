import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getDisasterNews, NewsError, type NewsItem, type NewsType } from "../services/newsService";
import { relativeTime } from "../utils/formatDate";
import { eventTagText, providerText } from "../utils/newsText";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

type Filter = "all" | NewsType;

type LoadResult =
  | { key: string; ok: true; items: NewsItem[]; updatedAt: string | null; stale: boolean }
  | { key: string; ok: false; error: string };

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "earthquake", label: "Earthquakes" },
  { key: "flood", label: "Floods" },
  { key: "wildfire", label: "Wildfires" },
  { key: "storm", label: "Storms" },
];

function Skeleton() {
  return (
    <ul className="news-list" aria-busy="true" aria-label="Loading news">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="news-card news-card-skeleton">
          <div className="news-skel news-skel-meta" />
          <div className="news-skel news-skel-title" />
          <div className="news-skel news-skel-title short" />
        </li>
      ))}
    </ul>
  );
}

export default function NewsPanel({ isOpen, onClose }: Props) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("all");
  // Every request is identified by filter + attempt; the panel shows "loading"
  // until the answer for the current request has arrived, so state is only set
  // from the request's callbacks (never synchronously inside the effect).
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<LoadResult | null>(null);
  // A fresh load each time the panel opens (state adjusted during render, not in an effect)
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setAttempt((a) => a + 1);
  }
  const requestKey = `${filter}#${attempt}`;

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    getDisasterNews({ type: filter === "all" ? null : filter }, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setResult({ key: requestKey, ok: true, items: data.items, updatedAt: data.updatedAt, stale: data.stale });
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setResult({ key: requestKey, ok: false, error: e instanceof NewsError ? e.message : "Could not reach the news service." });
      });
    return () => controller.abort();
  }, [isOpen, filter, requestKey]);

  const current = result && result.key === requestKey ? result : null;
  const status: "loading" | "error" | "ready" = !current ? "loading" : current.ok ? "ready" : "error";
  const items = current?.ok ? current.items : [];
  const updatedAt = current?.ok ? current.updatedAt : null;
  const stale = current?.ok ? current.stale : false;
  const error = current && !current.ok ? current.error : null;
  const retry = () => setAttempt((a) => a + 1);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const showOnMap = (eventId: number) => {
    onClose();
    navigate(`/?event=${eventId}`);
  };

  const updatedText = updatedAt ? relativeTime(updatedAt) : null;
  // Guardian Open Platform terms: the "Powered by The Guardian" logo must sit on the
  // same page as Guardian content and link back to theguardian.com.
  const showsGuardian = status === "ready" && items.some((a) => a.provider === "guardian");

  return (
    <>
      <div className="news-overlay" onClick={onClose} />
      <div className="news-panel" role="dialog" aria-modal="true" aria-label="Latest news">
        <div className="news-header">
          <div>
            <h2>Latest news</h2>
            {status === "ready" && updatedText && (
              <p className={stale ? "news-updated news-updated-stale" : "news-updated"}>
                {stale ? `Stale · last update ${updatedText}` : `Updated ${updatedText}`}
              </p>
            )}
          </div>
          <button className="news-close-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="news-filters" role="tablist" aria-label="Filter news by hazard">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              className={filter === f.key ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm"}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="news-content">
          {status === "loading" && <Skeleton />}

          {status === "error" && (
            <div className="news-state">
              <div className="form-error">{error}</div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>
                Try again
              </button>
            </div>
          )}

          {status === "ready" && stale && (
            <div className="news-stale-banner">
              The news service could not refresh; showing the last successful update ({updatedText}).
            </div>
          )}

          {showsGuardian && (
            <a
              className="news-powered-by"
              href="https://www.theguardian.com"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Powered by The Guardian (opens theguardian.com)"
            >
              <img src="/powered-by-guardian.png" alt="Powered by The Guardian" width={140} height={45} />
            </a>
          )}

          {status === "ready" && items.length === 0 && (
            <div className="news-state muted">
              <p>
                {filter === "all"
                  ? "No disaster coverage from GDELT or The Guardian in the last 72 hours."
                  : `No ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} coverage from GDELT or The Guardian in the last 72 hours.`}
              </p>
              <p className="news-state-hint">The sources are checked again each time you open this panel.</p>
            </div>
          )}

          {status === "ready" && items.length > 0 && (
            <ul className="news-list">
              {items.map((a) => {
                const tag = eventTagText(a);
                const via = providerText(a);
                return (
                  <li key={a.url} className={a.provider ? `news-card news-card-${a.provider}` : "news-card"}>
                    {a.image && a.provider !== "guardian" && (
                      <img className="news-card-image" src={a.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    )}
                    <div className="news-card-body">
                      <div className="news-card-meta">
                        <span className="news-card-domain">{a.domain || "unknown source"}</span>
                        {a.publishedAt && <span> · {relativeTime(a.publishedAt)}</span>}
                        {via && <span className="news-card-provider"> · {via}</span>}
                      </div>
                      <h3 className="news-card-title">
                        <a href={a.url} target="_blank" rel="noopener noreferrer">
                          {a.title}
                        </a>
                      </h3>
                      {a.relatedEvent && tag && (
                        <div className="news-card-event">
                          <span className={`news-event-tag news-event-tag-${a.relatedEvent.severity}`}>{tag}</span>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => showOnMap(a.relatedEvent!.id)}
                          >
                            Show on map
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
