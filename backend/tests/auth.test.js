import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import {
  createTestApp,
  resetDb,
  registerAgent,
  confirmAddress,
  sessionCookie,
  prisma,
  PASSWORD,
  COOKIE_NAME,
} from "./helpers.js";

const app = createTestApp();

describe("POST /users/register", () => {
  beforeEach(resetDb);

  it("never makes a new account an admin, not even an ADMIN_EMAILS address: registering does not prove the address", async () => {
    const { agent, res: listed } = await registerAgent(app, "admin@example.com");
    expect(listed.status).toBe(201);
    expect(listed.body.user).toMatchObject({ email: "admin@example.com", role: "user" });
    expect((await agent.get("/admin/users")).status).toBe(403);

    const unlisted = await request(app)
      .post("/users/register")
      .send({ email: "someone@example.com", password: PASSWORD });
    expect(unlisted.status).toBe(201);
    expect(unlisted.body.user).toMatchObject({ email: "someone@example.com", role: "user" });

    const rows = await prisma.user.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((u) => u.role)).toEqual(["user", "user"]);

    // once the listed address is confirmed it is an admin, in the same session
    await confirmAddress("admin@example.com");
    expect((await agent.get("/users/me")).body.user.role).toBe("admin");
    expect((await agent.get("/admin/users")).status).toBe(200);
  });

  it("matches ADMIN_EMAILS case-insensitively and ignores whitespace", async () => {
    process.env.ADMIN_EMAILS = "  Ops@Example.COM , other@example.com ";
    try {
      const { agent, res } = await registerAgent(app, "OPS@example.com");
      expect(res.status).toBe(201);
      await confirmAddress("ops@example.com");
      expect((await agent.get("/users/me")).body.user.role).toBe("admin");
    } finally {
      process.env.ADMIN_EMAILS = "admin@example.com";
    }
  });

  it("never grants admin when ADMIN_EMAILS is empty, even to the first account", async () => {
    process.env.ADMIN_EMAILS = "";
    try {
      const res = await request(app)
        .post("/users/register")
        .send({ email: "first@example.com", password: PASSWORD });
      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe("user");
    } finally {
      process.env.ADMIN_EMAILS = "admin@example.com";
    }
  });

  it("returns createdAt and subscriptionCount with the registered user", async () => {
    const res = await request(app)
      .post("/users/register")
      .send({ email: "profile@example.com", password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.user.subscriptionCount).toBe(0);
    expect(new Date(res.body.user.createdAt).toString()).not.toBe("Invalid Date");
  });

  it("sets the session cookie on registration", async () => {
    const res = await request(app)
      .post("/users/register")
      .send({ email: "cookie@example.com", password: PASSWORD });
    expect(res.status).toBe(201);
    expect(sessionCookie(res)).toMatch(/HttpOnly/i);
  });

  it("stores the email lower-cased and trimmed, and never stores the plain password", async () => {
    const res = await request(app)
      .post("/users/register")
      .send({ email: "  MiXeD@Example.COM ", password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe("mixed@example.com");

    const row = await prisma.user.findUnique({ where: { email: "mixed@example.com" } });
    expect(row).not.toBeNull();
    expect(row.password).not.toBe(PASSWORD);
    expect(row.password.startsWith("$2")).toBe(true); // bcrypt hash
  });

  it("returns 409 for an email that is already registered (case-insensitive)", async () => {
    await request(app)
      .post("/users/register")
      .send({ email: "dupe@example.com", password: PASSWORD });

    const again = await request(app)
      .post("/users/register")
      .send({ email: "DUPE@example.com", password: "AnotherPass123" });
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/already registered/i);
    expect(await prisma.user.count()).toBe(1);
  });

  it("returns 400 for an invalid email", async () => {
    const res = await request(app)
      .post("/users/register")
      .send({ email: "not-an-email", password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/email/i);
    expect(await prisma.user.count()).toBe(0);
  });

  it("returns 400 for a password shorter than 8 characters", async () => {
    const res = await request(app)
      .post("/users/register")
      .send({ email: "short@example.com", password: "1234567" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/8 characters/i);
    expect(await prisma.user.count()).toBe(0);
  });
});

describe("POST /users/login", () => {
  beforeEach(async () => {
    await resetDb();
    await registerAgent(app, "login@example.com");
  });

  it("returns 200 and an HttpOnly, SameSite=Lax session cookie for valid credentials", async () => {
    const res = await request(app)
      .post("/users/login")
      .send({ email: "login@example.com", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: "login@example.com", role: "user" });
    expect(res.body.user.subscriptionCount).toBe(0);

    const cookie = sessionCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
  });

  it("accepts the email in any case with surrounding whitespace", async () => {
    const res = await request(app)
      .post("/users/login")
      .send({ email: " LOGIN@example.com ", password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it("returns the same 401 message for a wrong password and for an unknown email", async () => {
    const wrongPassword = await request(app)
      .post("/users/login")
      .send({ email: "login@example.com", password: "WrongPassword1" });
    const unknownEmail = await request(app)
      .post("/users/login")
      .send({ email: "nobody@example.com", password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.message).toBe("Invalid email or password.");
    expect(unknownEmail.body.message).toBe(wrongPassword.body.message);
    expect(sessionCookie(wrongPassword)).toBeUndefined();
    expect(sessionCookie(unknownEmail)).toBeUndefined();
  });

  it("returns 400 when email or password is missing", async () => {
    const res = await request(app).post("/users/login").send({ email: "login@example.com" });
    expect(res.status).toBe(400);
  });
});

describe("POST /users/login keeps the role in sync with ADMIN_EMAILS and the confirmed address", () => {
  beforeEach(async () => {
    await resetDb();
    await registerAgent(app, "sync@example.com"); // not listed -> user
    await confirmAddress("sync@example.com");
  });

  afterEach(() => {
    process.env.ADMIN_EMAILS = "admin@example.com";
  });

  const login = () =>
    request(app).post("/users/login").send({ email: "sync@example.com", password: PASSWORD });

  it("promotes a user whose e-mail was added to the list", async () => {
    expect((await login()).body.user.role).toBe("user");

    process.env.ADMIN_EMAILS = "admin@example.com,sync@example.com";
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("admin");

    const row = await prisma.user.findUnique({ where: { email: "sync@example.com" } });
    expect(row.role).toBe("admin");
  });

  it("does not promote a listed address that was never confirmed", async () => {
    await prisma.user.update({ where: { email: "sync@example.com" }, data: { emailVerifiedAt: null, emailConfirmedSignedInAt: null } });
    process.env.ADMIN_EMAILS = "admin@example.com,sync@example.com";
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("user");
    expect((await prisma.user.findUnique({ where: { email: "sync@example.com" } })).role).toBe("user");
  });

  it("demotes an admin whose e-mail was removed from the list", async () => {
    await prisma.user.update({ where: { email: "sync@example.com" }, data: { role: "admin" } });

    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("user");

    const row = await prisma.user.findUnique({ where: { email: "sync@example.com" } });
    expect(row.role).toBe("user");
  });

  it("issues a session that reflects the synced role", async () => {
    process.env.ADMIN_EMAILS = "admin@example.com,sync@example.com";
    const agent = request.agent(app);
    await agent.post("/users/login").send({ email: "sync@example.com", password: PASSWORD });
    const me = await agent.get("/users/me");
    expect(me.body.user.role).toBe("admin");
  });
});

describe("GET /users/me", () => {
  beforeEach(resetDb);

  it("returns 401 without a cookie", async () => {
    const res = await request(app).get("/users/me");
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Not authenticated");
  });

  it("returns 401 for a garbage cookie", async () => {
    const res = await request(app).get("/users/me").set("Cookie", `${COOKIE_NAME}=not-a-jwt`);
    expect(res.status).toBe(401);
  });

  it("returns the user from the database, including createdAt and subscriptionCount", async () => {
    const { agent } = await registerAgent(app, "me@example.com");

    const res = await agent.get("/users/me");
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("me@example.com");
    expect(res.body.user.role).toBe("user");
    expect(res.body.user.subscriptionCount).toBe(0);
    expect(new Date(res.body.user.createdAt).toString()).not.toBe("Invalid Date");
  });

  it("works the role out on every request: a stored admin role alone grants nothing, a list change applies without re-login", async () => {
    const { agent } = await registerAgent(app, "promoted@example.com"); // not listed -> user
    expect((await agent.get("/users/me")).body.user.role).toBe("user");

    // a stored role (e.g. left over from before) is not enough
    await prisma.user.update({ where: { email: "promoted@example.com" }, data: { role: "admin" } });
    expect((await agent.get("/users/me")).body.user.role).toBe("user");
    expect((await agent.get("/admin/users")).status).toBe(403);

    await confirmAddress("promoted@example.com");
    process.env.ADMIN_EMAILS = "admin@example.com,promoted@example.com";
    try {
      expect((await agent.get("/users/me")).body.user.role).toBe("admin");
      expect((await agent.get("/admin/users")).status).toBe(200);
    } finally {
      process.env.ADMIN_EMAILS = "admin@example.com";
    }
    // removed from the list: the open session loses the console at once
    expect((await agent.get("/admin/users")).status).toBe(403);
  });

  it("returns 401 when the user behind a valid cookie no longer exists", async () => {
    const { agent } = await registerAgent(app, "gone@example.com");
    await prisma.user.delete({ where: { email: "gone@example.com" } });

    const res = await agent.get("/users/me");
    expect(res.status).toBe(401);
  });
});

describe("POST /users/logout", () => {
  beforeEach(resetDb);

  it("clears the session cookie so /me returns 401 afterwards", async () => {
    const { agent } = await registerAgent(app, "bye@example.com");
    expect((await agent.get("/users/me")).status).toBe(200);

    const res = await agent.post("/users/logout");
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).toMatch(new RegExp(`^${COOKIE_NAME}=;`));
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);

    expect((await agent.get("/users/me")).status).toBe(401);
  });
});
