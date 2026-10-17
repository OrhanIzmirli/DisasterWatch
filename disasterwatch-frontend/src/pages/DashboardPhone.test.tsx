// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// Leaflet does not run in jsdom: the map is a stub.
vi.mock("../components/MapView", () => ({ default: () => <div data-testid="map" /> }));

const item = (id: number, type: string, severity: string, title: string) => ({
  id,
  type,
  severity,
  location: title,
  meta: "",
  description: title,
  timeMinutesAgo: 60,
  lat: 10 + id,
  lng: 20 + id,
  country: null,
  details: { cleanTitle: title, occurredAt: new Date(Date.now() - 3_600_000).toISOString() },
});
const FEED = [item(1, "storm", "high", "Hurricane Simon"), item(2, "flood", "low", "Flood in Nepal")];

function stubApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.includes("/api/disasters"))
        return json({ items: FEED, count: 2, counts: { total: 2, bySeverity: { high: 1, medium: 0, low: 1, unrated: 0 }, byType: {} }, stale: false, sources: { nasa: "ok", usgs: "ok" }, updatedAt: new Date().toISOString() });
      if (url.includes("/users/me")) return json({ message: "signed out" }, 401);
      if (url.includes("/health")) return json({ ok: true });
      return json({ message: "no" }, 404);
    })
  );
}

/** A phone (<= 480px) or a desktop viewport, as seen by matchMedia. */
function stubViewport(phone: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: phone && query === "(max-width: 480px)", media: query, addEventListener: () => {}, removeEventListener: () => {} }))
  );
}

// The feed cache is module-level: a fresh module graph per test keeps tests independent.
async function renderApp(path = "/") {
  vi.resetModules();
  const { default: App } = await import("../App");
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

const feedPanel = () => document.getElementById("disaster-feed") as HTMLElement;

beforeEach(() => {
  sessionStorage.clear();
  stubApi();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("phone layout: Map | Feed toggle", () => {
  it("shows the map first, one view at a time, and switches with the keyboard", async () => {
    stubViewport(true);
    const user = userEvent.setup();
    await renderApp();
    const toggle = screen.getByRole("group", { name: "Show map or feed" });
    const mapBtn = within(toggle).getByRole("button", { name: "Map" });
    const feedBtn = within(toggle).getByRole("button", { name: "Feed" });
    expect(mapBtn.getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByTestId("map")).toBeTruthy();
    expect(feedPanel().hidden).toBe(true);

    feedBtn.focus();
    await user.keyboard("{Enter}");
    expect(feedBtn.getAttribute("aria-pressed")).toBe("true");
    expect(feedPanel().hidden).toBe(false);
    // the hidden view's map is not mounted (Leaflet and tiles are not loaded)
    expect(screen.queryByTestId("map")).toBeNull();
    expect(sessionStorage.getItem("dw.dashboardView")).toBe("feed");
  });

  it("remembers the choice for the session", async () => {
    stubViewport(true);
    sessionStorage.setItem("dw.dashboardView", "feed");
    await renderApp();
    expect(within(screen.getByRole("group", { name: "Show map or feed" })).getByRole("button", { name: "Feed" }).getAttribute("aria-pressed")).toBe("true");
    expect(feedPanel().hidden).toBe(false);
    expect(screen.queryByTestId("map")).toBeNull();
  });

  it("the skip link switches to the Feed and focuses its first row", async () => {
    stubViewport(true);
    const user = userEvent.setup();
    await renderApp();
    await screen.findByTestId("map");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Skip to feed" }));
    await user.keyboard("{Enter}");
    expect(feedPanel().hidden).toBe(false);
    expect(document.activeElement).toBe(feedPanel().querySelector(".disaster-row"));
  });

  it("is not shown on desktop, where map and feed stay side by side", async () => {
    stubViewport(false);
    await renderApp();
    expect(await screen.findByTestId("map")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Show map or feed" })).toBeNull();
    expect(feedPanel().hidden).toBe(false);
    expect(document.querySelector("main")?.className).toBe("app-main");
  });

  it("an event deep link on a phone opens the Map view", async () => {
    stubViewport(true);
    sessionStorage.setItem("dw.dashboardView", "feed");
    await renderApp("/?event=1");
    expect(await screen.findByRole("dialog", { name: "Hurricane Simon" })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Show map or feed" })).getByRole("button", { name: "Map" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("main")?.className).toContain("app-main-sheet-open");
  });
});
