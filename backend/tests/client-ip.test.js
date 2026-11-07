/**
 * Client IP behind Render (utils/clientIp.js): Cloudflare's True-Client-IP /
 * CF-Connecting-IP win over the changing last X-Forwarded-For hop, so one
 * client keeps one rate-limit counter; without them req.ip is used as before.
 */
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { clientIp, useClientIp } from "../src/utils/clientIp.js";

const { createTestApp } = await import("./helpers.js");

function echoApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(useClientIp);
  app.get("/ip", (req, res) => res.json({ ip: req.ip, direct: clientIp(req) }));
  return app;
}

describe("clientIp", () => {
  const app = echoApp();

  it("prefers True-Client-IP, then CF-Connecting-IP, then req.ip", async () => {
    const hops = "198.51.100.1, 10.0.0.7, 10.0.0.9";
    expect((await request(app).get("/ip").set("X-Forwarded-For", hops).set("True-Client-IP", "203.0.113.5").set("CF-Connecting-IP", "203.0.113.6")).body.ip).toBe("203.0.113.5");
    expect((await request(app).get("/ip").set("X-Forwarded-For", hops).set("CF-Connecting-IP", "2001:db8::1")).body.ip).toBe("2001:db8::1");
    // no Cloudflare headers (local runs): trust proxy 1 picks the last hop, as before
    expect((await request(app).get("/ip").set("X-Forwarded-For", hops)).body.ip).toBe("10.0.0.9");
  });

  it("ignores a header that is not an IP address", async () => {
    const res = await request(app).get("/ip").set("X-Forwarded-For", "10.0.0.9").set("True-Client-IP", "not-an-ip").set("CF-Connecting-IP", "203.0.113.6");
    expect(res.body).toEqual({ ip: "203.0.113.6", direct: "203.0.113.6" });
  });
});

describe("rate limit keyed on the client, not the proxy hop", () => {
  it("one client through changing hops shares one counter; another client has its own", async () => {
    const app = createTestApp({ v1RateLimit: { limit: 2, windowMs: 60_000 } });
    const get = (client, hop) => request(app).get("/api/v1/types").set("X-Forwarded-For", `${client}, 10.1.0.${hop}`).set("True-Client-IP", client);
    expect((await get("203.0.113.10", 1)).status).toBe(200);
    expect((await get("203.0.113.10", 2)).status).toBe(200);
    const third = await get("203.0.113.10", 3);
    expect(third.status).toBe(429);
    expect((await get("203.0.113.11", 3)).status).toBe(200);
  });
});
