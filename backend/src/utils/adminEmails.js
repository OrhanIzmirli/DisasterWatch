/**
 * Admin role assignment is driven by the ADMIN_EMAILS environment variable:
 * a comma-separated list of e-mail addresses. Comparison is case-insensitive
 * and ignores surrounding whitespace.
 *
 *   ADMIN_EMAILS=owner@example.com, ops@example.com
 *
 * Registration does not prove that someone owns an address, so a listed
 * address is an admin only once it is confirmed (emailVerifiedAt, set by the
 * double opt-in link). Otherwise anyone could register a listed address
 * before its owner and get the admin console.
 */

export function parseAdminEmails(value = process.env.ADMIN_EMAILS) {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isAdminEmail(email, adminEmails = parseAdminEmails()) {
  return adminEmails.has(String(email ?? "").trim().toLowerCase());
}

/** Role a user should have right now: listed in ADMIN_EMAILS and the address confirmed. */
export function roleFor(user, adminEmails = parseAdminEmails()) {
  return user?.emailVerifiedAt && isAdminEmail(user.email, adminEmails) ? "admin" : "user";
}
