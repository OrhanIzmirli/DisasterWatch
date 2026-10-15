// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach  } from "vitest";
import { render, screen , cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App";

afterEach(cleanup);

// Every API call the app shell makes on mount answers "signed out" / nothing.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const status = url.includes("/users/me") ? 401 : url.includes("/health") ? 200 : 404;
      return new Response(JSON.stringify(status === 200 ? { ok: true } : { message: "no" }), { status, headers: { "Content-Type": "application/json" } });
    })
  );
});

describe("unknown routes", () => {
  it("render a real 404 page instead of redirecting to the dashboard", async () => {
    render(
      <MemoryRouter initialEntries={["/this/page/does/not/exist"]}>
        <App />
      </MemoryRouter>
    );
    const heading = await screen.findByRole("heading", { name: "Page not found" });
    expect(heading).toBeTruthy();
    expect(screen.getByText("/this/page/does/not/exist")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the dashboard" }).getAttribute("href")).toBe("/");
    expect(document.title).toMatch(/Page not found/);
    // no dashboard content was rendered in its place
    expect(screen.queryByText(/Global disaster overview/i)).toBeNull();
  });
});
