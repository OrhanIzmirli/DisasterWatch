/**
 * Runs in every worker before each test file is imported.
 *
 * Order matters: env must be fixed BEFORE src/prisma.js and src/utils/jwt.js
 * are imported anywhere, because both read process.env at module load.
 */
import { beforeAll, afterAll } from "vitest";
import { resolveTestDatabaseUrl } from "./test-db.js";

const testDatabaseUrl = resolveTestDatabaseUrl();

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = testDatabaseUrl;
process.env.TEST_DATABASE_URL = testDatabaseUrl;
process.env.JWT_SECRET = "disasterwatch-test-jwt-secret-do-not-use-in-prod";
process.env.JWT_EXPIRES_IN = "1d";
process.env.COOKIE_NAME = "dw_session";
// Admin role is driven by this list; tests override it per case where needed
process.env.ADMIN_EMAILS = "admin@example.com";
// Never let a test reach a real broker, even if the Kafka module is not mocked
process.env.KAFKA_BROKER = "localhost:1";

const { default: prisma } = await import("../src/prisma.js");

async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "NewsCache", "AdminAuditLog", "Notification", "IngestedEvent", "AlertSubscription", "Disaster", "User" RESTART IDENTITY CASCADE'
  );
}

beforeAll(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});
