import { describe, it, expect } from "vitest";
import { eventLabel, headlineText, leadEvent, saffirSimpsonCategory, type HeadlineEvent } from "./headline";

const NOW = new Date("2026-10-16T13:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const simon: HeadlineEvent = { id: 1, type: "storm", severity: "high", location: "Hurricane Simon", details: { cleanTitle: "Hurricane Simon", occurredAt: hoursAgo(7), peakKts: 135 } };
const trudy: HeadlineEvent = { id: 2, type: "storm", severity: "high", location: "Hurricane Trudy", details: { cleanTitle: "Hurricane Trudy", occurredAt: hoursAgo(7), peakKts: 105 } };
const quake: HeadlineEvent = {
  id: 3,
  type: "earthquake",
  severity: "high",
  location: "M 6.9 - 76 km NE of Ozernovskiy, Russia",
  details: { cleanTitle: "M 6.9 - 76 km NE of Ozernovskiy, Russia", occurredAt: hoursAgo(10), magnitude: 6.9, magnitudeLabel: "6.9", place: "76 km NE of Ozernovskiy, Russia" },
};
const tonga: HeadlineEvent = {
  id: 4,
  type: "earthquake",
  severity: "medium",
  location: "M 5.9 - Fiji region",
  details: { occurredAt: hoursAgo(6), magnitude: 5.9, magnitudeLabel: "5.9", place: "Fiji region" },
};
const fire: HeadlineEvent = { id: 5, type: "wildfire", severity: "low", location: "Wildfire in Australia 1032766", details: { occurredAt: hoursAgo(1) } };

describe("headlineText", () => {
  it("names the count and the latest highest-severity event when there are significant events", () => {
    const text = headlineText({ status: "ready", significant: 4, total: 5, items: [fire, tonga, quake, trudy, simon], now: NOW });
    // high beats medium even when the medium one is newer; same time: the stronger storm wins
    expect(text).toBe("4 significant events worldwide right now. The most serious: Hurricane Simon, a Category 4 at its peak — 7 hours ago.");
  });

  it("uses the singular and the earthquake wording for a single significant quake", () => {
    const text = headlineText({ status: "ready", significant: 1, total: 2, items: [fire, tonga], now: NOW });
    expect(text).toBe("1 significant event worldwide right now. The most serious: M 5.9 earthquake near Fiji region — 6 hours ago.");
  });

  it("says so plainly when nothing is significant (zero case)", () => {
    expect(headlineText({ status: "ready", significant: 0, total: 60, items: [fire], now: NOW })).toBe("No major events right now — tracking 60 events worldwide.");
    expect(headlineText({ status: "ready", significant: 0, total: 1, items: [fire], now: NOW })).toBe("No major events right now — tracking 1 event worldwide.");
  });

  it("has honest wording for an empty feed, a stale feed, loading and offline", () => {
    expect(headlineText({ status: "ready", significant: 0, total: 0, items: [], now: NOW })).toBe("No events reported by NASA EONET or USGS in the last 7 days.");
    expect(headlineText({ status: "ready", significant: 0, total: 3, items: [fire], stale: true, dataAge: "2 hours ago", now: NOW })).toBe(
      "No major events right now — tracking 3 events worldwide. Showing the last update, from 2 hours ago."
    );
    expect(headlineText({ status: "ready", significant: 0, total: 3, items: [fire], stale: true, now: NOW })).toBe(
      "No major events right now — tracking 3 events worldwide. Showing the last update."
    );
    expect(headlineText({ status: "ready", significant: 1, total: 3, items: [simon], stale: true, dataAge: "5 minutes ago", now: NOW })).toBe(
      "1 significant event worldwide right now. The most serious: Hurricane Simon, a Category 4 at its peak — 7 hours ago. Showing the last update, from 5 minutes ago."
    );
    expect(headlineText({ status: "loading", significant: 0, total: 0, items: [] })).toBe("Loading the latest events from NASA and USGS…");
    expect(headlineText({ status: "error", significant: 0, total: 0, items: [] })).toBe("Live sources aren't responding right now.");
  });

  it("never invents a lead event: counts from the backend without matching loaded items give only the count", () => {
    expect(headlineText({ status: "ready", significant: 2, total: 9, items: [fire], now: NOW })).toBe("2 significant events worldwide right now.");
  });
});

describe("leadEvent / eventLabel", () => {
  it("is deterministic: severity, then newest, then stronger, then lowest id", () => {
    expect(leadEvent([trudy, simon, quake], NOW)?.id).toBe(1);
    expect(leadEvent([{ ...simon, id: 9 }, { ...simon, id: 8 }], NOW)?.id).toBe(8);
    expect(leadEvent([fire], NOW)).toBeNull();
  });

  it("uses source text only (clean title, magnitude label, category from the peak wind)", () => {
    expect(eventLabel(quake)).toBe("M 6.9 earthquake near Ozernovskiy, Russia");
    expect(eventLabel(fire)).toBe("Wildfire in Australia");
    expect(eventLabel({ id: 6, type: "flood", severity: "medium", location: "Floods in Bangladesh", details: { cleanTitle: "Floods in Bangladesh" } })).toBe("Floods in Bangladesh");
    expect(eventLabel(trudy)).toBe("Hurricane Trudy, a Category 3 at its peak");
    expect(eventLabel({ ...simon, details: { cleanTitle: "Hurricane Simon" } })).toBe("Hurricane Simon");
    // below hurricane strength: no category, and the knots never reach the headline
    expect(eventLabel({ ...simon, details: { cleanTitle: "Tropical Storm Rachel", peakKts: 55 } })).toBe("Tropical Storm Rachel");
  });

  it("maps peak wind to the Saffir-Simpson category at every edge", () => {
    const cases: [number, number | null][] = [
      [0, null], [63, null], [63.4, null], [63.5, 1], [64, 1], [82, 1],
      [83, 2], [95, 2], [96, 3], [112, 3], [113, 4], [136, 4], [137, 5], [185, 5],
    ];
    for (const [kts, cat] of cases) expect(saffirSimpsonCategory(kts), `${kts} kts`).toBe(cat);
  });
});
