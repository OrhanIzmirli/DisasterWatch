/**
 * Guards that keep the test suite away from the application database.
 *
 * Layer 1 (URL based): resolveTestDatabaseUrl()
 *  - Tests use TEST_DATABASE_URL only. There is NO fallback to DATABASE_URL.
 *  - TEST_DATABASE_URL must be set, and must not equal DATABASE_URL.
 *  - The hosts must differ too (ignoring Neon's "-pooler" suffix), so the
 *    pooler/direct twin of the app database is caught as well.
 *  - When DATABASE_URL is not in the environment, backend/.env is parsed
 *    (without touching process.env) and its DATABASE_URL is compared too.
 *
 * Layer 2 (data based): assertNoRealUsers()
 *  - Before the schema is pushed or anything is truncated, the "User" table
 *    of the target database is inspected. Any account whose e-mail does not
 *    end in @example.com means "this is not a test database": stop.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_ENV_FILE = path.join(backendRoot, ".env");

export const TEST_EMAIL_DOMAIN = "@example.com";

/** DATABASE_URL from the environment, or from the .env file if the env has none. */
export function readAppDatabaseUrl({ env = process.env, envFile = DEFAULT_ENV_FILE } = {}) {
  const fromEnv = (env.DATABASE_URL || "").trim();
  if (fromEnv) return { url: fromEnv, source: "env" };

  try {
    const parsed = dotenv.parse(fs.readFileSync(envFile, "utf8"));
    const fromFile = (parsed.DATABASE_URL || "").trim();
    if (fromFile) return { url: fromFile, source: envFile };
  } catch {
    // no .env file: nothing to compare against
  }

  return { url: "", source: null };
}

export function resolveTestDatabaseUrl({ env = process.env, envFile = DEFAULT_ENV_FILE } = {}) {
  const testUrl = (env.TEST_DATABASE_URL || "").trim();
  const app = readAppDatabaseUrl({ env, envFile });

  if (!testUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Tests only ever run against a dedicated test " +
        "database and never fall back to DATABASE_URL. Point TEST_DATABASE_URL at a " +
        "throwaway Postgres (local container or a Neon test branch)."
    );
  }

  if (app.url && testUrl === app.url) {
    throw new Error(
      `TEST_DATABASE_URL is identical to DATABASE_URL (from ${app.source}). ` +
        "Refusing to run tests against the application database."
    );
  }

  const testHost = hostKey(testUrl);
  if (!testHost) {
    throw new Error("TEST_DATABASE_URL is not a valid postgres:// URL.");
  }

  const appHost = app.url ? hostKey(app.url) : null;
  if (appHost && testHost === appHost) {
    throw new Error(
      `TEST_DATABASE_URL points at the same database host as DATABASE_URL (${testHost}, ` +
        `DATABASE_URL read from ${app.source}). Refusing to run tests against the application database.`
    );
  }

  return testUrl;
}

export function hostKey(url) {
  try {
    const u = new URL(url);
    // Neon exposes the same branch as "<id>.region" and "<id>-pooler.region"
    return `${u.hostname.replace("-pooler", "")}${u.pathname}`.toLowerCase();
  } catch {
    return null;
  }
}

/** "ep-prod-example-a1b2c3" for a Neon host, "localhost" for a local one. */
export function endpointLabel(url) {
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return "<invalid url>";
  }
}

function schemaFromUrl(url) {
  const schema = new URL(url).searchParams.get("schema") || "public";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`Unsupported schema name in database URL: ${schema}`);
  }
  return schema;
}

/**
 * Connects to `databaseUrl` and refuses if its "User" table holds any account
 * whose e-mail does not end in @example.com. A missing table (fresh database)
 * passes. Returns { checked, realUsers }.
 */
export async function assertNoRealUsers(databaseUrl) {
  const schema = schemaFromUrl(databaseUrl);
  // Imported lazily: loading @prisma/client eagerly would read backend/.env
  // into process.env as a side effect, which the URL guard must not rely on.
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

  try {
    const [{ exists }] = await prisma.$queryRawUnsafe(
      `SELECT to_regclass('"${schema}"."User"') IS NOT NULL AS "exists"`
    );
    if (!exists) {
      return { checked: false, realUsers: 0 };
    }

    const [{ count }] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS "count" FROM "${schema}"."User" WHERE email NOT ILIKE $1`,
      `%${TEST_EMAIL_DOMAIN}`
    );

    if (count > 0) {
      throw new Error(
        `The database at ${endpointLabel(databaseUrl)} (schema "${schema}") contains ${count} user(s) ` +
          `whose e-mail does not end in ${TEST_EMAIL_DOMAIN}. This looks like a real (production) ` +
          "database, not a test one. Refusing to push the schema or truncate anything."
      );
    }

    return { checked: true, realUsers: 0 };
  } finally {
    await prisma.$disconnect();
  }
}
