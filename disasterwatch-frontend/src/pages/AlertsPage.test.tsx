// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AlertsPage from "./AlertsPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Alerts page delivery channels", () => {
  it("says honestly that new events are checked about once an hour", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } })));
    render(
      <MemoryRouter>
        <AlertsPage user={{ email: "someone@example.com", role: "user" }} authLoading={false} />
      </MemoryRouter>
    );
    expect(await screen.findByText("In-app notifications: active")).toBeTruthy();
    expect(screen.getByText(/checked about once an hour/).textContent).toBe(
      "New events are checked about once an hour, so an alert can arrive up to an hour after the event is reported."
    );
  });
});
