/**
 * Marker clustering logic (pure, unit-tested). Rendering lives in MapView.
 *
 * Built on supercluster: a KD-tree index of the map's events that answers
 * "which clusters/points are inside this bounding box at this zoom" in
 * well under a millisecond for a few hundred points, so re-clustering on
 * every zoom/pan is cheap. Cluster properties are aggregated with
 * supercluster's map/reduce: counts per type and per severity, from which
 * the highest severity and the tooltip text are derived.
 */
import Supercluster from "supercluster";

export type ClusterType = "earthquake" | "flood" | "wildfire" | "storm";
export type ClusterSeverity = "high" | "medium" | "low" | "unrated";

export type ClusterPoint = {
  id: number;
  type: ClusterType;
  severity: ClusterSeverity;
  lat: number;
  lng: number;
};

/** Aggregated per-cluster properties (also present on single points via `map`). */
export type ClusterProps = {
  earthquake: number;
  flood: number;
  wildfire: number;
  storm: number;
  high: number;
  medium: number;
  low: number;
  unrated: number;
};

type PointProps = { pointId: number; type: ClusterType; severity: ClusterSeverity };

export const CLUSTER_RADIUS_PX = 48;
export const CLUSTER_MIN_POINTS = 2;
export const SEVERITY_RANK: Record<ClusterSeverity, number> = { high: 0, medium: 1, low: 2, unrated: 3 };
const TYPE_LABELS: Record<ClusterType, [string, string]> = {
  earthquake: ["earthquake", "earthquakes"],
  flood: ["flood", "floods"],
  wildfire: ["wildfire", "wildfires"],
  storm: ["storm", "storms"],
};

export type ClusterIndex = Supercluster<PointProps, ClusterProps>;

/** Builds the index for the given points (clusters exist up to `maxZoom`, the map's own max zoom). */
export function buildClusterIndex(points: ClusterPoint[], { maxZoom = 10, radius = CLUSTER_RADIUS_PX } = {}): ClusterIndex {
  const index = new Supercluster<PointProps, ClusterProps>({
    radius,
    maxZoom,
    minPoints: CLUSTER_MIN_POINTS,
    map: (p) => ({
      earthquake: p.type === "earthquake" ? 1 : 0,
      flood: p.type === "flood" ? 1 : 0,
      wildfire: p.type === "wildfire" ? 1 : 0,
      storm: p.type === "storm" ? 1 : 0,
      high: p.severity === "high" ? 1 : 0,
      medium: p.severity === "medium" ? 1 : 0,
      low: p.severity === "low" ? 1 : 0,
      unrated: p.severity === "unrated" ? 1 : 0,
    }),
    reduce: (acc, p) => {
      acc.earthquake += p.earthquake;
      acc.flood += p.flood;
      acc.wildfire += p.wildfire;
      acc.storm += p.storm;
      acc.high += p.high;
      acc.medium += p.medium;
      acc.low += p.low;
      acc.unrated += p.unrated;
    },
  });
  index.load(
    points.map((p) => ({
      type: "Feature" as const,
      properties: { pointId: p.id, type: p.type, severity: p.severity },
      geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
    }))
  );
  return index;
}

export type ClusterFeature = {
  kind: "cluster";
  clusterId: number;
  count: number;
  lat: number;
  lng: number;
  props: ClusterProps;
};
export type PointFeature = { kind: "point"; pointId: number; lat: number; lng: number };

/** Clusters and single points inside the bbox [west, south, east, north] at an integer zoom. */
export function getClustersInView(index: ClusterIndex, bbox: [number, number, number, number], zoom: number): Array<ClusterFeature | PointFeature> {
  const z = Math.max(0, Math.floor(zoom));
  return index.getClusters(bbox, z).map((f) => {
    const [lng, lat] = f.geometry.coordinates;
    const props = f.properties as Record<string, unknown>;
    if (props.cluster) {
      return { kind: "cluster", clusterId: props.cluster_id as number, count: props.point_count as number, lat, lng, props: props as unknown as ClusterProps };
    }
    return { kind: "point", pointId: (props as PointProps).pointId, lat, lng };
  });
}

/** Fixed order of the types in a split ring and in the breakdown text. */
export const TYPE_ORDER: ClusterType[] = ["wildfire", "earthquake", "flood", "storm"];

/** Cluster colours = the marker colours of the types (MapView.getColorByType). */
export const TYPE_COLORS: Record<ClusterType, string> = {
  wildfire: "#F97316",
  earthquake: "#C1121F",
  flood: "#3B82F6",
  storm: "#9CA3AF",
};

export type TypeSegment = { type: ClusterType; count: number; percent: number };

/**
 * The types present in a cluster, in TYPE_ORDER, with their share of the
 * events in percent (rounded to 0.01, summing to 100 up to rounding).
 */
export function typeSegments(props: ClusterProps): TypeSegment[] {
  const total = TYPE_ORDER.reduce((n, t) => n + (props[t] ?? 0), 0);
  if (total <= 0) return [];
  return TYPE_ORDER.filter((t) => (props[t] ?? 0) > 0).map((t) => ({
    type: t,
    count: props[t],
    percent: Math.round((100 * props[t]) / total * 100) / 100,
  }));
}

/**
 * CSS background of a cluster: one solid type colour when a single type is
 * inside, otherwise a conic-gradient ring split proportionally to the type
 * counts, in TYPE_ORDER starting at 12 o'clock.
 */
export function clusterBackground(props: ClusterProps): string {
  const segments = typeSegments(props);
  if (segments.length === 0) return TYPE_COLORS.storm;
  if (segments.length === 1) return TYPE_COLORS[segments[0].type];
  let from = 0;
  const stops = segments.map((s, i) => {
    const to = i === segments.length - 1 ? 100 : from + s.percent;
    const stop = `${TYPE_COLORS[s.type]} ${from}% ${to}%`;
    from = to;
    return stop;
  });
  return `conic-gradient(${stops.join(", ")})`;
}

/** Highest severity present in a cluster (tooltip only; colours come from the types). */
export function highestSeverity(props: ClusterProps): ClusterSeverity {
  if (props.high > 0) return "high";
  if (props.medium > 0) return "medium";
  if (props.low > 0) return "low";
  return "unrated"; // only events without a rating inside
}

/** "6 wildfires, 1 flood" (most frequent type first). */
export function typeBreakdown(props: ClusterProps): string {
  return (["wildfire", "earthquake", "flood", "storm"] as ClusterType[])
    .map((t) => [t, props[t]] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${TYPE_LABELS[t][n === 1 ? 0 : 1]}`)
    .join(", ");
}

const SEVERITY_LABEL: Record<ClusterSeverity, string> = { high: "High", medium: "Medium", low: "Low", unrated: "Not rated" };

/** Tooltip text: "7 events · 6 wildfires, 1 flood · highest: High". */
export function clusterTooltip(count: number, props: ClusterProps): string {
  return `${count} events · ${typeBreakdown(props)} · highest: ${SEVERITY_LABEL[highestSeverity(props)]}`;
}

/**
 * Cluster circle radius in px: grows with log2 of the count so a 300-event
 * cluster is noticeably bigger than a 3-event one without covering the map
 * (2 -> 15, 8 -> 21, 64 -> 27, 300 -> 30, capped at 32).
 */
export function clusterRadius(count: number): number {
  const r = 12 + 3 * Math.log2(Math.max(2, count));
  return Math.min(32, Math.round(r));
}

/** Zoom at which the cluster splits, or null when its points cannot be separated (same/very close coordinates). */
export function expansionZoom(index: ClusterIndex, clusterId: number, maxZoom: number): number | null {
  const z = index.getClusterExpansionZoom(clusterId);
  return z > maxZoom ? null : z;
}

/** Ids and coordinates of every point in a cluster. */
export function clusterLeaves(index: ClusterIndex, clusterId: number): PointFeature[] {
  return index.getLeaves(clusterId, Infinity).map((f) => {
    const [lng, lat] = f.geometry.coordinates;
    return { kind: "point", pointId: (f.properties as PointProps).pointId, lat, lng };
  });
}

/**
 * Smallest zoom (>= fromZoom) at which the point is rendered on its own and
 * not inside a cluster; null when it never separates before maxZoom (the
 * cluster then has to be spiderfied).
 */
export function zoomToReveal(index: ClusterIndex, point: { id: number; lat: number; lng: number }, fromZoom: number, maxZoom: number): number | null {
  const eps = 1e-6;
  const bbox: [number, number, number, number] = [point.lng - eps, point.lat - eps, point.lng + eps, point.lat + eps];
  for (let z = Math.max(0, Math.floor(fromZoom)); z <= maxZoom; z++) {
    // getClusters only returns features whose own coordinates fall inside
    // the bbox, so a cluster that swallowed the point but sits elsewhere is
    // invisible here: ask explicitly whether the point is a standalone
    // feature at this zoom by comparing against all features in a wider box.
    const span = 180 / 2 ** z; // generous: half a tile width in degrees
    const wide: [number, number, number, number] = [point.lng - span, point.lat - span, point.lng + span, point.lat + span];
    const standalone = index.getClusters(wide, z).some((f) => !(f.properties as Record<string, unknown>).cluster && (f.properties as PointProps).pointId === point.id);
    if (standalone) return z;
    void bbox;
  }
  return null;
}

/** Positions for spiderfied leaves: a ring around the cluster, in container pixels. */
export function spiderPositions(count: number, centerPx: { x: number; y: number }): Array<{ x: number; y: number }> {
  const n = Math.max(1, count);
  const radius = Math.min(90, 26 + n * 6);
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    out.push({ x: centerPx.x + radius * Math.cos(angle), y: centerPx.y + radius * Math.sin(angle) });
  }
  return out;
}
