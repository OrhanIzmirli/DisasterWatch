// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import EventScores from "./EventScores";

// invented event, shaped like GET /api/v1/disasters/{id}
const DETAIL = {
  data: {
    sources: [
      { source: "usgs", role: "primary", sourceEventId: "ex1", url: "https://example.com/usgs/ex1", matchedBy: null, distanceKm: null, timeDeltaSec: null },
      { source: "emsc", role: "confirming", sourceEventId: "e1", url: "https://example.com/emsc/e1", matchedBy: "rule", distanceKm: 5.4, timeDeltaSec: 2, agency: "GFZ", magnitude: 6.1 },
    ],
    ambiguousSources: [],
    confidence: {
      score: 80,
      components: [
        { term: "primary", source: "usgs", points: 60, reason: "USGS, reviewed by a seismologist" },
        { term: "confirmation", source: "emsc", role: "confirming", points: 20, reason: "EMSC: independent confirmation (solution by GFZ)" },
      ],
    },
    priority: {
      score: 66,
      components: [
        { term: "severity", value: 65, weight: 0.45, basis: "magnitude 6.2" },
        { term: "exposure", value: 60, weight: 0.35, basis: "about 1,000,000 people in places within 100 km" },
        { term: "confidence", value: 80, weight: 0.2, basis: "confidence 80" },
      ],
      exposure: { population: 1000000, radiusKm: 100 },
    },
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EventScores", () => {
  it("shows the scores at once, then every term and the confirming sources", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => DETAIL }));
    vi.stubGlobal("fetch", fetchMock);
    render(<EventScores scores={{ confidence: 80, priority: 66, confirmations: 1 }} eventId="usgs:ex1" />);
    expect(screen.getByText("Confirmed by 1 independent source.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/Loading/);

    const conf = await screen.findByRole("table", { name: /Confidence 80/ });
    expect(within(conf).getByText("USGS, reviewed by a seismologist")).toBeTruthy();
    expect(within(conf).getByText("+20")).toBeTruthy();
    const prio = screen.getByRole("table", { name: /Priority 66/ });
    expect(within(prio).getByText("about 1,000,000 people in places within 100 km")).toBeTruthy();
    expect(screen.getByRole("link", { name: "EMSC" }).getAttribute("href")).toBe("https://example.com/emsc/e1");
    expect(screen.getByText(/2 s and 5.4 km apart · solution by GFZ/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/disasters/usgs%3Aex1", expect.anything());
  });

  it("EONET ids are asked for under their API name", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<{ ok: boolean; json: () => Promise<typeof DETAIL> }>>(async () => ({ ok: true, json: async () => DETAIL }));
    vi.stubGlobal("fetch", fetchMock);
    render(<EventScores scores={{ confidence: 40, priority: 20, confirmations: 0 }} eventId="nasa:EONET_5" />);
    await screen.findByRole("table", { name: /Confidence/ });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/disasters/eonet%3AEONET_5");
    expect(screen.getByText("No independent source confirms it yet.")).toBeTruthy();
  });

  it("keeps the scores when the breakdown cannot be loaded (e.g. rate limited)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    render(<EventScores scores={{ confidence: 65, priority: 30, confirmations: 0 }} eventId="usgs:ex1" />);
    expect(await screen.findByText(/cannot be loaded right now; the scores above are current/)).toBeTruthy();
    expect(screen.getByText("65")).toBeTruthy();
  });

  it("says so when the event has no scores", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<EventScores scores={null} eventId="usgs:ex1" />);
    expect(screen.getByText(/No scores for this event right now/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
