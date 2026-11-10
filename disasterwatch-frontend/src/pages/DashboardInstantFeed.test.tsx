// @vitest-environment jsdom
/**
 * The dashboard shows the last good data at once (this browser's saved copy, or the
 * published snapshot when the live request is slow or fails), labels it with its real
 * age and never as live, and replaces it with the live answer when that arrives.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { feedFromResponse, isNewer, readSavedFeed, saveFeed, SAVED_FEED_KEY, SNAPSHOT_DELAY_MS } from "../services/feedSnapshot";

// Leaflet does not run in jsdom.
vi.mock("../components/MapView", () => ({ default: () => <div data-testid="map" /> }));

const HOUR = 3_600_000;
const item = (id: number, name: string) => ({
  id,
  type: "wildfire",
  severity: "low",
  location: name,
  meta: "",
  description: name,
  timeMinutesAgo: 60,
  lat: 10,
  lng: 20,
  country: null,
  details: { cleanTitle: name, occurredAt: new Date(Date.now() - HOUR).toISOString() },
});
const feed = (name: string, ageMs: number, extra: Record<string, unknown> = {}) => ({
  items: [item(1, name)],
  count: 1,
  counts: { total: 1, bySeverity: { high: 0, medium: 0, low: 1, unrated: 0 }, byType: {} },
  stale: false,
  partial: false,
  sources: { nasa: "ok", usgs: "ok" },
  updatedAt: new Date(Date.now() - ageMs).toISOString(),
  ...extra,
});

type Answer = { status: number; body: unknown } | "never";
/** fetch stub: the live feed answers per `live` (or when `release` is called), the snapshot per `snapshot`. */
function stubApi({ live, snapshot = { status: 404, body: "<!doctype html>" } }: { live: Answer | "manual"; snapshot?: Answer }) {
  const calls: string[] = [];
  let release: (a: { status: number; body: unknown }) => void = () => {};
  const respond = (a: { status: number; body: unknown }) =>
    new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": typeof a.body === "string" ? "text/html" : "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/disasters")) {
        if (live === "manual") return new Promise<Response>((r) => (release = (a) => r(respond(a))));
        if (live === "never") return new Promise<Response>(() => {});
        return respond(live);
      }
      if (url.includes("/snapshot/feed.json")) {
        if (snapshot === "never") return new Promise<Response>(() => {});
        return respond(snapshot);
      }
      if (url.includes("/users/session")) return respond({ status: 200, body: { user: null } });
      if (url.includes("/health")) return respond({ status: 200, body: { ok: true } });
      return respond({ status: 404, body: { message: "no" } });
    })
  );
  return { calls, release: (a: { status: number; body: unknown }) => release(a) };
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

const updated = () => document.querySelector(".dashboard-updated")?.textContent ?? "";
const badges = () => [...document.querySelectorAll(".badge-live, .badge-stale")].map((b) => b.textContent);

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a returning visitor", () => {
  it("sees the saved copy at once, labelled with its age, then the live answer replaces it", async () => {
    localStorage.setItem(SAVED_FEED_KEY, JSON.stringify(feed("Saved fire", 2 * HOUR)));
    const api = stubApi({ live: "manual" });
    await renderApp();

    expect(await screen.findAllByText("Saved fire")).not.toHaveLength(0);
    expect(updated()).toMatch(/Last updated: 2 hours ago \(saved copy, connecting to live data…\)/);
    expect(badges()).toEqual(["SAVED"]);
    expect(document.querySelector(".feed-skeleton")).toBeNull();

    api.release({ status: 200, body: feed("Live fire", 60_000) });
    expect(await screen.findAllByText("Live fire")).not.toHaveLength(0);
    expect(screen.queryByText("Saved fire")).toBeNull();
    expect(updated()).toMatch(/live data\)$/);
    expect(badges()).toEqual(["LIVE"]);
    // the new answer is kept for the next visit
    expect(JSON.parse(localStorage.getItem(SAVED_FEED_KEY) ?? "{}").items[0].location).toBe("Live fire");
  });

  it("ignores a saved copy older than two days and starts with the skeleton", async () => {
    localStorage.setItem(SAVED_FEED_KEY, JSON.stringify(feed("Old fire", 3 * 24 * HOUR)));
    stubApi({ live: "never" });
    await renderApp();
    await waitFor(() => expect(document.querySelector(".feed-skeleton")).not.toBeNull());
    expect(screen.queryByText("Old fire")).toBeNull();
  });
});

describe("a first visit while the backend wakes up", () => {
  it("shows the published snapshot when the live answer is slow, then the live one", async () => {
    const api = stubApi({ live: "manual", snapshot: { status: 200, body: JSON.stringify(feed("Snapshot fire", 3 * HOUR)) } });
    await renderApp();
    await waitFor(() => expect(document.querySelector(".feed-skeleton")).not.toBeNull());
    expect(await screen.findAllByText("Snapshot fire", undefined, { timeout: SNAPSHOT_DELAY_MS + 3000 })).not.toHaveLength(0);
    expect(updated()).toMatch(/3 hours ago \(saved copy/);
    expect(badges()).toEqual(["SAVED"]);
    expect(screen.getByText(/Showing the last update, from 3 hours ago/)).toBeTruthy();

    api.release({ status: 200, body: feed("Live fire", 60_000) });
    expect(await screen.findAllByText("Live fire")).not.toHaveLength(0);
    expect(badges()).toEqual(["LIVE"]);
  });

  it("falls back to the snapshot, marked stale, when the live request fails", async () => {
    stubApi({ live: { status: 503, body: { message: "Live disaster sources are not responding" } }, snapshot: { status: 200, body: JSON.stringify(feed("Snapshot fire", 3 * HOUR)) } });
    await renderApp();
    expect(await screen.findAllByText("Snapshot fire")).not.toHaveLength(0);
    expect(badges()).toEqual(["STALE"]);
    expect(screen.getByText(/Live sources could not be reached; showing the last successful update \(3 hours ago\)/)).toBeTruthy();
  });

  it("shows the error state when there is no usable snapshot either (the site's HTML fallback)", async () => {
    stubApi({ live: { status: 503, body: { message: "down" } } });
    await renderApp();
    expect(await screen.findByText(/Live sources are not responding right now/)).toBeTruthy();
  });

  it("does not ask for the snapshot when the live answer is quick", async () => {
    const api = stubApi({ live: { status: 200, body: feed("Live fire", 60_000) } });
    await renderApp();
    await screen.findAllByText("Live fire");
    await new Promise((r) => setTimeout(r, SNAPSHOT_DELAY_MS + 200));
    expect(api.calls.some((u) => u.includes("/snapshot/"))).toBe(false);
    expect(badges()).toEqual(["LIVE"]);
  });
});

describe("what is kept and used", () => {
  it("keeps only complete, current answers", () => {
    saveFeed(feed("Stale fire", 60_000, { stale: true }));
    saveFeed(feed("Partial fire", 60_000, { sources: { nasa: "ok", usgs: "error" } }));
    saveFeed(feed("Empty", 60_000, { items: [] }));
    expect(localStorage.getItem(SAVED_FEED_KEY)).toBeNull();
    saveFeed(feed("Good fire", 60_000));
    expect(readSavedFeed()?.items).toHaveLength(1);
    expect(readSavedFeed()?.origin).toBe("saved");
    expect(readSavedFeed()?.fetchedAt).toBe(0); // never counts as fresh: the live request still runs
  });

  it("survives broken or blocked storage", () => {
    localStorage.setItem(SAVED_FEED_KEY, "{not json");
    expect(readSavedFeed()).toBeNull();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => saveFeed(feed("Good fire", 60_000))).not.toThrow();
    spy.mockRestore();
  });

  it("compares copies by the backend's data time", () => {
    const older = feedFromResponse(feed("a", 3 * HOUR), "saved")!;
    const newer = feedFromResponse(feed("b", HOUR), "snapshot")!;
    expect(isNewer(newer, older)).toBe(true);
    expect(isNewer(older, newer)).toBe(false);
    expect(isNewer(older, null)).toBe(true);
    expect(feedFromResponse({ message: "no" }, "live")).toBeNull();
  });
});
