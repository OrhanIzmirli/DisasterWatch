import { useEffect, useState } from "react";
import { getDisasterNews, type NewsItem } from "../services/newsService";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function NewsPanel({ isOpen, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [articles, setArticles] = useState<NewsItem[]>([]);

  useEffect(() => {
    if (!isOpen) return;

    let alive = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        // ✅ Daha fazla haber (max 30 mantıklı)
        const data = await getDisasterNews(30);
        if (!alive) return;
        setArticles(Array.isArray(data) ? data : []);
      } catch (e: any) {
        if (!alive) return;
        const msg =
          e?.message ||
          (typeof e === "string" ? e : "Failed to load news. Check endpoint.");
        setError(msg);
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      <div className="news-overlay" onClick={onClose} />
      <aside className="news-panel" role="dialog" aria-modal="true">
        <header className="news-header">
          <h2>Latest news</h2>
          <button className="news-close-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {/* ✅ Scroll garanti: panel içi içerik kaydırılabilir */}
        <div className="news-content" style={{ maxHeight: "70vh", overflowY: "auto" }}>
          {loading && (
            <div className="news-loading">
              <span className="news-spinner" />
              <span>Loading news…</span>
            </div>
          )}

          {error && <div className="news-error">{error}</div>}

          {!loading && !error && articles.length === 0 && (
            <div className="news-empty">No news available.</div>
          )}

          {!loading &&
            !error &&
            articles.map((a, idx) => (
              <article key={a.url || `${a.title}-${idx}`} className="news-item">
                <h3>{a.title}</h3>

                {a.summary ? <p>{a.summary}</p> : null}

                <div className="news-meta">
                  {a.source ? `${a.source} · ` : ""}
                  {a.publishedAt ? formatDate(a.publishedAt) : ""}
                  {" · "}
                  <a href={a.url} target="_blank" rel="noreferrer">
                    Open
                  </a>
                </div>
              </article>
            ))}
        </div>
      </aside>
    </>
  );
}
