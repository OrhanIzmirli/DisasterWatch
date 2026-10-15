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
