import { describe, it, expect } from "vitest";
import { strongestEarthquakes } from "./mapEarthquakes";

const quake = (id: string, magnitude: number | null, timeMinutesAgo: number) => ({ id, timeMinutesAgo, details: { magnitude } });

describe("strongestEarthquakes", () => {
  it("keeps the strongest within the cap, not the newest", () => {
    const quakes = [quake("new-small", 4.6, 5), quake("old-big", 7.1, 6000), quake("mid", 5.4, 300), quake("newer-small", 4.7, 1)];
    expect(strongestEarthquakes(quakes, 2).map((q) => q.id)).toEqual(["old-big", "mid"]);
  });

  it("puts the newer quake first on equal magnitude and a missing magnitude last", () => {
    const quakes = [quake("none", null, 0), quake("older", 5.0, 900), quake("newer", 5.0, 30)];
    expect(strongestEarthquakes(quakes, 3).map((q) => q.id)).toEqual(["newer", "older", "none"]);
  });

  it("does not change the input and handles a cap larger than the list or zero", () => {
    const quakes = [quake("a", 4.5, 1), quake("b", 6.0, 2)];
    expect(strongestEarthquakes(quakes, 10).map((q) => q.id)).toEqual(["b", "a"]);
    expect(strongestEarthquakes(quakes, 0)).toEqual([]);
    expect(quakes.map((q) => q.id)).toEqual(["a", "b"]);
  });
});
