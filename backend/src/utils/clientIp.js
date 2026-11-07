/**
 * The client's IP address behind Render.
 *
 * Every *.onrender.com request passes Cloudflare and then several Render hops; the
 * site's /api rewrite adds more. X-Forwarded-For therefore ends in a changing
 * internal hop (what req.ip returns with trust proxy 1) and starts with whatever
 * the client wrote into it, so neither end identifies the client. Measured live
 * on 2026-11-07, direct and through the rewrite:
 *  - True-Client-IP holds the client address; a value sent by the client is overwritten.
 *  - CF-Connecting-IP holds it too; a request that sends its own is rejected (403).
 * So these two are used, in that order, and req.ip only when neither is present
 * (local runs and tests, which have no Cloudflare in front).
 */
import { isIP } from "node:net";

export const CLIENT_IP_HEADERS = ["True-Client-IP", "CF-Connecting-IP"];

/** @param {import("express").Request} req */
export function clientIp(req) {
  for (const name of CLIENT_IP_HEADERS) {
    const value = req.get(name)?.trim();
    if (value && isIP(value)) return value;
  }
  return req.ip;
}

/**
 * Middleware: make req.ip the client address for everything after it (every
 * rate limiter keys on req.ip). Mounted first in app.js.
 */
export function useClientIp(req, res, next) {
  Object.defineProperty(req, "ip", { value: clientIp(req), configurable: true, enumerable: true });
  next();
}
