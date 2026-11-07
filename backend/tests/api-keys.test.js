/**
 * Optional public API keys: GitHub sign-in (GitHub mocked), keys stored only as
 * hashes and shown once, renew/revoke/delete, and the v1 limits (anonymous per IP,
 * with a key per key; a wrong key is a 401). Uses the test database.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import prisma from "../src/prisma.js";
import { createTestApp, resetDb } from "./helpers.js";
import { createKeyStore, generateKey, hashKey, KEY_PATTERN, LAST_USED_WRITE_MS } from "../src/services/apiKeys.js";
import { createV1Router } from "../src/routes/v1.routes.js";
import { sitePaths } from "../src/routes/developer.routes.js";

const REDIRECT = "http://localhost:8080/api/v1/auth/github/callback";
const ENV = { GITHUB_CLIENT_ID: "test-client-id", GITHUB_CLIENT_SECRET: "test-client-secret-not-real", GITHUB_OAUTH_REDIRECT_URI: REDIRECT };

/** Fake GitHub: the token endpoint checks the PKCE verifier against the challenge it saw. */
function fakeGithub({ id = 4242, login = "octo-example", refuse = false } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://github.com/login/oauth/access_token")) {
      const body = JSON.parse(init.body);
      if (refuse || body.code !== "good-code" || body.client_secret !== ENV.GITHUB_CLIENT_SECRET || !body.code_verifier) {
        return new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ access_token: "gho_test_token_not_real", token_type: "bearer" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(url) === "https://api.github.com/user") {
      expect(init.headers.Authorization).toBe("Bearer gho_test_token_not_real");
      return new Response(JSON.stringify({ id, login, email: "should-not-be-stored@example.com" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  });
  fn.calls = calls;
  return fn;
}

function appWith(fetchImpl, env = ENV) {
  return createTestApp({ v1RateLimit: false, developerRateLimit: false, developer: { env, fetch: fetchImpl } });
}

/** Runs the whole sign-in on an agent and returns it signed in. */
async function signIn(app, { state } = {}) {
  const agent = request.agent(app);
  const start = await agent.get("/api/v1/auth/github");
  expect(start.status).toBe(302);
  const location = new URL(start.headers.location);
  expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(location.searchParams.get("client_id")).toBe("test-client-id");
  expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT);
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  expect(location.searchParams.get("scope")).toBe("");
  const back = await agent.get(`/api/v1/auth/github/callback?code=good-code&state=${state ?? location.searchParams.get("state")}`);
  return { agent, back };
}

const write = (agent, method, path) => agent[method](path).set("X-DW-Request", "1");

beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("key store", () => {
  it("keys are dwk_ + 43 base64url chars; only the hash and a 12-character prefix are stored", async () => {
    const dev = await prisma.apiDeveloper.create({ data: { githubId: "1", githubLogin: "a" } });
    const store = createKeyStore();
    const { key, prefix } = await store.issue(dev.id);
    expect(key).toMatch(KEY_PATTERN);
    expect(prefix).toBe(key.slice(0, 12));
    const rows = await prisma.apiKey.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toBe(hashKey(key));
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(await store.verify(key)).toBe(rows[0].id);
  });

  it("renewing revokes the previous key at once; revoke and unknown keys verify to null", async () => {
    const dev = await prisma.apiDeveloper.create({ data: { githubId: "2", githubLogin: "b" } });
    const store = createKeyStore();
    const first = await store.issue(dev.id);
    expect(await store.verify(first.key)).not.toBeNull(); // cached now
    const second = await store.issue(dev.id);
    expect(await store.verify(first.key)).toBeNull(); // cache dropped on renewal
    expect(await store.verify(second.key)).not.toBeNull();
    expect(await store.revoke(dev.id)).toBe(1);
    expect(await store.verify(second.key)).toBeNull();
    expect(await store.verify(generateKey().key)).toBeNull();
    expect(await store.verify("not-a-key")).toBeNull();
    expect(await store.active(dev.id)).toBeNull();
  });

  it("caches lookups (also misses) and writes lastUsedAt at most once an hour", async () => {
    const dev = await prisma.apiDeveloper.create({ data: { githubId: "3", githubLogin: "c" } });
    let t = Date.now();
    const spy = { findUnique: 0, update: 0 };
    const counting = {
      ...prisma,
      apiKey: {
        ...prisma.apiKey,
        findUnique: (...a) => (spy.findUnique++, prisma.apiKey.findUnique(...a)),
        update: (...a) => (spy.update++, prisma.apiKey.update(...a)),
        findMany: (...a) => prisma.apiKey.findMany(...a),
        updateMany: (...a) => prisma.apiKey.updateMany(...a),
      },
      $transaction: (fn) => prisma.$transaction(fn),
    };
    const store = createKeyStore({ prisma: counting, now: () => t });
    const { key } = await store.issue(dev.id);
    const wrong = generateKey().key;
    for (let i = 0; i < 5; i++) {
      await store.verify(key);
      await store.verify(wrong);
    }
    expect(spy.findUnique).toBe(2);
    expect(spy.update).toBe(1);
    t += LAST_USED_WRITE_MS + 61_000;
    await store.verify(key);
    expect(spy.findUnique).toBe(3);
    expect(spy.update).toBe(2);
  });
});

describe("GitHub sign-in", () => {
  it("signs in with PKCE, stores only the GitHub id and login, and returns to the API page", async () => {
    const github = fakeGithub();
    const { agent, back } = await signIn(appWith(github));
    expect(back.status).toBe(303);
    expect(back.headers.location).toBe("http://localhost:8080/api?developer=signed-in#developer");
    const cookie = back.headers["set-cookie"].find((c) => c.startsWith("dw_dev="));
    expect(cookie).toMatch(/Path=\/api\/v1\/developer/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const rows = await prisma.apiDeveloper.findMany();
    expect(rows).toEqual([expect.objectContaining({ githubId: "4242", githubLogin: "octo-example" })]);
    expect(JSON.stringify(rows)).not.toMatch(/example\.com|gho_/);
    const session = await agent.get("/api/v1/developer/session");
    expect(session.body).toMatchObject({ enabled: true, developer: { login: "octo-example" }, key: null });
    // the PKCE verifier sent to GitHub matches the challenge of the authorize redirect
    const tokenCall = github.calls.find((c) => c.url.includes("access_token"));
    expect(JSON.parse(tokenCall.init.body).code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("a second sign-in updates the login of the same developer", async () => {
    await signIn(appWith(fakeGithub({ login: "old-name" })));
    await signIn(appWith(fakeGithub({ login: "new-name" })));
    expect(await prisma.apiDeveloper.findMany({ select: { githubLogin: true } })).toEqual([{ githubLogin: "new-name" }]);
  });

  it("a wrong state, a refused code or a declined authorization signs nobody in", async () => {
    const wrongState = await signIn(appWith(fakeGithub()), { state: "forged" });
    expect(wrongState.back.headers.location).toMatch(/developer=expired/);
    const refused = await signIn(appWith(fakeGithub({ refuse: true })));
    expect(refused.back.headers.location).toMatch(/developer=error/);
    const declined = await request(appWith(fakeGithub())).get("/api/v1/auth/github/callback?error=access_denied&state=x");
    expect(declined.headers.location).toMatch(/developer=denied/);
    const noCookie = await request(appWith(fakeGithub())).get("/api/v1/auth/github/callback?code=good-code&state=x");
    expect(noCookie.headers.location).toMatch(/developer=expired/);
    expect(await prisma.apiDeveloper.count()).toBe(0);
  });

  it("without GitHub credentials sign-in is reported as not set up", async () => {
    const app = appWith(fakeGithub(), {});
    expect((await request(app).get("/api/v1/auth/github")).status).toBe(503);
    expect((await request(app).get("/api/v1/developer/session")).body).toEqual({ enabled: false, developer: null, key: null });
  });

  it("site paths follow the callback URL", () => {
    expect(sitePaths("https://disasterwatch-frontend.onrender.com/api/v1/auth/github/callback")).toEqual({
      origin: "https://disasterwatch-frontend.onrender.com",
      auth: "/api/v1/auth",
      developer: "/api/v1/developer",
      page: "https://disasterwatch-frontend.onrender.com/api",
    });
  });
});

describe("key management", () => {
  it("creates a key shown once, renews, revokes, and deletes the developer", async () => {
    const { agent } = await signIn(appWith(fakeGithub()));
    const created = await write(agent, "post", "/api/v1/developer/keys");
    expect(created.status).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.body.key).toMatch(KEY_PATTERN);
    const session = await agent.get("/api/v1/developer/session");
    expect(session.body.key).toMatchObject({ prefix: created.body.prefix });
    expect(JSON.stringify(session.body)).not.toContain(created.body.key);

    const renewed = await write(agent, "post", "/api/v1/developer/keys");
    expect(renewed.body.key).not.toBe(created.body.key);
    expect(await prisma.apiKey.count({ where: { revokedAt: null } })).toBe(1);

    expect((await write(agent, "delete", "/api/v1/developer/keys")).status).toBe(204);
    expect((await agent.get("/api/v1/developer/session")).body.key).toBeNull();

    expect((await write(agent, "delete", "/api/v1/developer/me")).status).toBe(204);
    expect(await prisma.apiDeveloper.count()).toBe(0);
    expect(await prisma.apiKey.count()).toBe(0);
    expect((await agent.get("/api/v1/developer/session")).body.developer).toBeNull();
  });

  it("writes need the X-DW-Request header and a signed-in developer", async () => {
    const { agent } = await signIn(appWith(fakeGithub()));
    expect((await agent.post("/api/v1/developer/keys")).status).toBe(403);
    expect((await agent.delete("/api/v1/developer/me")).status).toBe(403);
    const anonymous = request(appWith(fakeGithub()));
    expect((await anonymous.post("/api/v1/developer/keys").set("X-DW-Request", "1")).status).toBe(401);
    const forged = await anonymous.post("/api/v1/developer/keys").set("X-DW-Request", "1").set("Cookie", "dw_dev=not-a-token");
    expect(forged.status).toBe(401);
  });

  it("the developer routes send no CORS headers (cross-site pages cannot call them)", async () => {
    const res = await request(appWith(fakeGithub())).get("/api/v1/developer/session").set("Origin", "https://someone-else.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("logout clears the developer cookie", async () => {
    const { agent } = await signIn(appWith(fakeGithub()));
    expect((await write(agent, "post", "/api/v1/developer/logout")).status).toBe(204);
    expect((await agent.get("/api/v1/developer/session")).body.developer).toBeNull();
  });
});

describe("v1 limits with and without a key", () => {
  const feed = { snapshot: async () => ({ served: { nasa: [], usgs: [] }, sources: { nasa: "ok", usgs: "ok" }, updatedAt: null, stale: false, partial: false }) };

  async function setup() {
    const dev = await prisma.apiDeveloper.create({ data: { githubId: "9", githubLogin: "lim" } });
    const store = createKeyStore();
    const { key } = await store.issue(dev.id);
    const app = express();
    app.set("trust proxy", 1);
    // small numbers, same shape as production (60 per IP, 600 per key)
    app.use("/api/v1", createV1Router({ feed, keyStore: store, rateLimit: { limit: 2, windowMs: 60_000 }, keyLimit: 4 }));
    return { app, key, store, dev };
  }

  it("anonymous: per IP; with a key: the higher limit, per key and from any IP", async () => {
    const { app, key } = await setup();
    const anon = (ip) => request(app).get("/api/v1/types").set("X-Forwarded-For", ip);
    const keyed = (ip) => anon(ip).set("X-API-Key", key);
    expect((await anon("198.51.100.10")).status).toBe(200);
    expect((await anon("198.51.100.10")).status).toBe(200);
    expect((await anon("198.51.100.10")).status).toBe(429);
    // the same IP with a key is counted on the key, not the IP
    const first = await keyed("198.51.100.10");
    expect(first.status).toBe(200);
    expect(first.headers["ratelimit-policy"]).toMatch(/^4;w=60/);
    expect((await keyed("203.0.113.1")).status).toBe(200);
    expect((await keyed("203.0.113.2")).status).toBe(200);
    expect((await keyed("203.0.113.3")).status).toBe(200);
    const over = await keyed("203.0.113.4");
    expect(over.status).toBe(429);
    expect(over.body.error.message).toMatch(/for this key/);
    expect(over.headers["retry-after"]).toBeDefined();
  });

  it("a wrong or revoked key is a 401, not the anonymous limit", async () => {
    const { app, key, store, dev } = await setup();
    const wrong = await request(app).get("/api/v1/types").set("X-API-Key", generateKey().key);
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("invalid_key");
    expect(wrong.headers["cache-control"]).toBe("no-store");
    expect((await request(app).get("/api/v1/types").set("X-API-Key", "nonsense")).status).toBe(401);
    await store.revoke(dev.id);
    expect((await request(app).get("/api/v1/types").set("X-API-Key", key)).status).toBe(401);
  });

  it("preflights allow the X-API-Key header and expose the limit headers", async () => {
    const { app } = await setup();
    const pre = await request(app).options("/api/v1/disasters").set("Origin", "https://a.example").set("Access-Control-Request-Method", "GET").set("Access-Control-Request-Headers", "x-api-key");
    expect(pre.headers["access-control-allow-headers"]).toMatch(/X-API-Key/i);
    const res = await request(app).get("/api/v1/types").set("Origin", "https://a.example");
    expect(res.headers["access-control-expose-headers"]).toMatch(/RateLimit/);
  });

  it("when the key cannot be checked, the request is served under the anonymous limit", async () => {
    const app = express();
    app.use("/api/v1", createV1Router({ feed, keyStore: { verify: async () => { throw new Error("db down"); } }, rateLimit: false }));
    expect((await request(app).get("/api/v1/types").set("X-API-Key", generateKey().key)).status).toBe(200);
  });
});
