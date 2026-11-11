/**
 * Callers that ask for EONET while a download runs share it (a woken service starts the
 * ingestion, the feed and the storm list at once), and each gets its own copy.
 */
import { describe, it, expect, vi } from "vitest";
import { createEonetFetcher } from "../src/services/nasa.service.js";

describe("EONET download shared by concurrent callers", () => {
  it("one download for callers that ask while it runs, a new one afterwards", async () => {
    let release;
    const download = vi.fn(() => new Promise((r) => (release = () => r([{ id: "EONET_1", geometry: [] }]))));
    const fetchEvents = createEonetFetcher({ download });
    const a = fetchEvents();
    const b = fetchEvents();
    const c = fetchEvents();
    release();
    const [ea, eb, ec] = await Promise.all([a, b, c]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(ea).toEqual([{ id: "EONET_1", geometry: [] }]);

    // copies: the GDACS rating of one caller must not show up in another's events
    ea[0].gdacsPlace = { lat: 1, lng: 2 };
    expect(eb[0]).not.toHaveProperty("gdacsPlace");
    expect(ec).not.toBe(eb);

    const later = fetchEvents();
    release();
    await later;
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("a failure reaches every waiting caller and does not stick", async () => {
    const download = vi.fn().mockRejectedValueOnce(new Error("This operation was aborted")).mockResolvedValue([]);
    const fetchEvents = createEonetFetcher({ download });
    const results = await Promise.allSettled([fetchEvents(), fetchEvents()]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(download).toHaveBeenCalledTimes(1);
    await expect(fetchEvents()).resolves.toEqual([]);
    expect(download).toHaveBeenCalledTimes(2);
  });
});
