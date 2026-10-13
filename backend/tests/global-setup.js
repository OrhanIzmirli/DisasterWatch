import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTestDatabaseUrl, assertNoRealUsers, endpointLabel } from "./test-db.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Runs once per `vitest` invocation, before any worker starts.
 *
 *  1. URL guard: TEST_DATABASE_URL must exist and must not be the app DB
 *     (compared against DATABASE_URL from the env or backend/.env).
 *  2. Data guard: the target's "User" table must not contain real accounts.
 *  3. Only then is the Prisma schema pushed to the test database.
 */
export default async function globalSetup() {
  const testDatabaseUrl = resolveTestDatabaseUrl();

  // Printed so the person running the tests can eyeball the target endpoint.
  console.log(`[tests] target database endpoint: ${endpointLabel(testDatabaseUrl)}`);

  const guard = await assertNoRealUsers(testDatabaseUrl);
  console.log(
    guard.checked
      ? "[tests] User table checked: no non-test accounts found"
      : "[tests] User table not present yet (fresh database)"
  );

  console.log("[tests] applying Prisma schema to the test database");

  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    cwd: backendRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      // Prisma CLI reads DATABASE_URL (and backend/.env); the explicit env wins.
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: "test",
    },
  });
}
