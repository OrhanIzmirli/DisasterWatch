import { useEffect, useState } from "react";
import { pollWhileVisible } from "../utils/visiblePoll";

type NewsState = "OK" | "Stale" | "Unavailable" | "…";
type SystemState = "Operational" | "Degraded" | "Checking";

type Status = {
  system: SystemState;
  latencyMs: number | null;
  news: NewsState;
};

const POLL_MS = 30_000;

/**
 * Real values only: the backend latency is measured client-side against
 * /api/health, the news state comes from /api/news (OK / Stale /
 * Unavailable). When the backend cannot be reached the system shows Degraded.
 */
const StatusBar = () => {
  const [status, setStatus] = useState<Status>({ system: "Checking", latencyMs: null, news: "…" });

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      let system: SystemState = "Operational";
      let latencyMs: number | null = null;
      let news: NewsState = "Unavailable";

      try {
        const t0 = performance.now();
        const res = await fetch("/api/health", { cache: "no-store", headers: { Accept: "application/json" } });
        latencyMs = Math.round(performance.now() - t0);
        if (!res.ok) system = "Degraded";
      } catch {
        system = "Degraded";
      }

      if (system === "Operational") {
        try {
          const res = await fetch("/api/news?limit=1", { headers: { Accept: "application/json" } });
          if (res.ok) {
            const data = await res.json().catch(() => null);
            news = data?.stale ? "Stale" : "OK";
          } else {
            news = "Unavailable";
          }
        } catch {
          news = "Unavailable";
        }
      }

      if (!cancelled) setStatus({ system, latencyMs, news });
    };

    // paused while the tab is hidden: an open background tab must not keep the free-plan backend awake
    const stop = pollWhileVisible(check, POLL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  const dotClass =
    status.system === "Operational" ? "status-dot" : status.system === "Degraded" ? "status-dot status-dot-bad" : "status-dot status-dot-idle";

  const newsClass = status.news === "OK" ? "status-ok" : status.news === "Stale" ? "status-warn" : status.news === "…" ? "" : "status-bad";

  return (
    <div className="status-bar" role="region" aria-label="System status">
      <div className="status-left">
        <span className={dotClass} />
        <span>
          <strong>System status:</strong> {status.system}
        </span>
      </div>
      <div className="status-right">
        API latency: {status.latencyMs === null ? "…" : `${status.latencyMs} ms`} · News:{" "}
        <span className={newsClass}>{status.news}</span>
      </div>
    </div>
  );
};

export default StatusBar;
