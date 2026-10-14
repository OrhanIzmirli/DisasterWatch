/**
 * Disaster event contract (v1) — the single message shape on the Kafka topic
 * `disaster-events`. The producer (backend) validates before publishing and
 * the consumer (notification-service) validates before matching.
 *
 * Keep this file identical to notification-service/src/contract.js: the two
 * services are built from separate root directories on Render, so they
 * cannot share a module.
 */
import { z } from "zod";

export const TOPIC = "disaster-events";

export const EVENT_SOURCES = ["nasa", "usgs", "manual"];
export const SEVERITIES = ["low", "medium", "high"];

export const disasterEventSchema = z.object({
  v: z.literal(1),
  /** Stable id derived from the source: "nasa:EONET_1234", "usgs:us7000abcd", "manual:42" */
  eventId: z.string().regex(/^(nasa|usgs|manual):[A-Za-z0-9_.-]+$/, "eventId must look like source:id"),
  source: z.enum(EVENT_SOURCES),
  /** Lower-case hazard type, e.g. earthquake | flood | wildfire | storm */
  type: z.string().trim().toLowerCase().min(1).max(40),
  severity: z.enum(SEVERITIES),
  title: z.string().trim().min(1).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** ISO-8601 with timezone, e.g. 2026-10-13T10:00:00.000Z */
  occurredAt: z.iso.datetime({ offset: true }),
});

/** Parse-or-throw helper with a readable message. */
export function parseDisasterEvent(input) {
  const parsed = disasterEventSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.join(".") || "event";
    throw new Error(`Invalid disaster event: ${path}: ${issue?.message || "invalid"}`);
  }
  return parsed.data;
}

/** Clamp a free-form severity string to the contract values. */
export function normalizeSeverity(value, fallback = "medium") {
  const s = String(value ?? "").trim().toLowerCase();
  return SEVERITIES.includes(s) ? s : fallback;
}
