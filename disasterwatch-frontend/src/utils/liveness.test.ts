import { describe, it, expect } from "vitest";
import { pulseIds, type PulseCandidate } from "./liveness";

const NOW = new Date("2026-10-16T13:00:00Z");
const ev = (id: number, severity: PulseCandidate["severity"], hoursAgo: number): PulseCandidate => ({
  id,
  severity,
  location: `event ${id}`,
  details: { occurredAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString() },
});

describe("pulseIds", () => {
  it("pulses the newest marker plus up to three significant events from the last 24 hours", () => {
    const markers = [ev(1, "low", 1), ev(2, "high", 7), ev(3, "high", 10), ev(4, "medium", 3), ev(5, "medium", 20), ev(6, "high", 30), ev(7, "low", 2)];
    // newest: 1; significant in 24 h, high first then newest: 2, 3, 4 (5 is the fourth, 6 is too old)
    expect([...pulseIds(markers, { now: NOW })].sort()).toEqual([1, 2, 3, 4]);
  });

  it("pulses only the newest marker when nothing significant happened recently", () => {
    expect([...pulseIds([ev(1, "low", 5), ev(2, "low", 1), ev(3, "high", 48)], { now: NOW })]).toEqual([2]);
  });

  it("pulses nothing with prefers-reduced-motion, and nothing on an empty map", () => {
    const markers = [ev(1, "high", 1), ev(2, "medium", 2)];
    expect(pulseIds(markers, { now: NOW, reducedMotion: true }).size).toBe(0);
    expect(pulseIds([], { now: NOW }).size).toBe(0);
  });
});
