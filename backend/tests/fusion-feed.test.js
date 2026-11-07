/**
 * Dashboard feed scores (src/services/fusion/feed.js): every feed item gets
 * { confidence, priority, confirmations } from the same fusion as API v1, or
 * null when the fusion fails; ids map from the feed's to the API's.
 */
import { describe, it, expect, vi } from "vitest";
import { annotateFeed, v1IdOf } from "../src/services/fusion/feed.js";

const feed = {
  items: [
    { id: 1, type: "earthquake", details: { eventId: "usgs:us1" } },
    { id: 2, type: "wildfire", details: { eventId: "nasa:EONET_9" } },
    { id: 3, type: "flood", details: {} },
  ],
  count: 3,
};
const svc = { snapshot: async () => ({ served: { nasa: [], usgs: [] } }) };
const events = [{ id: "usgs:us1" }, { id: "eonet:EONET_9" }];
const fusion = {
  fuse: vi.fn(async () => ({
    matches: new Map([
      ["usgs:us1", { sources: [{ role: "primary" }, { role: "confirming" }, { role: "listed" }] }],
      ["eonet:EONET_9", { sources: [{ role: "primary" }] }],
    ]),
    scores: new Map([
      ["usgs:us1", { confidence: { score: 80 }, priority: { score: 66 } }],
      ["eonet:EONET_9", { confidence: { score: 20 }, priority: { score: 35 } }],
    ]),
    status: { emsc: "ok", nhc: "ok", firms: "off" },
  })),
};

describe("annotateFeed", () => {
  it("maps feed ids to API ids", () => {
    expect(v1IdOf({ details: { eventId: "usgs:us1" } })).toBe("usgs:us1");
    expect(v1IdOf({ details: { eventId: "nasa:EONET_9" } })).toBe("eonet:EONET_9");
    expect(v1IdOf({ details: {} })).toBeNull();
    expect(v1IdOf(null)).toBeNull();
  });

  it("adds compact scores and the scoring status", async () => {
    const out = await annotateFeed(feed, { feedService: svc, fusion, eventsFor: () => events });
    expect(out.items.map((i) => i.scores)).toEqual([{ confidence: 80, priority: 66, confirmations: 1 }, { confidence: 20, priority: 35, confirmations: 0 }, null]);
    expect(out.scoring).toEqual({ version: 1, status: { emsc: "ok", nhc: "ok", firms: "off" } });
    expect(out.count).toBe(3);
    expect(feed.items[0].scores).toBeUndefined(); // the input is not changed
  });

  it("a failing fusion leaves the feed intact with null scores", async () => {
    const error = vi.fn();
    const out = await annotateFeed(feed, { feedService: svc, fusion: { fuse: async () => { throw new Error("x"); } }, eventsFor: () => events, log: { error } });
    expect(out.items.every((i) => i.scores === null)).toBe(true);
    expect(out.scoring.status).toEqual({ emsc: "error", nhc: "error", firms: "error" });
    expect(error).toHaveBeenCalled();
  });
});
