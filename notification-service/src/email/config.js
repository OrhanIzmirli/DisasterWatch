/**
 * E-mail settings from the environment. E-mail is "configured" only when
 * every required value is present; otherwise the dispatcher does nothing and
 * the Alerts page says e-mail is not available. Values are never logged or
 * exposed; `missing` lists variable names only.
 *
 *   RESEND_API_KEY     Resend API key (secret)
 *   RESEND_FROM        sender, e.g. "DisasterWatch <onboarding@resend.dev>"
 *   APP_URL            public site URL used in links, e.g. https://example.onrender.com
 *   EMAIL_DAILY_LIMIT  digests per rolling 24 h (default 90; Resend free plan: 100/day)
 */
export const DEFAULT_DAILY_LIMIT = 90;
const REQUIRED = ["RESEND_API_KEY", "RESEND_FROM", "APP_URL"];

export function readEmailConfig(env = process.env) {
  const get = (name) => String(env[name] ?? "").trim();
  const missing = REQUIRED.filter((name) => !get(name));
  let appUrl = get("APP_URL").replace(/\/+$/, "");
  if (appUrl && !/^https?:\/\/[^/\s]+/i.test(appUrl)) {
    missing.push("APP_URL");
    appUrl = "";
  }
  const limit = Number.parseInt(get("EMAIL_DAILY_LIMIT"), 10);
  return {
    configured: missing.length === 0,
    missing,
    apiKey: get("RESEND_API_KEY"),
    from: get("RESEND_FROM"),
    appUrl,
    dailyLimit: Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_DAILY_LIMIT,
  };
}
