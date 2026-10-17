// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import NewsPanel from "./NewsPanel";
import { locationText } from "../utils/newsText";
import type { NewsItem } from "../services/newsService";

const LOCATED: NewsItem = {
  title: "Floods trigger landslides and damage hundreds of businesses",
  url: "https://daily.example.com/region/floods-landslides",
  domain: "daily.example.com",
  publishedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  provider: "gdacs",
  relatedEvent: { id: 11, type: "flood", severity: "low", location: "Flood in Türkiye", lat: 41, lng: 28.9, country: "Türkiye" },
  location: { countries: ["TR"], regions: ["europe"], source: "event" },
};
const UNLOCATED: NewsItem = {
  title: "Wildfires and floods: a week of natural disasters",
  url: "https://news.example.com/world/week-of-disasters",
  domain: "news.example.com",
  publishedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
  provider: "guardian",
  relatedEvent: null,
  location: null,
};

/** Fake /api/news: honours ?region= the way the backend does (unlocated never match a region). */
function mockNews() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const region = new URL(url, "http://x").searchParams.get("region");
      const items = [LOCATED, UNLOCATED].filter((a) => !region || a.location?.regions.includes(region as never));
      return new Response(JSON.stringify({ items, count: items.length, updatedAt: new Date().toISOString(), stale: false, source: "The Guardian + GDACS", provider: "guardian+gdacs" }), {
        headers: { "content-type": "application/json" },
      });
    })
  );
  return calls;
}

const renderPanel = () =>
  render(
    <MemoryRouter>
      <NewsPanel isOpen onClose={() => {}} />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("news panel region filter", () => {
  it("shows region chips next to the hazard filters, keyboard-operable, with All regions selected", async () => {
    mockNews();
    renderPanel();
    const group = screen.getByRole("group", { name: "Filter news by region" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["All regions", "Africa", "Americas", "Asia", "Europe", "Middle East", "Oceania"]);
    expect(within(group).getByRole("button", { name: "All regions" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("tablist", { name: "Filter news by hazard" })).toBeTruthy();

    // keyboard: focus the Middle East chip and press Enter
    const me = within(group).getByRole("button", { name: "Middle East" });
    me.focus();
    await userEvent.keyboard("{Enter}");
    expect(me.getAttribute("aria-pressed")).toBe("true");
  });

  it("lists unlocated articles under All regions only, and asks the backend for the chosen region", async () => {
    const calls = mockNews();
    renderPanel();
    expect(await screen.findByText(UNLOCATED.title)).toBeTruthy();
    expect(screen.getByText(LOCATED.title)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Europe" }));
    expect(await screen.findByText(/listed only under All regions/)).toBeTruthy();
    expect(await screen.findByText(LOCATED.title)).toBeTruthy();
    expect(screen.queryByText(UNLOCATED.title)).toBeNull();
    expect(calls.at(-1)).toContain("region=europe");

    await userEvent.click(screen.getByRole("button", { name: "Middle East" }));
    expect(await screen.findByText("No disaster coverage located in Middle East in the last 72 hours.")).toBeTruthy();
  });

  it("names the country and region on located cards, nothing on unlocated ones", async () => {
    mockNews();
    renderPanel();
    await screen.findByText(LOCATED.title);
    const cards = screen.getAllByRole("listitem");
    expect(cards[0].textContent).toContain("Location: Türkiye · Europe");
    expect(cards[0].textContent).toContain("via GDACS");
    expect(cards[1].textContent).not.toContain("Location:");
  });
});

describe("locationText", () => {
  it("formats countries and regions, a region tag alone, or nothing", () => {
    expect(locationText(LOCATED)).toBe("Türkiye · Europe");
    expect(locationText({ ...LOCATED, location: { countries: ["MX", "US"], regions: ["americas"], source: "guardian-tags" } })).toBe("Mexico, United States · Americas");
    expect(locationText({ ...LOCATED, location: { countries: [], regions: ["africa"], source: "guardian-tags" } })).toBe("Africa");
    expect(locationText(UNLOCATED)).toBeNull();
  });
});
