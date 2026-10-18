// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import UnsubscribePage from "./UnsubscribePage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const TOKEN = "T".repeat(43);
const open = (search: string) => {
  window.history.replaceState(null, "", `/unsubscribe${search}`);
  return render(
    <MemoryRouter>
      <UnsubscribePage />
    </MemoryRouter>
  );
};

describe("unsubscribe page", () => {
  it("one click: posts the token once, confirms, and removes the token from the address bar", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    open(`?token=${TOKEN}`);
    expect(await screen.findByText("You are unsubscribed.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/email/unsubscribe");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN });
    expect(window.location.search).toBe("");
  });

  it("says so when the link is not valid, without calling the server for an empty token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: "x" }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    open("");
    expect(await screen.findByText(/This unsubscribe link is not valid/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    cleanup();
    open(`?token=${TOKEN}`);
    expect(await screen.findByText(/This unsubscribe link is not valid/)).toBeTruthy();
  });

  it("a server error changes nothing and says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    open(`?token=${TOKEN}`);
    expect(await screen.findByText(/nothing was changed/)).toBeTruthy();
  });
});
