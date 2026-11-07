// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DeveloperKeys from "./DeveloperKeys";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const KEY = "dwk_" + "A".repeat(43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fake backend: session state changes with the calls the component makes. */
function backend(initial: { enabled?: boolean; signedIn?: boolean; hasKey?: boolean } = {}) {
  const state = { enabled: initial.enabled ?? true, signedIn: initial.signedIn ?? false, hasKey: initial.hasKey ?? false };
  const calls: { method: string; url: string; header: string | null }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ method, url, header: new Headers(init.headers).get("X-DW-Request") });
    if (url.endsWith("/developer/session"))
      return json({
        enabled: state.enabled,
        developer: state.signedIn ? { login: "octo-example", createdAt: "2026-11-07T10:00:00Z" } : null,
        key: state.signedIn && state.hasKey ? { prefix: KEY.slice(0, 12), createdAt: "2026-11-07T10:00:00Z", lastUsedAt: null } : null,
      });
    if (url.endsWith("/developer/keys") && method === "POST") {
      state.hasKey = true;
      return json({ key: KEY, prefix: KEY.slice(0, 12), createdAt: "2026-11-07T10:00:00Z" }, 201);
    }
    if (url.endsWith("/developer/keys") && method === "DELETE") {
      state.hasKey = false;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/developer/me") && method === "DELETE") {
      state.signedIn = false;
      state.hasKey = false;
      return new Response(null, { status: 204 });
    }
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { state, calls };
}

describe("DeveloperKeys", () => {
  it("signed out: a GitHub sign-in link to the backend", async () => {
    backend();
    render(<DeveloperKeys />);
    const link = await screen.findByRole("link", { name: "Sign in with GitHub" });
    expect(link.getAttribute("href")).toBe("/api/v1/auth/github");
  });

  it("says so when key sign-in is not set up", async () => {
    backend({ enabled: false });
    render(<DeveloperKeys />);
    expect(await screen.findByText(/not available on this server/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in with GitHub" })).toBeNull();
  });

  it("creates a key, shows it once, then only its prefix; revokes it", async () => {
    const { calls } = backend({ signedIn: true });
    render(<DeveloperKeys />);
    await userEvent.click(await screen.findByRole("button", { name: "Create key" }));
    const input = (await screen.findByLabelText(/shown only now/)) as HTMLInputElement;
    expect(input.value).toBe(KEY);
    expect(screen.getByText(`${KEY.slice(0, 12)}…`)).toBeTruthy();
    expect(calls.filter((c) => c.method !== "GET").every((c) => c.header === "1")).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Revoke key" }));
    expect(await screen.findByText(/Key revoked/)).toBeTruthy();
    expect(screen.queryByLabelText(/shown only now/)).toBeNull();
    expect(screen.getByRole("button", { name: "Create key" })).toBeTruthy();
  });

  it("deleting the developer account asks once more", async () => {
    const { state } = backend({ signedIn: true, hasKey: true });
    render(<DeveloperKeys />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete developer account…" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete developer account" }));
    expect(await screen.findByText(/Developer account and keys deleted/)).toBeTruthy();
    expect(state.signedIn).toBe(false);
    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
  });
});
