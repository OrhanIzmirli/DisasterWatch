import request from "supertest";
import prisma from "../src/prisma.js";
import { createApp } from "../src/app.js";

export const COOKIE_NAME = "dw_session";
export const PASSWORD = "CorrectHorse1!";

/** App without the auth rate limiter, so tests can sign in as often as they like. */
export function createTestApp(options = {}) {
  return createApp({ authRateLimit: false, ...options });
}

/** Empties every table; ids restart from 1. */
export async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AdminAuditLog", "Notification", "IngestedEvent", "AlertSubscription", "Disaster", "User" RESTART IDENTITY CASCADE'
  );
}

/** Registers a user through the API and returns a cookie-carrying agent plus the response. */
export async function registerAgent(app, email, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post("/users/register").send({ email, password });
  return { agent, res };
}

/** Returns the Set-Cookie entry for the session cookie, or undefined. */
export function sessionCookie(res) {
  const header = res.headers["set-cookie"];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return list.find((c) => c.startsWith(`${COOKIE_NAME}=`));
}

export { prisma };
