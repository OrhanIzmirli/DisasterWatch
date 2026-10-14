import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createTestApp, resetDb, registerAgent, sessionCookie, PASSWORD } from "./helpers.js";
import { parseCorsOrigins, DEFAULT_CORS_ORIGINS } from "../src/utils/corsOrigins.js";

/** Security headers, CORS allow-list and JSON-only error bodies. */

const ALLOWED = "https://disasterwatch-frontend.onrender.com";
const app = createTestApp();

beforeAll(async () => {
  await resetDb();
});

describe("security headers", () => {
  it("sends helmet headers and hides X-Powered-By", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["referrer-policy"]).toBeDefined();
    expect(res.headers["strict-transport-security"]).toBeUndefined(); // left to the edge
  });
});

describe("CORS allow-list", () => {
  it("echoes an allowed origin with credentials, never a wildcard", async () => {
    const res = await request(app).get("/health").set("Origin", ALLOWED);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["vary"]).toMatch(/Origin/);
  });

  it("gives a disallowed origin no CORS headers (browser blocks the read)", async () => {
    const res = await request(app).get("/health").set("Origin", "https://evil.example");
    expect(res.status).toBe(200); // the API still answers; the browser refuses to expose it
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    const preflight = await request(app).options("/users/login").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "POST");
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers preflights for allowed origins", async () => {
    const res = await request(app).options("/users/login").set("Origin", ALLOWED).set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", "Content-Type");
    expect([200, 204]).toContain(res.status);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-headers"]).toMatch(/Content-Type/i);
  });

  it("requests without an Origin header (same-origin proxy, curl) are unaffected and keep cookie auth working", async () => {
    const { agent, res } = await registerAgent(app, "cors-user@example.com");
    expect(res.status).toBe(201);
    expect(sessionCookie(res)).toBeDefined();
    const me = await agent.get("/users/me");
    expect(me.status).toBe(200);
    expect(me.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("cookie auth also works for an allowed origin", async () => {
    const login = await request(app).post("/users/login").set("Origin", ALLOWED).send({ email: "cors-user@example.com", password: PASSWORD });
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login);
    const me = await request(app).get("/users/me").set("Origin", ALLOWED).set("Cookie", cookie.split(";")[0]);
    expect(me.status).toBe(200);
    expect(me.headers["access-control-allow-origin"]).toBe(ALLOWED);
  });

  it("CORS_ORIGINS overrides the default list", async () => {
    expect([...parseCorsOrigins("")]).toEqual(DEFAULT_CORS_ORIGINS);
    expect([...parseCorsOrigins(" https://a.example/, http://b.example:3000 ")]).toEqual(["https://a.example", "http://b.example:3000"]);
    const custom = createTestApp({ corsOrigins: "https://a.example" });
    const ok = await request(custom).get("/health").set("Origin", "https://a.example");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://a.example");
    const no = await request(custom).get("/health").set("Origin", ALLOWED);
    expect(no.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("error bodies are JSON", () => {
  it("malformed JSON -> 400 JSON, not Express's HTML page", async () => {
    const res = await request(app).post("/users/login").set("Content-Type", "application/json").send("{bad json");
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ message: "Malformed JSON body" });
  });

  it("oversized JSON -> 413 JSON", async () => {
    const res = await request(app).post("/users/login").set("Content-Type", "application/json").send(JSON.stringify({ email: "x".repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ message: "Request body too large" });
  });

  it("unknown routes -> 404 JSON", async () => {
    const res = await request(app).get("/no-such-route");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.message).toBeDefined();
  });
});
