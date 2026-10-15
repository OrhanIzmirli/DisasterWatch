import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveTestDatabaseUrl,
  assertNoRealUsers,
  hostKey,
  endpointLabel,
  DEFAULT_ENV_FILE,
} from "./test-db.js";
import { prisma } from "./helpers.js";

const PROD = "postgresql://u:p@ep-prod-example-a1b2c3.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require";
const PROD_POOLER =
  "postgresql://u:p@ep-prod-example-a1b2c3-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require";
const TEST = "postgresql://u:p@ep-test-example-d4e5f6.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require";

// A .env file that does not exist, so the "env only" cases are not influenced by backend/.env
const NO_ENV_FILE = path.join(os.tmpdir(), "dw-does-not-exist.env");

describe("resolveTestDatabaseUrl (URL guard)", () => {
  it("(a) throws when TEST_DATABASE_URL is not set", () => {
    expect(() => resolveTestDatabaseUrl({ env: {}, envFile: NO_ENV_FILE })).toThrow(
      /TEST_DATABASE_URL is not set/
    );
    // whitespace-only counts as unset
    expect(() =>
      resolveTestDatabaseUrl({ env: { TEST_DATABASE_URL: "   " }, envFile: NO_ENV_FILE })
    ).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it("never falls back to DATABASE_URL", () => {
    expect(() =>
      resolveTestDatabaseUrl({ env: { DATABASE_URL: TEST }, envFile: NO_ENV_FILE })
    ).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it("(b) throws when TEST_DATABASE_URL equals DATABASE_URL", () => {
    expect(() =>
      resolveTestDatabaseUrl({
        env: { TEST_DATABASE_URL: PROD, DATABASE_URL: PROD },
        envFile: NO_ENV_FILE,
      })
    ).toThrow(/identical to DATABASE_URL/);
  });

  it("(c) throws when TEST_DATABASE_URL is the pooler twin of DATABASE_URL (either way round)", () => {
    expect(() =>
      resolveTestDatabaseUrl({
        env: { TEST_DATABASE_URL: PROD_POOLER, DATABASE_URL: PROD },
        envFile: NO_ENV_FILE,
      })
    ).toThrow(/same database host/);

    expect(() =>
      resolveTestDatabaseUrl({
        env: { TEST_DATABASE_URL: PROD, DATABASE_URL: PROD_POOLER },
        envFile: NO_ENV_FILE,
      })
    ).toThrow(/same database host/);
  });

  it("(d) reads DATABASE_URL from the .env file when the environment has none", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-env-"));
    const envFile = path.join(dir, ".env");
    fs.writeFileSync(envFile, `PORT=5000\nDATABASE_URL="${PROD}"\nJWT_SECRET=x\n`);

    try {
      // same host via the pooler twin, DATABASE_URL only in .env -> caught
      expect(() =>
        resolveTestDatabaseUrl({ env: { TEST_DATABASE_URL: PROD_POOLER }, envFile })
      ).toThrow(/same database host.*read from .*\.env/);

      // identical string, DATABASE_URL only in .env -> caught
      expect(() => resolveTestDatabaseUrl({ env: { TEST_DATABASE_URL: PROD }, envFile })).toThrow(
        /identical to DATABASE_URL/
      );

      // a genuinely different host passes
      expect(resolveTestDatabaseUrl({ env: { TEST_DATABASE_URL: TEST }, envFile })).toBe(TEST);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not modify process.env while reading the .env file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-env-"));
    const envFile = path.join(dir, ".env");
    fs.writeFileSync(envFile, `DATABASE_URL="${PROD}"\nSOME_OTHER_VAR=leak\n`);
    const before = process.env.SOME_OTHER_VAR;

    try {
      expect(resolveTestDatabaseUrl({ env: { TEST_DATABASE_URL: TEST }, envFile })).toBe(TEST);
      expect(process.env.SOME_OTHER_VAR).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a distinct test database and rejects malformed URLs", () => {
    expect(
      resolveTestDatabaseUrl({
        env: { TEST_DATABASE_URL: TEST, DATABASE_URL: PROD },
        envFile: NO_ENV_FILE,
      })
    ).toBe(TEST);

    expect(() =>
      resolveTestDatabaseUrl({ env: { TEST_DATABASE_URL: "not a url" }, envFile: NO_ENV_FILE })
    ).toThrow(/not a valid/);
  });

  it("the table list truncated before each file covers every model in the schema", () => {
    const schema = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "schema.prisma"), "utf8");
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]).sort();
    const helpers = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers.js"), "utf8");
    const truncated = [...helpers.matchAll(/"(\w+)"/g)].map((m) => m[1]).filter((t) => models.includes(t)).sort();
    expect(truncated).toEqual(models);
  });

  it("the TEST_DATABASE_URL of this run is not the app database from backend/.env", () => {
    // setup.js overwrites DATABASE_URL in the worker with the test URL, so the
    // comparison here is made against backend/.env only (as the global setup
    // does on a machine without DATABASE_URL in the environment).
    const env = { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL };
    expect(resolveTestDatabaseUrl({ env, envFile: DEFAULT_ENV_FILE })).toBe(
      process.env.TEST_DATABASE_URL
    );
  });

  it("hostKey and endpointLabel", () => {
    expect(hostKey(PROD)).toBe(hostKey(PROD_POOLER));
    expect(hostKey(PROD)).not.toBe(hostKey(TEST));
    expect(endpointLabel(PROD_POOLER)).toBe("ep-prod-example-a1b2c3-pooler");
    expect(endpointLabel("postgresql://postgres:postgres@localhost:5432/x")).toBe("localhost");
  });
});

describe("assertNoRealUsers (data guard)", () => {
  // Runs in a throwaway schema of the test database, so the main "public"
  // schema used by the other suites is never touched.
  const SCHEMA = "dw_guard_probe";
  const probeUrl = (() => {
    const u = new URL(process.env.TEST_DATABASE_URL);
    u.searchParams.set("schema", SCHEMA);
    return u.toString();
  })();

  const sql = (q) => prisma.$executeRawUnsafe(q);

  afterAll(async () => {
    await sql(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  });

  it("passes when the User table does not exist", async () => {
    await sql(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql(`CREATE SCHEMA "${SCHEMA}"`);
    await expect(assertNoRealUsers(probeUrl)).resolves.toEqual({ checked: false, realUsers: 0 });
  });

  it("passes when every user has an @example.com address", async () => {
    await sql(`CREATE TABLE "${SCHEMA}"."User" (id serial PRIMARY KEY, email text NOT NULL)`);
    await sql(
      `INSERT INTO "${SCHEMA}"."User" (email) VALUES ('alice@example.com'), ('Bob@Example.com')`
    );
    await expect(assertNoRealUsers(probeUrl)).resolves.toEqual({ checked: true, realUsers: 0 });
  });

  it("(e) stops when the database contains a user with a real e-mail address", async () => {
    await sql(`INSERT INTO "${SCHEMA}"."User" (email) VALUES ('owner@example.org')`);
    await expect(assertNoRealUsers(probeUrl)).rejects.toThrow(
      /contains 1 user\(s\).*looks like a real \(production\) database/
    );
  });

  it("rejects schema names it cannot quote safely", async () => {
    const bad = new URL(process.env.TEST_DATABASE_URL);
    bad.searchParams.set("schema", 'x"; DROP TABLE "User"; --');
    await expect(assertNoRealUsers(bad.toString())).rejects.toThrow(/Unsupported schema name/);
  });
});

describe("test accounts", () => {
  it("every e-mail the suites register ends in @example.com", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js") || f === "helpers.js");
    const emails = new Set();
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      for (const m of src.matchAll(/"([A-Za-z0-9._+-]+@[A-Za-z0-9.-]+)"/g)) emails.add(m[1]);
    }
    // the one deliberately "real" address lives in the data-guard test above
    emails.delete("owner@example.org");
    expect(emails.size).toBeGreaterThan(5);
    for (const e of emails) expect(e.toLowerCase().endsWith("@example.com"), e).toBe(true);
  });
});
