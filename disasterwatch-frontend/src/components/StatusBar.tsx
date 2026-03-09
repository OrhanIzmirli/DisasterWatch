import { useEffect, useMemo, useState } from "react";

type ApiHealth = "OK" | "Degraded";

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

const StatusBar = () => {
  const [latency, setLatency] = useState(120);
  const [newsApi, setNewsApi] = useState<ApiHealth>("OK");

  const startedAt = useMemo(() => Date.now(), []);

  useEffect(() => {
    const tick = () => {
      // Latency'yi "yaşıyormuş" gibi oynat
      const jitter = Math.round((Math.random() - 0.5) * 30);
      setLatency((prev) => clamp(prev + jitter, 70, 240));

      // Arada bir News API degrade gibi görünsün
      const roll = Math.random();
      setNewsApi(roll < 0.12 ? "Degraded" : "OK");
    };

    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  const uptimeMinutes = Math.floor((Date.now() - startedAt) / 60000);

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        <span className="status-dot status-dot-green" />
        <span className="status-label">System status: Operational</span>
        <span className="status-sep">•</span>
        <span className="status-muted">Uptime: {uptimeMinutes} min</span>
      </div>

      <div className="statusbar-right">
        <span className="status-muted">API latency: ~{latency} ms</span>
        <span className="status-sep">•</span>
        <span className="status-muted">
          News API:{" "}
          <span className={newsApi === "OK" ? "status-ok" : "status-warn"}>
            {newsApi}
          </span>
        </span>
      </div>
    </div>
  );
};

export default StatusBar;
