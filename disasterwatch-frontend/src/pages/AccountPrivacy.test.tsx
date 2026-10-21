// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AccountPage from "./AccountPage";
import PrivacyPage from "./PrivacyPage";
import SignInPage from "./SignInPage";
import SignUpPage from "./SignUpPage";
import SiteFooter from "../components/SiteFooter";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const USER = { email: "alice@example.com", role: "user", createdAt: "2026-10-01T10:00:00.000Z", subscriptionCount: 1 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** /api/users/me answers the profile; DELETE /api/users/me answers `deleteResponse`. */
function stubServer(deleteResponse: () => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    url === "/api/users/me" && init?.method === "DELETE" ? deleteResponse() : json(200, { user: USER })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const openAccount = (onAccountDeleted = vi.fn()) => {
  render(
    <MemoryRouter>
      <AccountPage user={USER} onSignOut={vi.fn()} onAccountDeleted={onAccountDeleted} />
    </MemoryRouter>
  );
  return onAccountDeleted;
};

describe("account deletion", () => {
  it("asks for the password first and sends it with DELETE /api/users/me", async () => {
    const fetchMock = stubServer(() => json(200, { ok: true, deleted: { subscriptions: 1, notifications: 0, emailDeliveries: 0 } }));
    const onDeleted = openAccount();

    // nothing is deleted by the first button: it only opens the confirmation
    fireEvent.click(screen.getByRole("button", { name: "Delete my account…" }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Delete account permanently" }));
    expect(await screen.findByText("Enter your password to delete the account.")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "CorrectHorse1!" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete account permanently" }));
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(call?.[0]).toBe("/api/users/me");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ password: "CorrectHorse1!" });
  });

  it("shows the server's message for a wrong password and keeps the account", async () => {
    stubServer(() => json(403, { message: "The password is not correct." }));
    const onDeleted = openAccount();
    fireEvent.click(screen.getByRole("button", { name: "Delete my account…" }));
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete account permanently" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The password is not correct.");
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("cancel closes the form and forgets the typed password", () => {
    stubServer(() => json(200, { ok: true }));
    openAccount();
    fireEvent.click(screen.getByRole("button", { name: "Delete my account…" }));
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "secret-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete my account…" }));
    expect((screen.getByLabelText("Your password") as HTMLInputElement).value).toBe("");
  });
});

describe("privacy", () => {
  it("the privacy page covers what is stored, who handles it, how long, how to delete, and says it is not legal advice", () => {
    render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>
    );
    for (const h of ["What we store", "Who handles it", "How long it is kept", "How to delete it"]) {
      expect(screen.getByRole("heading", { level: 2, name: h })).toBeTruthy();
    }
    expect(screen.getByText(/It is not legal advice\./)).toBeTruthy();
    for (const processor of ["Render", "Neon", "Resend"]) expect(screen.getAllByText(processor).length).toBeGreaterThan(0);
    expect(document.title).toBe("Privacy – DisasterWatch");
  });

  it("the footer and the sign-up page link to it", () => {
    render(
      <MemoryRouter>
        <SiteFooter />
        <SignUpPage onSignedIn={vi.fn()} />
      </MemoryRouter>
    );
    const links = screen.getAllByRole("link", { name: "Privacy" });
    expect(links).toHaveLength(2);
    for (const l of links) expect(l.getAttribute("href")).toBe("/privacy");
  });

  it("the sign-in page shows the notice it was given after a deletion", () => {
    render(
      <MemoryRouter>
        <SignInPage onSignedIn={vi.fn()} notice="Your account and all its data were deleted." />
      </MemoryRouter>
    );
    expect(screen.getByRole("status").textContent).toBe("Your account and all its data were deleted.");
  });
});

describe("sign-up: an already registered address offers sign-in", () => {
  it("shows the Sign in link next to the server's 409 message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(409, { message: "Email is already registered." })));
    render(
      <MemoryRouter>
        <SignUpPage onSignedIn={vi.fn()} />
      </MemoryRouter>
    );
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "alice@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "CorrectHorse1!" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText(/This e-mail is already registered\./)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Sign in" }).length).toBe(2); // the error's link and the footer's
  });
});
