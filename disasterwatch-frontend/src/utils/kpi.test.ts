import { describe, it, expect } from "vitest";
import { kpiFromCounts, kpiFromItems, readCounts, type FeedCounts } from "./kpi";

// Today's shape: 61 events in the window, 50 on the page.
const counts: FeedCounts = {
  total: 61,
  bySeverity: { high: 5, medium: 6, low: 50, unrated: 0 },
  byType: {
    earthquake: { total: 11, high: 0, medium: 5, low: 6, unrated: 0 },
    wildfire: { total: 38, high: 0, medium: 0, low: 38, unrated: 0 },
    flood: { total: 6, high: 0, medium: 0, low: 6, unrated: 0 },
    storm: { total: 6, high: 5, medium: 1, low: 0, unrated: 0 },
  },
};

describe("Significant events KPI", () => {
  it("counts high + medium over the whole window, not the loaded page", () => {
    expect(kpiFromCounts(counts, "all")).toEqual({ total: 61, significant: 11 });
    // the page-based fallback would say 6 when only one high storm is loaded
    const page = [
      ...Array(5).fill({ type: "earthquake", severity: "medium" as const }),
      { type: "storm", severity: "medium" as const },
      ...Array(44).fill({ type: "wildfire", severity: "low" as const }),
    ];
    expect(kpiFromItems(page, "all")).toEqual({ total: 50, significant: 6 });
  });

  it("follows the type filter and never counts not-rated events", () => {
    expect(kpiFromCounts(counts, "storm")).toEqual({ total: 6, significant: 6 });
    expect(kpiFromCounts(counts, "wildfire")).toEqual({ total: 38, significant: 0 });
    expect(kpiFromCounts({ ...counts, bySeverity: { high: 1, medium: 1, low: 0, unrated: 9 }, total: 11 }, "all").significant).toBe(2);
    expect(kpiFromCounts(counts, "volcano")).toEqual({ total: 0, significant: 0 });
  });

  it("readCounts accepts the API payload and rejects anything else", () => {
    expect(readCounts(counts)).toEqual(counts);
    expect(readCounts({ total: 3, bySeverity: { high: 1 }, byType: { flood: { total: 3 } } })).toEqual({
      total: 3,
      bySeverity: { high: 1, medium: 0, low: 0, unrated: 0 },
      byType: { flood: { total: 3, high: 0, medium: 0, low: 0, unrated: 0 } },
    });
    expect(readCounts(null)).toBeNull();
    expect(readCounts({ items: [] })).toBeNull();
    expect(readCounts("61")).toBeNull();
  });
});
