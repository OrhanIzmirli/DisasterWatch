import { describe, it, expect } from "vitest";
import {
  haversineKm,
  typeMatches,
  severityMatches,
  matchesSubscription,
  shouldNotify,
  buildNotifications,
  MAX_EVENT_AGE_MS,
  SEVERITY_RANK,
} from "../src/match.js";
import { disasterEventSchema } from "../src/contract.js";

const NOW = new Date("2026-10-13T12:00:00.000Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

// Warsaw subscription, created a week ago
const WARSAW = {
  id: 1,
  userId: 10,
  type: "any",
  minSeverity: "medium",
  label: "Warsaw",
  centerLat: 52.2297,
  centerLng: 21.0122,
  radiusKm: 300,
  active: true,
  createdAt: hoursAgo(24 * 7),
};

// Flood ~115 km east of Warsaw, 2 hours ago
const FLOOD_NEAR = {
  v: 1,
  eventId: "manual:1",
  source: "manual",
  type: "flood",
  severity: "high",
  title: "Flood near Siedlce",
  lat: 52.17,
  lng: 22.29,
  occurredAt: hoursAgo(2),
};

describe("haversineKm", () => {
  it("is zero for the same point and symmetric", () => {
    expect(haversineKm(52.23, 21.01, 52.23, 21.01)).toBe(0);
    const a = haversineKm(52.2297, 21.0122, 41.0082, 28.9784);
    const b = haversineKm(41.0082, 28.9784, 52.2297, 21.0122);
    expect(a).toBeCloseTo(b, 6);
  });

  it("Warsaw to Istanbul is about 1386 km", () => {
    expect(haversineKm(52.2297, 21.0122, 41.0082, 28.9784)).toBeCloseTo(1386, -1);
  });
});

describe("typeMatches", () => {
  it("'any' matches every type, otherwise exact match", () => {
    expect(typeMatches("any", "flood")).toBe(true);
    expect(typeMatches("flood", "flood")).toBe(true);
    expect(typeMatches("flood", "wildfire")).toBe(false);
  });
});

describe("severityMatches (low < medium < high)", () => {
  it.each([
    ["low", "low", true],
    ["low", "medium", true],
    ["low", "high", true],
    ["medium", "low", false],
    ["medium", "medium", true],
    ["medium", "high", true],
    ["high", "low", false],
    ["high", "medium", false],
    ["high", "high", true],
  ])("min %s vs event %s -> %s", (min, ev, expected) => {
    expect(severityMatches(min, ev)).toBe(expected);
  });

  it("rejects unknown values", () => {
    expect(severityMatches("extreme", "high")).toBe(false);
    expect(severityMatches("low", "unknown")).toBe(false);
  });
});

describe("matchesSubscription", () => {
  it("matches a nearby event of acceptable severity", () => {
    const r = matchesSubscription(FLOOD_NEAR, WARSAW);
    expect(r.matched).toBe(true);
    expect(r.distanceKm).toBeGreaterThan(80);
    expect(r.distanceKm).toBeLessThan(300);
  });

  it("does not match a different type when the subscription is type-specific", () => {
    expect(matchesSubscription(FLOOD_NEAR, { ...WARSAW, type: "earthquake" }).matched).toBe(false);
    expect(matchesSubscription(FLOOD_NEAR, { ...WARSAW, type: "flood" }).matched).toBe(true);
  });

  it("does not match an event below the minimum severity", () => {
    expect(matchesSubscription({ ...FLOOD_NEAR, severity: "low" }, WARSAW).matched).toBe(false);
  });

  it("does not match a paused subscription", () => {
    expect(matchesSubscription(FLOOD_NEAR, { ...WARSAW, active: false }).matched).toBe(false);
  });

  it("radius boundary: exactly on the limit is inside, one metre beyond is outside", () => {
    const distance = haversineKm(WARSAW.centerLat, WARSAW.centerLng, FLOOD_NEAR.lat, FLOOD_NEAR.lng);
    expect(matchesSubscription(FLOOD_NEAR, { ...WARSAW, radiusKm: distance }).matched).toBe(true);
    expect(matchesSubscription(FLOOD_NEAR, { ...WARSAW, radiusKm: distance - 0.001 }).matched).toBe(false);
  });

  it("does not match a far away event", () => {
    const istanbulQuake = { ...FLOOD_NEAR, type: "earthquake", lat: 41.0, lng: 29.0 };
    expect(matchesSubscription(istanbulQuake, WARSAW).matched).toBe(false);
  });
});

describe("shouldNotify (time rules)", () => {
  it("notifies for a fresh matching event", () => {
    expect(shouldNotify(FLOOD_NEAR, WARSAW, NOW)).toMatchObject({ notify: true, reason: "match" });
  });

  it("does not notify for an event older than 48 hours", () => {
    const old = { ...FLOOD_NEAR, occurredAt: hoursAgo(48.01) };
    expect(shouldNotify(old, WARSAW, NOW)).toMatchObject({ notify: false, reason: "too-old" });

    const justInside = { ...FLOOD_NEAR, occurredAt: new Date(NOW.getTime() - MAX_EVENT_AGE_MS).toISOString() };
    expect(shouldNotify(justInside, WARSAW, NOW).notify).toBe(true);
  });

  it("does not notify when the subscription was created after the event", () => {
    const newSub = { ...WARSAW, createdAt: hoursAgo(1) }; // event was 2 h ago
    expect(shouldNotify(FLOOD_NEAR, newSub, NOW)).toMatchObject({
      notify: false,
      reason: "subscription-newer-than-event",
    });
  });

  it("does not notify when the rule itself does not match", () => {
    expect(shouldNotify(FLOOD_NEAR, { ...WARSAW, active: false }, NOW)).toMatchObject({
      notify: false,
      reason: "no-match",
    });
  });

  it("rejects an unparseable occurredAt", () => {
    expect(shouldNotify({ ...FLOOD_NEAR, occurredAt: "yesterday" }, WARSAW, NOW).notify).toBe(false);
  });
});

describe("buildNotifications", () => {
  it("creates one row per matching user, keeping the closest subscription", () => {
    const farWarsaw = { ...WARSAW, id: 2, label: "Warsaw wide", centerLat: 51.5, centerLng: 20.0, radiusKm: 1000 };
    const otherUser = { ...WARSAW, id: 3, userId: 11, label: "Lublin", centerLat: 51.25, centerLng: 22.57, radiusKm: 200 };
    const paused = { ...WARSAW, id: 4, userId: 12, active: false };

    const rows = buildNotifications(FLOOD_NEAR, [farWarsaw, WARSAW, otherUser, paused], NOW);

    expect(rows.map((r) => r.userId).sort()).toEqual([10, 11]);
    const u10 = rows.find((r) => r.userId === 10);
    expect(u10.subscriptionId).toBe(1); // closer than "Warsaw wide"
    expect(u10.subscriptionLabel).toBe("Warsaw");
    expect(u10).toMatchObject({
      eventId: "manual:1",
      title: "Flood near Siedlce",
      type: "flood",
      severity: "high",
      occurredAt: FLOOD_NEAR.occurredAt,
    });
    expect(u10.distanceKm).toBeCloseTo(88, -1);
  });

  it("returns an empty list when nothing matches", () => {
    expect(buildNotifications({ ...FLOOD_NEAR, severity: "low" }, [WARSAW], NOW)).toEqual([]);
    expect(buildNotifications(FLOOD_NEAR, [], NOW)).toEqual([]);
  });
});

describe("unrated events (contract v1 addition)", () => {
  it("rank below low", () => {
    expect(SEVERITY_RANK.unrated).toBeLessThan(SEVERITY_RANK.low);
  });

  it("a subscription with minSeverity 'low' (= everything) matches an unrated event", () => {
    expect(severityMatches("low", "unrated")).toBe(true);
    expect(matchesSubscription({ ...FLOOD_NEAR, severity: "unrated" }, { ...WARSAW, minSeverity: "low" }).matched).toBe(true);
  });

  it("minSeverity 'medium' and 'high' never match an unrated event", () => {
    expect(severityMatches("medium", "unrated")).toBe(false);
    expect(severityMatches("high", "unrated")).toBe(false);
    expect(matchesSubscription({ ...FLOOD_NEAR, severity: "unrated" }, { ...WARSAW, minSeverity: "medium" }).matched).toBe(false);
    expect(matchesSubscription({ ...FLOOD_NEAR, severity: "unrated" }, { ...WARSAW, minSeverity: "high" }).matched).toBe(false);
  });

  it("'unrated' is never accepted as a subscription minimum", () => {
    expect(severityMatches("unrated", "high")).toBe(false);
    expect(severityMatches("unrated", "unrated")).toBe(false);
  });

  it("the contract accepts severity 'unrated' and still rejects unknown values", () => {
    expect(disasterEventSchema.safeParse({ ...FLOOD_NEAR, severity: "unrated" }).success).toBe(true);
    expect(disasterEventSchema.safeParse({ ...FLOOD_NEAR, severity: "none" }).success).toBe(false);
  });

  it("builds a notification for a 'low' subscription on an unrated event", () => {
    const rows = buildNotifications({ ...FLOOD_NEAR, severity: "unrated" }, [{ ...WARSAW, minSeverity: "low" }], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("unrated");
  });
});
