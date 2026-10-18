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

type Channel = "active" | "limit-reached" | "not-configured" | "unknown";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settings = (state: Channel, enabled = false, verified = true) => ({ enabled, consentAt: enabled ? "2026-10-18T10:00:00.000Z" : null, verified, confirmation: verified ? null : { status: "sent" as const, at: "2026-10-18T10:00:00.000Z" }, channel: { state, dailyLimit: 90, sentLast24h: state === "limit-reached" ? 90 : 3 } });

function mockApi(initial: ReturnType<typeof settings>) {
  let current = initial;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/alerts/email" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      current = settings(current.channel.state, body.enabled);
      return json(current);
    }
    if (url === "/api/alerts/email") return json(current);
    return json({ items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <AlertsPage user={{ email: "someone@example.com", role: "user" }} authLoading={false} />
    </MemoryRouter>
  );

describe("Alerts page e-mail channel", () => {
  it("is off by default; turning it on sends the explicit consent; the text names the address", async () => {
    const fetchMock = mockApi(settings("active"));
    renderPage();
    const sw = (await screen.findByRole("switch")) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    expect(screen.getByText(/By turning this on you agree/).textContent).toContain("someone@example.com");
    expect(screen.getByText("E-mail: available, off for your account")).toBeTruthy();
    sw.click();
    await screen.findByText("E-mail: active");
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ enabled: true, consent: true });
    expect(((await screen.findByRole("switch")) as HTMLInputElement).checked).toBe(true);
  });

  it("does not claim e-mail is active when the server has no e-mail set up; the switch cannot be turned on", async () => {
    mockApi(settings("not-configured"));
    renderPage();
    expect(await screen.findByText("E-mail: not available yet (not set up on this server)")).toBeTruthy();
    expect(((await screen.findByRole("switch")) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText("E-mail: active")).toBeNull();
  });

  it("says when the daily limit is used up, and when the status is unknown", async () => {
    mockApi(settings("limit-reached", true));
    renderPage();
    expect((await screen.findByText(/E-mail: paused/)).textContent).toContain("limit of 90 e-mails per 24 hours is used up");
    cleanup();
    mockApi(settings("unknown", true));
    renderPage();
    expect(await screen.findByText(/E-mail: status unknown/)).toBeTruthy();
  });
});

describe("Alerts page e-mail double opt-in", () => {
  it("on but not confirmed: says a confirmation link was sent and does not claim e-mail is active", async () => {
    mockApi(settings("active", true, false));
    renderPage();
    expect(await screen.findByText(/waiting for you to confirm your address/)).toBeTruthy();
    expect(screen.getByText(/Almost done/).textContent).toContain("someone@example.com");
    expect(screen.queryByText("E-mail: active")).toBeNull();
  });
});
