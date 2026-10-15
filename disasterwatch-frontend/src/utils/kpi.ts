/**
 * Dashboard KPIs from the backend's whole-window counts (`counts` on
 * GET /disasters), so they never depend on the page size. Falls back to the
 * loaded items when the backend did not send counts (older cached payloads).
 */
export type Severity = "high" | "medium" | "low" | "unrated";
export type SeverityCounts = Record<Severity, number>;
export type FeedCounts = {
  total: number;
  bySeverity: SeverityCounts;
  byType: Record<string, SeverityCounts & { total: number }>;
};

const SEVERITIES: Severity[] = ["high", "medium", "low", "unrated"];

const isCounts = (c: unknown): c is FeedCounts =>
  typeof c === "object" && c !== null && typeof (c as FeedCounts).total === "number" && typeof (c as FeedCounts).bySeverity === "object";

/** Narrows an API payload; null when it is not a counts object. */
export function readCounts(value: unknown): FeedCounts | null {
  if (!isCounts(value)) return null;
  const sev = (o: Partial<SeverityCounts> | undefined): SeverityCounts =>
    Object.fromEntries(SEVERITIES.map((s) => [s, Number(o?.[s] ?? 0) || 0])) as SeverityCounts;
  const byType: FeedCounts["byType"] = {};
  for (const [type, o] of Object.entries(value.byType ?? {})) byType[type] = { total: Number(o?.total ?? 0) || 0, ...sev(o) };
  return { total: value.total, bySeverity: sev(value.bySeverity), byType };
}

export type KpiNumbers = { total: number; significant: number };

/** "Significant events" = high + medium; not-rated events never count. */
export function kpiFromCounts(counts: FeedCounts, filter: "all" | string): KpiNumbers {
  if (filter === "all") return { total: counts.total, significant: counts.bySeverity.high + counts.bySeverity.medium };
  const c = counts.byType[filter] ?? { total: 0, high: 0, medium: 0, low: 0, unrated: 0 };
  return { total: c.total, significant: c.high + c.medium };
}

/** Same numbers from the loaded items (fallback when counts are missing). */
export function kpiFromItems(items: Array<{ type: string; severity: Severity }>, filter: "all" | string): KpiNumbers {
  const list = filter === "all" ? items : items.filter((d) => d.type === filter);
  return { total: list.length, significant: list.filter((d) => d.severity === "high" || d.severity === "medium").length };
}
