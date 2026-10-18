// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Leaflet does not run in jsdom.
vi.mock("../components/MapView", () => ({ default: () => <div data-testid="map" /> }));

const item = (id: number) => ({
  id,
  type: "wildfire",
  severity: "low",
  location: `Wildfire ${id}`,
  meta: "",
  description: `Wildfire ${id}`,
  timeMinutesAgo: 60,
  lat: 10,
  lng: 20,
  country: null,
  details: { cleanTitle: `Wildfire ${id}`, occurredAt: new Date(Date.now() - 3_600_000).toISOString() },
});

function stubApi(count: number) {
  const calls: string[] = [];
  const items = Array.from({ length: count }, (_, i) => item(i + 1));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.includes("/api/disasters"))
        return json({ items, count, counts: { total: count, bySeverity: { high: 0, medium: 0, low: count, unrated: 0 }, byType: {} }, stale: false, sources: { nasa: "ok", usgs: "ok" }, updatedAt: new Date().toISOString() });
      if (url.includes("/users/me")) return json({ message: "signed out" }, 401);
      if (url.includes("/health")) return json({ ok: true });
      return json({ message: "no" }, 404);
    })
  );
  return calls;
}

async function renderApp() {
  vi.resetModules();
  const { default: App } = await import("../App");
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("feed pager", () => {
  it("is not shown when the feed fits on one page", async () => {
    stubApi(40);
    await renderApp();
    await screen.findAllByText("Wildfire 40");
    expect(screen.queryByRole("button", { name: /Prev/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Next/ })).toBeNull();
    expect(screen.queryByText(/^Page/)).toBeNull();
  });

  it("is shown when there is more than one page", async () => {
    stubApi(51);
    await renderApp();
    await screen.findAllByText("Wildfire 1");
    expect((screen.getByRole("button", { name: /Prev/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Next/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("session check", () => {
  const meCalls = (calls: string[]) => calls.filter((u) => u.includes("/users/me")).length;

  it("asks once in a fresh browser and remembers the signed-out answer", async () => {
    const calls = stubApi(1);
    await renderApp();
    await screen.findAllByText("Wildfire 1");
    await waitFor(() => expect(localStorage.getItem("dw.session")).toBe("out"));
    expect(meCalls(calls)).toBe(1);
  });

  it("does not ask (no expected-401) when this browser was signed out", async () => {
    localStorage.setItem("dw.session", "out");
    const calls = stubApi(1);
    await renderApp();
    await screen.findAllByText("Wildfire 1");
    expect(meCalls(calls)).toBe(0);
    expect(screen.getAllByRole("link", { name: /sign in/i }).length).toBeGreaterThan(0);
  });

  it("asks when this browser had a session, and drops the hint on a 401", async () => {
    localStorage.setItem("dw.session", "in");
    const calls = stubApi(1);
    await renderApp();
    await screen.findAllByText("Wildfire 1");
    await waitFor(() => expect(localStorage.getItem("dw.session")).toBe("out"));
    expect(meCalls(calls)).toBe(1);
  });
});
