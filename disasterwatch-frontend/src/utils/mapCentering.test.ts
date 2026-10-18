import { describe, it, expect } from "vitest";
import { visibleCenterOffset, visibleRect } from "./mapCentering";

const VIEWPORT = { width: 1440, height: 900 };

describe("visibleRect", () => {
  it("is the container itself when nothing covers it", () => {
    const c = { left: 40, top: 200, right: 820, bottom: 800 };
    expect(visibleRect(c, VIEWPORT, [])).toEqual(c);
  });

  it("clips to the viewport when the map is partly scrolled out", () => {
    expect(visibleRect({ left: 40, top: 500, right: 820, bottom: 1100 }, VIEWPORT, [])).toEqual({ left: 40, top: 500, right: 820, bottom: 900 });
  });

  it("cuts a sticky header from the top and a bottom sheet from the bottom (phone)", () => {
    const phone = { width: 390, height: 844 };
    const map = { left: 16, top: 40, right: 374, bottom: 420 };
    const header = { left: 0, top: 0, right: 390, bottom: 100 };
    const sheet = { left: 0, top: 422, right: 390, bottom: 844 };
    expect(visibleRect(map, phone, [header, sheet])).toEqual({ left: 16, top: 100, right: 374, bottom: 420 });
    const sheetHigher = { ...sheet, top: 300 };
    expect(visibleRect(map, phone, [header, sheetHigher])).toEqual({ left: 16, top: 100, right: 374, bottom: 300 });
  });

  it("cuts a side drawer from the right", () => {
    const map = { left: 24, top: 100, right: 1000, bottom: 700 };
    const drawer = { left: 644, top: 96, right: 1024, bottom: 752 };
    expect(visibleRect(map, { width: 1024, height: 768 }, [drawer])).toEqual({ left: 24, top: 100, right: 644, bottom: 700 });
  });

  it("ignores obstructions that do not overlap and empty ones", () => {
    const map = { left: 24, top: 100, right: 800, bottom: 700 };
    const drawer = { left: 1060, top: 96, right: 1440, bottom: 884 };
    expect(visibleRect(map, VIEWPORT, [drawer, { left: 0, top: 0, right: 0, bottom: 0 }])).toEqual(map);
  });

  it("is null when the map is fully hidden", () => {
    expect(visibleRect({ left: 0, top: 1000, right: 400, bottom: 1300 }, VIEWPORT, [])).toBeNull();
    expect(visibleRect({ left: 0, top: 0, right: 0, bottom: 0 }, VIEWPORT, [])).toBeNull();
    const map = { left: 0, top: 100, right: 400, bottom: 400 };
    expect(visibleRect(map, VIEWPORT, [{ left: 0, top: 0, right: 1440, bottom: 900 }])).toBeNull();
  });
});

describe("visibleCenterOffset", () => {
  it("is zero for a fully visible map", () => {
    expect(visibleCenterOffset({ left: 40, top: 200, right: 820, bottom: 800 }, VIEWPORT, [])).toEqual({ x: 0, y: 0 });
  });

  it("moves the target up when the lower part of the map is under a bottom sheet", () => {
    const map = { left: 16, top: 100, right: 374, bottom: 500 };
    const sheet = { left: 0, top: 400, right: 390, bottom: 844 };
    // visible 100..400 -> centre 250; container centre 300
    expect(visibleCenterOffset(map, { width: 390, height: 844 }, [sheet])).toEqual({ x: 0, y: -50 });
  });

  it("moves the target left when a drawer covers the right side", () => {
    const map = { left: 0, top: 0, right: 1000, bottom: 600 };
    const drawer = { left: 600, top: 0, right: 1024, bottom: 768 };
    expect(visibleCenterOffset(map, { width: 1024, height: 768 }, [drawer])).toEqual({ x: -200, y: 0 });
  });

  it("is zero when nothing is visible", () => {
    expect(visibleCenterOffset({ left: 0, top: 2000, right: 400, bottom: 2400 }, VIEWPORT, [])).toEqual({ x: 0, y: 0 });
  });
});
