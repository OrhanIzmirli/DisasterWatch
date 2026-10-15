import { describe, it, expect } from "vitest";
import {
  buildClusterIndex,
  getClustersInView,
  highestSeverity,
  typeBreakdown,
  clusterTooltip,
  clusterRadius,
  expansionZoom,
  clusterLeaves,
  zoomToReveal,
  spiderPositions,
  type ClusterPoint,
} from "./clustering";

// Eight wildfires within ~150 km in Queensland + one flood nearby + a quake far away (Fiji).
const AUSTRALIA: ClusterPoint[] = [
  { id: 1, type: "wildfire", severity: "high", lat: -16.75, lng: 144.78 },
  { id: 2, type: "wildfire", severity: "high", lat: -16.9, lng: 144.9 },
  { id: 3, type: "wildfire", severity: "high", lat: -17.1, lng: 145.1 },
  { id: 4, type: "wildfire", severity: "high", lat: -17.3, lng: 144.6 },
  { id: 5, type: "wildfire", severity: "high", lat: -16.5, lng: 145.2 },
  { id: 6, type: "wildfire", severity: "high", lat: -17.0, lng: 144.4 },
  { id: 7, type: "flood", severity: "medium", lat: -17.2, lng: 145.3 },
  { id: 8, type: "earthquake", severity: "medium", lat: -20.99, lng: -178.77 },
];
const WORLD: [number, number, number, number] = [-180, -85, 180, 85];

describe("grouping", () => {
  it("groups nearby events into one cluster at world zoom and leaves far events alone", () => {
    const index = buildClusterIndex(AUSTRALIA);
    const features = getClustersInView(index, WORLD, 2);
    const clusters = features.filter((f) => f.kind === "cluster");
    const points = features.filter((f) => f.kind === "point");
    expect(clusters).toHaveLength(1);
    expect(clusters[0].kind === "cluster" && clusters[0].count).toBe(7);
    expect(points.map((p) => p.kind === "point" && p.pointId)).toEqual([8]);
  });

  it("splits the cluster at a higher zoom", () => {
    const index = buildClusterIndex(AUSTRALIA);
    const [cluster] = getClustersInView(index, WORLD, 2).filter((f) => f.kind === "cluster");
    const z = expansionZoom(index, (cluster as { clusterId: number }).clusterId, 10);
    expect(z).not.toBeNull();
    expect(z!).toBeGreaterThan(2);
    const at = getClustersInView(index, WORLD, 10);
    expect(at.filter((f) => f.kind === "point")).toHaveLength(8);
  });

  it("returns the leaves of a cluster", () => {
    const index = buildClusterIndex(AUSTRALIA);
    const [cluster] = getClustersInView(index, WORLD, 2).filter((f) => f.kind === "cluster");
    const leaves = clusterLeaves(index, (cluster as { clusterId: number }).clusterId);
    expect(leaves.map((l) => l.pointId).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("events at the same coordinates never separate: expansion zoom is null (spiderfy case)", () => {
    const same: ClusterPoint[] = [
      { id: 1, type: "wildfire", severity: "low", lat: -17, lng: 145 },
      { id: 2, type: "wildfire", severity: "high", lat: -17, lng: 145 },
      { id: 3, type: "flood", severity: "medium", lat: -17.00001, lng: 145.00001 },
    ];
    const index = buildClusterIndex(same, { maxZoom: 10 });
    const [cluster] = getClustersInView(index, WORLD, 10).filter((f) => f.kind === "cluster");
    expect(cluster).toBeDefined();
    expect(expansionZoom(index, (cluster as { clusterId: number }).clusterId, 10)).toBeNull();
    expect(zoomToReveal(index, { id: 2, lat: -17, lng: 145 }, 4, 10)).toBeNull();
  });

  it("zoomToReveal finds the zoom where a clustered point stands alone", () => {
    const index = buildClusterIndex(AUSTRALIA);
    const z = zoomToReveal(index, { id: 7, lat: -17.2, lng: 145.3 }, 4, 10);
    expect(z).not.toBeNull();
    expect(z!).toBeGreaterThanOrEqual(4);
    expect(z!).toBeLessThanOrEqual(10);
    // the far-away quake is already alone at zoom 4
    expect(zoomToReveal(index, { id: 8, lat: -20.99, lng: -178.77 }, 4, 10)).toBe(4);
  });
});

describe("severity and type aggregation", () => {
  it("cluster severity is the highest severity inside it", () => {
    const index = buildClusterIndex(AUSTRALIA);
    const [cluster] = getClustersInView(index, WORLD, 2).filter((f) => f.kind === "cluster");
    const props = (cluster as { props: Parameters<typeof highestSeverity>[0] }).props;
    expect(highestSeverity(props)).toBe("high");
    expect(highestSeverity({ earthquake: 0, flood: 2, wildfire: 0, storm: 0, high: 0, medium: 1, low: 1 })).toBe("medium");
    expect(highestSeverity({ earthquake: 0, flood: 2, wildfire: 0, storm: 0, high: 0, medium: 0, low: 2 })).toBe("low");
  });

  it("counts types and builds the tooltip text", () => {
    const index = buildClusterIndex(AUSTRALIA);
    const [cluster] = getClustersInView(index, WORLD, 2).filter((f) => f.kind === "cluster") as Array<{ count: number; props: Parameters<typeof typeBreakdown>[0] }>;
    expect(cluster.props.wildfire).toBe(6);
    expect(cluster.props.flood).toBe(1);
    expect(typeBreakdown(cluster.props)).toBe("6 wildfires, 1 flood");
    expect(clusterTooltip(cluster.count, cluster.props)).toBe("7 events · 6 wildfires, 1 flood · highest: High");
    expect(typeBreakdown({ earthquake: 1, flood: 0, wildfire: 0, storm: 3, high: 0, medium: 0, low: 4 })).toBe("3 storms, 1 earthquake");
  });
});

describe("sizing and spiderfy geometry", () => {
  it("cluster radius grows logarithmically and is capped", () => {
    expect(clusterRadius(2)).toBe(15);
    expect(clusterRadius(8)).toBe(21);
    expect(clusterRadius(64)).toBe(30);
    expect(clusterRadius(300)).toBe(32);
    expect(clusterRadius(100000)).toBe(32);
  });

  it("spider positions form a ring around the centre", () => {
    const pos = spiderPositions(4, { x: 100, y: 100 });
    expect(pos).toHaveLength(4);
    const dist = pos.map((p) => Math.hypot(p.x - 100, p.y - 100));
    for (const d of dist) expect(Math.abs(d - dist[0])).toBeLessThan(1e-9);
    expect(dist[0]).toBeGreaterThan(20);
    expect(spiderPositions(50, { x: 0, y: 0 }).every((p) => Math.hypot(p.x, p.y) <= 90.0001)).toBe(true);
  });
});

describe("performance with 300 points", () => {
  it("clusters 300 random points at every zoom level quickly", () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const many: ClusterPoint[] = Array.from({ length: 300 }, (_, i) => ({
      id: i + 1,
      type: (["earthquake", "flood", "wildfire", "storm"] as const)[i % 4],
      severity: (["high", "medium", "low"] as const)[i % 3],
      lat: -40 + rnd() * 80,
      lng: -180 + rnd() * 360,
    }));
    const t0 = performance.now();
    const index = buildClusterIndex(many);
    let total = 0;
    for (let z = 2; z <= 10; z++) total += getClustersInView(index, WORLD, z).length;
    const ms = performance.now() - t0;
    expect(total).toBeGreaterThan(0);
    expect(ms).toBeLessThan(200);
    const atWorld = getClustersInView(index, WORLD, 2);
    expect(atWorld.reduce((n, f) => n + (f.kind === "cluster" ? f.count : 1), 0)).toBe(300);
  });
});
