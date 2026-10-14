import { useEffect, useState } from "react";
import { getDisasterNews, type NewsItem } from "../services/newsService";
import { relativeTime } from "../utils/formatDate";

type Props = {
  eventId: number;
  max?: number;
};

/** Up to `max` articles linked to one feed event, for the event detail drawer. */
const RelatedNews = ({ eventId, max = 3 }: Props) => {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setItems(null);
    setFailed(false);
    getDisasterNews({ eventId, limit: max }, controller.signal)
      .then((data) => setItems(data.items.slice(0, max)))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [eventId, max]);

  if (failed) return <p className="edd-sub">News service unavailable.</p>;
  if (items === null) return <p className="edd-sub">Looking for coverage…</p>;
  if (items.length === 0) return <p className="edd-sub">No linked coverage in the last 72 hours.</p>;

  return (
    <ul className="edd-news">
      {items.map((a) => (
        <li key={a.url}>
          <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-link">
            {a.title}
          </a>
          <div className="edd-sub">
            {a.domain}
            {a.publishedAt ? ` · ${relativeTime(a.publishedAt)}` : ""}
          </div>
        </li>
      ))}
    </ul>
  );
};

export default RelatedNews;
