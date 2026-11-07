import { formatDateTime } from "../utils/formatDate";

export type TimelinePoint = { at: string; value: number | null; unit: "kts" | "ha"; lat: number | null; lng: number | null };

const W = 300;
const H = 90;
const PAD = { top: 10, right: 8, bottom: 18, left: 34 };

/**
 * How an event developed (EONET geometry series): a small line chart of the
 * measured value over time, with the first, peak and latest values spelled out
 * for screen readers and for anyone who does not read charts.
 */
const EventTimeline = ({ points, unitLabel }: { points: TimelinePoint[]; unitLabel: string }) => {
  const measured = points.filter((p): p is TimelinePoint & { value: number } => p.value !== null);
  if (measured.length < 2) {
    return <p className="edd-sub">The source reports {points.length} positions but no measurements to chart.</p>;
  }
  const t0 = Date.parse(measured[0].at);
  const t1 = Date.parse(measured[measured.length - 1].at);
  const max = Math.max(...measured.map((p) => p.value));
  const span = Math.max(1, t1 - t0);
  const x = (at: string) => PAD.left + ((Date.parse(at) - t0) / span) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / (max || 1)) * (H - PAD.top - PAD.bottom);
  const path = measured.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const peak = measured.reduce((a, b) => (b.value > a.value ? b : a));
  const first = measured[0];
  const latest = measured[measured.length - 1];
  const fmt = (v: number) => `${Math.round(v).toLocaleString("en-GB")} ${unitLabel}`;
  const summary = `From ${fmt(first.value)} on ${formatDateTime(first.at)} to a peak of ${fmt(peak.value)} on ${formatDateTime(peak.at)}; latest ${fmt(latest.value)} on ${formatDateTime(latest.at)}.`;

  return (
    <figure className="edd-timeline">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="edd-timeline-chart">
        <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} className="edd-timeline-axis" />
        <text x={PAD.left - 4} y={y(max) + 4} textAnchor="end" className="edd-timeline-tick">
          {Math.round(max).toLocaleString("en-GB")}
        </text>
        <text x={PAD.left - 4} y={H - PAD.bottom} textAnchor="end" className="edd-timeline-tick">
          0
        </text>
        <path d={path} className="edd-timeline-line" />
        <circle cx={x(peak.at)} cy={y(peak.value)} r={3.5} className="edd-timeline-peak" />
        <circle cx={x(latest.at)} cy={y(latest.value)} r={3} className="edd-timeline-latest" />
      </svg>
      <figcaption className="edd-sub">{summary}</figcaption>
    </figure>
  );
};

export default EventTimeline;
