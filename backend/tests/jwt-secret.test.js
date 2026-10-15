/**
 * JWT_SECRET validation: placeholders must never pass in production.
 * Pure unit tests (no database, no server).
 */
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { validateJwtSecret, EXAMPLE_JWT_SECRET, MIN_SECRET_LENGTH } from "../src/utils/jwt.js";

const prod = { isProduction: true };
const dev = { isProduction: false };
const randomSecret = () => crypto.randomBytes(48).toString("base64");

describe("validateJwtSecret", () => {
  it("accepts a random 48-byte secret in production", () => {
    expect(validateJwtSecret(randomSecret(), prod)).toBeNull();
  });

  it("accepts the .env.example placeholder outside production", () => {
    expect(validateJwtSecret(EXAMPLE_JWT_SECRET, dev)).toBeNull();
  });

  it("rejects the .env.example placeholder in production", () => {
    expect(validateJwtSecret(EXAMPLE_JWT_SECRET, prod)).toMatch(/placeholder from backend\/\.env\.example/);
  });

  it('rejects any production secret containing "change-me" / "change_me" / "change me", case-insensitively', () => {
    const long = "x".repeat(MIN_SECRET_LENGTH);
    for (const s of [`${long}change-me`, `${long}CHANGE_ME${long}`, `Change Me ${long}`, `${long}changeme`]) {
      expect(validateJwtSecret(s, prod), s).toMatch(/placeholder/);
    }
  });

  it("still rejects a missing, CHANGE_ME or short secret in production", () => {
    expect(validateJwtSecret(undefined, prod)).toMatch(/not set/);
    expect(validateJwtSecret("CHANGE_ME", prod)).toMatch(/CHANGE_ME/);
    expect(validateJwtSecret("short", prod)).toMatch(/too short/);
  });

  it("keeps warning (not rejecting) about a missing or short secret in development", () => {
    // the caller treats a non-null problem as a warning outside production
    expect(validateJwtSecret(undefined, dev)).toMatch(/not set/);
    expect(validateJwtSecret(`${"y".repeat(40)}change-me`, dev)).toBeNull();
  });

  it("matches the value shipped in backend/.env.example", () => {
    const envExample = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.example");
    const parsed = dotenv.parse(fs.readFileSync(envExample, "utf8"));
    expect(parsed.JWT_SECRET).toBe(EXAMPLE_JWT_SECRET);
    expect(parsed.JWT_SECRET.length).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH);
    expect(parsed.NODE_ENV).not.toBe("production");
  });
});
