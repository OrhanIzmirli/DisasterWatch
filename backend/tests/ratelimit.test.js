import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resetDb, registerAgent, PASSWORD } from "./helpers.js";

// Own app instance with the production limit (10 / window) and a short window,
// so hitting the limit here cannot leak into any other test file.
const app = createApp({ authRateLimit: { limit: 10, windowMs: 60_000 } });

describe("auth rate limit", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("allows 10 login attempts and rejects the 11th with 429", async () => {
    const attempt = () =>
      request(app)
        .post("/users/login")
        .send({ email: "nobody@example.com", password: "WrongPassword1" });

    for (let i = 1; i <= 10; i++) {
      const res = await attempt();
      expect(res.status, `attempt ${i}`).toBe(401);
      expect(res.headers["ratelimit-policy"]).toMatch(/^10;w=60/);
    }

    const eleventh = await attempt();
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.message).toMatch(/too many attempts/i);
    expect(eleventh.headers["retry-after"]).toBeDefined();
  });

  it("applies the same counter to /users/register", async () => {
    const res = await request(app)
      .post("/users/register")
      .send({ email: "late@example.com", password: PASSWORD });
    expect(res.status).toBe(429);
  });

  it("does not throttle endpoints outside login/register", async () => {
    const res = await request(app).get("/users/me");
    expect(res.status).toBe(401); // not 429
  });

  it("is per client IP (trust proxy honours X-Forwarded-For)", async () => {
    const res = await request(app)
      .post("/users/login")
      .set("X-Forwarded-For", "203.0.113.9")
      .send({ email: "nobody@example.com", password: "WrongPassword1" });
    expect(res.status).toBe(401); // fresh window for a different client
  });

  it("is disabled when createApp is given authRateLimit: false", async () => {
    const open = createApp({ authRateLimit: false });
    await registerAgent(open, "open@example.com");
    for (let i = 1; i <= 12; i++) {
      const res = await request(open)
        .post("/users/login")
        .send({ email: "open@example.com", password: PASSWORD });
      expect(res.status, `attempt ${i}`).toBe(200);
    }
  });
});
