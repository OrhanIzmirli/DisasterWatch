import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getDisasterNews, NewsError, type NewsItem, type NewsType } from "../services/newsService";
import { relativeTime } from "../utils/formatDate";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

type Filter = "all" | NewsType;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "earthquake", label: "Earthquakes" },
  { key: "flood", label: "Floods" },
  { key: "wildfire", label: "Wildfires" },
  { key: "storm", label: "Storms" },
];

const TYPE_LABELS: Record<NewsType, string> = {
  earthquake: "Earthquake",
  flood: "Flood",
  wildfire: "Wildfire",
  storm: "Storm",
};

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function eventTagText(item: NewsItem) {
  const e = item.relatedEvent;
  if (!e) return null;
  return `${TYPE_LABELS[e.type] ?? capitalise(e.type)} · ${e.location} · ${capitalise(e.severity)}`;
}

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
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "ready">("idle");
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<NewsItem[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const load = useCallback(
    async (f: Filter, signal?: AbortSignal) => {
      setStatus("loading");
      setError(null);
      try {
        const data = await getDisasterNews({ type: f === "all" ? null : f }, signal);
        if (signal?.aborted) return;
        setItems(data.items);
        setUpdatedAt(data.updatedAt);
        setStale(data.stale);
        setStatus("ready");
      } catch (e) {
        if (signal?.aborted) return;
        setError(e instanceof NewsError ? e.message : "Could not reach the news service.");
        setStatus("error");
      }
    },
    []
  );

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    load(filter, controller.signal);
    return () => controller.abort();
  }, [isOpen, filter, load]);

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

  return (
    <>
      <div className="news-overlay" onClick={onClose} />
      <aside className="news-panel" role="dialog" aria-modal="true" aria-label="Latest news">
        <header className="news-header">
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
        </header>

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
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => load(filter)}>
                Try again
              </button>
            </div>
          )}

          {status === "ready" && stale && (
            <div className="news-stale-banner">
              The news service could not refresh; showing the last successful update ({updatedText}).
            </div>
          )}

          {status === "ready" && items.length === 0 && (
            <div className="news-state muted">
              {filter === "all" ? "No news available right now." : `No ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} news in the last 72 hours.`}
            </div>
          )}

          {status === "ready" && items.length > 0 && (
            <ul className="news-list">
              {items.map((a) => {
                const tag = eventTagText(a);
                return (
                  <li key={a.url} className="news-card">
                    {a.image && (
                      <img className="news-card-image" src={a.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    )}
                    <div className="news-card-body">
                      <div className="news-card-meta">
                        <span className="news-card-domain">{a.domain || "unknown source"}</span>
                        {a.publishedAt && <span> · {relativeTime(a.publishedAt)}</span>}
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
      </aside>
    </>
  );
}
