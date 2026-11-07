// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi  } from "vitest";
import { render, screen, fireEvent, cleanup  } from "@testing-library/react";
import EventDetailDrawer, { type DrawerEvent } from "./EventDetailDrawer";

afterEach(cleanup);

const event: DrawerEvent = {
  id: 1,
  type: "flood",
  severity: "low",
  location: "Flood in Libya 1104231",
  meta: "Floods · 2 days ago",
  description: "Flood in Libya",
  lat: 32.88,
  lng: 13.14,
  timeMinutesAgo: 2880,
};

describe("EventDetailDrawer keyboard behaviour", () => {
  it("is a modal dialog named after the event and focuses its close button on open", () => {
    render(<EventDetailDrawer event={event} onClose={() => {}} onZoomTo={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Flood in Libya" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("Escape closes the drawer (and only Escape)", () => {
    const onClose = vi.fn();
    render(<EventDetailDrawer event={event} onClose={onClose} onZoomTo={() => {}} />);
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("removes its Escape listener when it unmounts", () => {
    const onClose = vi.fn();
    render(<EventDetailDrawer event={event} onClose={onClose} onZoomTo={() => {}} />);
    cleanup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("focus returns to the opener when the parent closes the drawer on Escape", () => {
    // mirrors DashboardPage: the opener row is remembered and focused after close
    const opener = document.createElement("li");
    opener.tabIndex = 0;
    document.body.appendChild(opener);
    opener.focus();
    let open = true;
    const onClose = () => {
      open = false;
      opener.focus();
    };
    const { unmount } = render(<EventDetailDrawer event={event} onClose={onClose} onZoomTo={() => {}} />);
    expect(document.activeElement).not.toBe(opener); // the close button took focus
    fireEvent.keyDown(document, { key: "Escape" });
    unmount();
    expect(open).toBe(false);
    expect(document.activeElement).toBe(opener);
  });
});

describe("EventDetailDrawer location precision", () => {
  const details = (locationPrecision?: "exact" | "approximate") =>
    ({ cleanTitle: "Flood in Türkiye", sources: [], severity: "low", severityReason: "Low", severitySource: "GDACS", ...(locationPrecision ? { locationPrecision } : {}) }) as unknown as DrawerEvent["details"];

  it("says so when the sources disagree on the exact area", () => {
    render(<EventDetailDrawer event={{ ...event, details: details("approximate") }} onClose={() => {}} onZoomTo={() => {}} />);
    expect(screen.getByText("Approximate location — sources disagree on the exact area")).toBeTruthy();
  });

  it("adds nothing for an exact location or without the field (USGS)", () => {
    render(<EventDetailDrawer event={{ ...event, details: details("exact") }} onClose={() => {}} onZoomTo={() => {}} />);
    expect(screen.queryByText(/Approximate location/)).toBeNull();
    cleanup();
    render(<EventDetailDrawer event={{ ...event, details: details() }} onClose={() => {}} onZoomTo={() => {}} />);
    expect(screen.queryByText(/Approximate location/)).toBeNull();
  });
});

describe("EventDetailDrawer content", () => {
  const quake: DrawerEvent = {
    id: 7,
    type: "earthquake",
    severity: "low",
    location: "M 4.7 - 100 km SSE of Palekastro, Greece",
    meta: "",
    description: "",
    lat: 34.3,
    lng: 26.5,
    details: {
      cleanTitle: "M 4.7 - 100 km SSE of Palekastro, Greece",
      place: "100 km SSE of Palekastro, Greece",
      magnitude: 4.7,
      magnitudeLabel: "4.7",
      magType: "mb",
      depthKm: 40.2,
      sources: [],
      severity: "low",
      severityReason: "Low: magnitude 4.7 (< 5.0)",
      severitySource: "Severity rule applied to the USGS magnitude",
    } as unknown as DrawerEvent["details"],
  };

  it("opens with a plain-language summary and the key facts", () => {
    render(<EventDetailDrawer event={quake} onClose={() => {}} onZoomTo={() => {}} />);
    expect(screen.getByText(/^A magnitude 4\.7 earthquake at 40 km depth, 100 km SSE of Palekastro, Greece/)).toBeTruthy();
    expect(screen.getByText("M 4.7")).toBeTruthy();
    expect(screen.getByText("Light")).toBeTruthy();
    expect(screen.getByText("40.2 km")).toBeTruthy();
    expect(screen.getByText("Shallow")).toBeTruthy();
  });

  it("marks the event's level on the severity scale, with the served thresholds", () => {
    const rules = {
      earthquake: { basis: "magnitude", unit: "M", medium: 5.0, high: 6.0, step: 0.1 },
      wildfire: { basis: "burnedArea", unit: "ha", medium: 7000, high: 10000, step: 1 },
      storm: { basis: "peakWind", unit: "kts", medium: 64, high: 96, step: 1 },
      gdacs: { levels: { green: "low", orange: "medium", red: "high" } as const, appliesTo: ["wildfire", "flood"] },
    };
    render(<EventDetailDrawer event={quake} onClose={() => {}} onZoomTo={() => {}} severityRules={rules} />);
    const current = document.querySelector(".edd-scale [aria-current='true']");
    expect(current?.textContent).toContain("Low");
    expect(current?.textContent).toContain("below M 5.0");
  });

  it("keeps raw values in a folded technical section", () => {
    render(<EventDetailDrawer event={quake} onClose={() => {}} onZoomTo={() => {}} />);
    const tech = document.querySelector("details.edd-tech") as HTMLDetailsElement;
    expect(tech.open).toBe(false);
    expect(tech.textContent).toContain("34.300, 26.500");
    expect(tech.textContent).toContain("mb");
  });

  it("'Show on map' asks the dashboard to fly to the event", () => {
    const onZoomTo = vi.fn();
    render(<EventDetailDrawer event={quake} onClose={() => {}} onZoomTo={onZoomTo} />);
    fireEvent.click(screen.getByRole("button", { name: "Show on map" }));
    expect(onZoomTo).toHaveBeenCalledTimes(1);
  });

  it("lists nearby events and opens one on click", () => {
    const onSelectEvent = vi.fn();
    const other: DrawerEvent = { ...quake, id: 8, location: "M 4.5 - 87 km S of Ierapetra, Greece", details: { ...quake.details!, cleanTitle: "M 4.5 - 87 km S of Ierapetra, Greece" } };
    render(<EventDetailDrawer event={quake} onClose={() => {}} onZoomTo={() => {}} nearby={[{ event: other, distanceKm: 64.4 }]} onSelectEvent={onSelectEvent} />);
    fireEvent.click(screen.getByRole("button", { name: /Ierapetra/ }));
    expect(onSelectEvent).toHaveBeenCalledWith(8);
    expect(screen.getByText(/64 km away/)).toBeTruthy();
  });

  it("says why nothing is marked for a not-rated event", () => {
    render(<EventDetailDrawer event={{ ...event, severity: "unrated" }} onClose={() => {}} onZoomTo={() => {}} />);
    expect(screen.getByText(/so no level is guessed/)).toBeTruthy();
    expect(document.querySelector(".edd-scale [aria-current='true']")).toBeNull();
  });
});
