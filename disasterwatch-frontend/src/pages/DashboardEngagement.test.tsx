// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// Leaflet does not run in jsdom: the map is replaced by a stub that records the props it gets.
const mapProps: Array<{ disasters: Array<{ id: number }>; pulseIds?: ReadonlySet<number> }> = [];
vi.mock("../components/MapView", () => ({
  default: (props: (typeof mapProps)[number]) => {
    mapProps.push(props);
    return <div data-testid="map" />;
  },
}));

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const item = (id: number, type: string, severity: string, title: string, h: number, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  severity,
  location: title,
  meta: "",
  description: title,
  timeMinutesAgo: h * 60,
  lat: 10 + id,
  lng: 20 + id,
  country: null,
  details: { cleanTitle: title, occurredAt: hoursAgo(h), ...extra },
});

const BUSY = [
  item(1, "wildfire", "low", "Wildfire in Australia", 1),
  item(2, "storm", "high", "Hurricane Simon", 7, { peakKts: 135 }),
  item(3, "earthquake", "medium", "M 5.2 - 107 km NNE of Hihifo, Tonga", 20, { magnitude: 5.2, magnitudeLabel: "5.2", place: "107 km NNE of Hihifo, Tonga" }),
];
const QUIET = [item(1, "wildfire", "low", "Wildfire in Australia", 1), item(4, "flood", "low", "Flood in Nepal", 30)];

function feedPayload(items: ReturnType<typeof item>[]) {
  const bySeverity = { high: 0, medium: 0, low: 0, unrated: 0 } as Record<string, number>;
  for (const d of items) bySeverity[d.severity] += 1;
  return { items, count: items.length, counts: { total: items.length, bySeverity, byType: {} }, stale: false, sources: { nasa: "ok", usgs: "ok" }, updatedAt: hoursAgo(0.1) };
}

function stubApi(feed: ReturnType<typeof item>[] | "offline") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.includes("/api/disasters")) return feed === "offline" ? json({ message: "down" }, 503) : json(feedPayload(feed));
      if (url.includes("/users/session")) return json({ user: null });
      if (url.includes("/health")) return json({ ok: true });
      return json({ message: "no" }, 404);
    })
  );
}

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
  );
}

// The feed cache is module-level: a fresh module graph per test keeps tests independent.
async function renderDashboard() {
  vi.resetModules();
  const { default: App } = await import("../App");
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mapProps.length = 0;
  stubReducedMotion(false);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("skip link", () => {
  it("is the first Tab stop and moves focus to the first feed row", async () => {
    stubApi(BUSY);
    const user = userEvent.setup();
    await renderDashboard();
    // the feed row and its "Today's events" card both open the event
    await screen.findAllByRole("button", { name: /Hurricane Simon/ });

    await user.tab();
    const skip = screen.getByRole("link", { name: "Skip to feed" });
    expect(document.activeElement).toBe(skip);

    await user.keyboard("{Enter}");
    const firstRow = document.querySelector("#disaster-feed .disaster-row");
    expect(firstRow).not.toBeNull();
    expect(document.activeElement).toBe(firstRow);
  });

  it("falls back to the feed heading while the feed is offline", async () => {
    stubApi("offline");
    const user = userEvent.setup();
    await renderDashboard();
    await screen.findByText(/Live sources are not responding right now\. Nothing on this page is simulated/);

    await user.tab();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Disaster feed" }));
  });
});

describe("headline strip", () => {
  it("summarises significant events from the real feed, with the alerts call-to-action", async () => {
    stubApi(BUSY);
    await renderDashboard();
    expect(
      await screen.findByText("2 significant events worldwide in the past 7 days. The most serious: Hurricane Simon, a Category 4 at its peak — 7 hours ago.")
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Get alerts for your area" }).getAttribute("href")).toBe("/alerts");
  });

  it("states the quiet case plainly when nothing is significant", async () => {
    stubApi(QUIET);
    await renderDashboard();
    expect(await screen.findByText("No major events in the past 7 days — tracking 2 events worldwide.")).toBeTruthy();
    expect(screen.getByText("None in the past 7 days (high or medium severity)")).toBeTruthy();
  });
});

describe("map liveness", () => {
  it("passes pulsing markers to the map: the newest plus recent significant events", async () => {
    stubApi(BUSY);
    await renderDashboard();
    await waitFor(() => expect(mapProps.at(-1)?.disasters.length).toBe(3));
    expect([...(mapProps.at(-1)?.pulseIds ?? [])].sort()).toEqual([1, 2, 3]);
    expect(screen.getByText(/Pulsing: newest event/)).toBeTruthy();
    expect(screen.getByText(/Updated 6 minutes ago/)).toBeTruthy();
  });

  it("pulses nothing when the visitor prefers reduced motion", async () => {
    stubReducedMotion(true);
    stubApi(BUSY);
    await renderDashboard();
    await waitFor(() => expect(mapProps.at(-1)?.disasters.length).toBe(3));
    expect(mapProps.at(-1)?.pulseIds?.size).toBe(0);
    expect(screen.queryByText(/Pulsing: newest event/)).toBeNull();
  });
});

describe("selected event on the map", () => {
  // 16 quakes: the map draws the 15 strongest, so the weakest one is left out until selected
  const quakes = Array.from({ length: 16 }, (_, i) =>
    item(100 + i, "earthquake", "low", `M ${(5.9 - i * 0.1).toFixed(1)} - test quake ${i}`, 2 + i, { magnitude: 5.9 - i * 0.1, magnitudeLabel: (5.9 - i * 0.1).toFixed(1) })
  );
  const weakest = 115;

  it("adds an event the marker caps leave out once it is selected, so the map can fly to it", async () => {
    stubApi(quakes);
    const user = userEvent.setup();
    await renderDashboard();
    await waitFor(() => expect(mapProps.length).toBeGreaterThan(0));
    expect(mapProps.at(-1)!.disasters.some((d) => d.id === weakest)).toBe(false);

    await user.click(await screen.findByRole("button", { name: /test quake 15/ }));
    await waitFor(() => expect(mapProps.at(-1)!.disasters.some((d) => d.id === weakest)).toBe(true));
  });

  it("opens an event from a Today's events card", async () => {
    stubApi(BUSY);
    const user = userEvent.setup();
    await renderDashboard();
    await user.click(await screen.findByRole("button", { name: /Hurricane Simon.*Open on the map/ }));
    expect(await screen.findByRole("dialog", { name: "Hurricane Simon" })).toBeTruthy();
  });
});
