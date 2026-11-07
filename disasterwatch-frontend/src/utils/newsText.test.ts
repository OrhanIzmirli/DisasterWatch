import { describe, it, expect } from "vitest";
import { eventTagText } from "./newsText";
import type { NewsItem } from "../services/newsService";

const item = (type: "earthquake" | "flood" | "wildfire" | "storm", location: string, severity: "low" | "medium" | "high" | "unrated" = "high") =>
  ({ title: "Example", url: "https://example.com/a", domain: "example.com", publishedAt: null, relatedEvent: { id: 1, type, severity, location, lat: 0, lng: 0 } }) as NewsItem;

describe("eventTagText", () => {
  it("does not repeat a type the event title already names", () => {
    expect(eventTagText(item("wildfire", "Wildfire in Indonesia"))).toBe("Wildfire in Indonesia · High");
    expect(eventTagText(item("flood", "Flood in Libya 1104231", "unrated"))).toBe("Flood in Libya · Not rated");
  });

  it("keeps the type when the title does not name it", () => {
    expect(eventTagText(item("storm", "Tropical Cyclone Arnab"))).toBe("Storm · Tropical Cyclone Arnab · High");
    expect(eventTagText(item("earthquake", "M 5.2 - 107 km NNE of Hihifo, Tonga", "medium"))).toBe("Earthquake · M 5.2 - 107 km NNE of Hihifo, Tonga · Medium");
  });

  it("is null for an article without a linked event", () => {
    expect(eventTagText({ title: "x", url: "https://example.com", domain: "example.com", publishedAt: null } as NewsItem)).toBeNull();
  });
});
