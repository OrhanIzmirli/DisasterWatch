import { useEffect, useState } from "react";
import { getDisasterNews, type NewsItem } from "../services/newsService";
import { relativeTime } from "../utils/formatDate";

type Props = {
  eventId: number;
  max?: number;
};

/** Up to `max` articles linked to one feed event, for the event detail drawer. */
const RelatedNews = ({ eventId, max = 3 }: Props) => {
  // The answer is stored with the event it belongs to; anything else (a newer
  // event selected, nothing back yet) reads as "loading", so state is only set
  // from the request's callbacks, never synchronously inside the effect.
  const requestKey = `${eventId}:${max}`;
  const [result, setResult] = useState<{ key: string; items: NewsItem[] | null; failed: boolean } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getDisasterNews({ eventId, limit: max }, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key: requestKey, items: data.items.slice(0, max), failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key: requestKey, items: null, failed: true });
      });
    return () => controller.abort();
  }, [eventId, max, requestKey]);

  const current = result && result.key === requestKey ? result : null;
  const failed = current?.failed ?? false;
  const items = current ? current.items : null;

  if (failed) return <p className="edd-sub">News service unavailable.</p>;
  if (!current || items === null) return <p className="edd-sub">Looking for coverage…</p>;
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
