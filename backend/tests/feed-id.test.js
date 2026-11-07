/**
 * Feed ids must not collide: the old 32-bit base-31 hash gave the same id to
 * USGS ids that differ only in their last two characters.
 */
import { describe, it, expect } from "vitest";
import { feedId } from "../src/utils/feedId.js";
import { normalizeUsgsEarthquakes } from "../src/services/usgs.service.js";

describe("feedId", () => {
  it("separates the USGS id pairs that collided in the live feed", () => {
    const pairs = [
      ["us7000twfu", "us7000twh7"],
      ["us7000tw43", "us7000tupq"],
      ["us7000tw3k", "us7000tuqk"],
      ["us7000tuv8", "us7000tutv"],
      ["us7000tuv5", "us7000tuts"],
    ];
    for (const [a, b] of pairs) expect(feedId("usgs", a)).not.toBe(feedId("usgs", b));
  });

  it("has no collision over every id with a shared prefix and three free characters", () => {
    const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
    const seen = new Set();
    for (const a of chars) for (const b of chars) for (const c of chars) seen.add(feedId("usgs", `us7000t${a}${b}${c}`));
    expect(seen.size).toBe(chars.length ** 3);
  });

  it("is a stable, safe integer, different per source", () => {
    const id = feedId("usgs", "us7000twfu");
    expect(Number.isSafeInteger(id)).toBe(true);
    expect(id).toBeGreaterThan(0);
    expect(feedId("usgs", "us7000twfu")).toBe(id);
    expect(feedId("nasa", "us7000twfu")).not.toBe(id);
  });

  it("gives every item of a USGS feed its own id", () => {
    const features = ["us7000twfu", "us7000twh7", "us7000tuv5", "us7000tuts"].map((id, i) => ({
      id,
      properties: { mag: 4.5 + i / 10, place: `${10 + i} km N of Exampleville`, time: Date.now() - i * 60_000, updated: Date.now() },
      geometry: { coordinates: [10, 10, 10] },
    }));
    const items = normalizeUsgsEarthquakes(features);
    expect(new Set(items.map((x) => x.id)).size).toBe(features.length);
  });
});
