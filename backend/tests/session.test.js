/**
 * GET /users/session: the page's session check answers 200 either way, so a
 * signed-out first visit logs no failed request; it agrees with GET /users/me.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import prisma from "../src/prisma.js";
import { createTestApp, resetDb, registerAgent } from "./helpers.js";

const app = createTestApp();

describe("GET /users/session", () => {
  beforeEach(resetDb);

  it("answers 200 { user: null } without a session", async () => {
    const res = await request(app).get("/users/session");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: null });
  });

  it("returns the same user as /users/me for a signed-in browser", async () => {
    const { agent } = await registerAgent(app, "session-user@example.com");
    const [session, me] = await Promise.all([agent.get("/users/session"), agent.get("/users/me")]);
    expect(session.status).toBe(200);
    expect(session.body.user).toEqual(me.body.user);
    expect(session.body.user.email).toBe("session-user@example.com");
  });

  it("answers null and clears the cookie once the account is disabled", async () => {
    const { agent } = await registerAgent(app, "session-disabled@example.com");
    await prisma.user.update({ where: { email: "session-disabled@example.com" }, data: { disabledAt: new Date() } });
    const res = await agent.get("/users/session");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: null });
    expect(String(res.headers["set-cookie"] ?? "")).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });

  it("answers null for a garbage cookie", async () => {
    const res = await request(app).get("/users/session").set("Cookie", "dw_session=not-a-token");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: null });
  });
});
