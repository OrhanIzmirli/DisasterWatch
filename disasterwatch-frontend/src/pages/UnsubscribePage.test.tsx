// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import UnsubscribePage from "./UnsubscribePage";
import ConfirmEmailPage from "./ConfirmEmailPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const TOKEN = "T".repeat(43);
const open = (page: "unsubscribe" | "confirm-email", search: string) => {
  window.history.replaceState(null, "", `/${page}${search}`);
  return render(<MemoryRouter>{page === "unsubscribe" ? <UnsubscribePage /> : <ConfirmEmailPage />}</MemoryRouter>);
};
const ok = () => vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

describe("unsubscribe page", () => {
  it("opening the link changes nothing (scanners); the button posts the token once and the page confirms", async () => {
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);
    open("unsubscribe", `?token=${TOKEN}`);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.search).toBe(`?token=${TOKEN}`); // a reload before the press still works
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from alert e-mails" }));
    expect(await screen.findByText("You are unsubscribed.")).toBeTruthy();
    expect(window.location.search).toBe(""); // used: removed from the address bar
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/email/unsubscribe");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN });
  });

  it("says so when the link is not valid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "x" }), { status: 404 })));
    open("unsubscribe", "");
    expect(screen.getByText(/This unsubscribe link is not valid/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Unsubscribe/ })).toBeNull();
    cleanup();
    open("unsubscribe", `?token=${TOKEN}`);
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from alert e-mails" }));
    expect(await screen.findByText(/This unsubscribe link is not valid/)).toBeTruthy();
  });

  it("a server error changes nothing and says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    open("unsubscribe", `?token=${TOKEN}`);
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from alert e-mails" }));
    expect(await screen.findByText(/nothing was changed/)).toBeTruthy();
  });
});

describe("confirm-email page (double opt-in)", () => {
  it("confirms only on the button, with one POST to /api/email/confirm", async () => {
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);
    open("confirm-email", `?token=${TOKEN}`);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, send alert e-mails to this address" }));
    expect(await screen.findByText("Confirmed.")).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/email/confirm");
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN });
  });
});
