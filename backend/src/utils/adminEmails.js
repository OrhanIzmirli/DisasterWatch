/**
 * Admin role assignment is driven entirely by the ADMIN_EMAILS environment
 * variable: a comma-separated list of e-mail addresses. Comparison is
 * case-insensitive and ignores surrounding whitespace.
 *
 *   ADMIN_EMAILS=owner@example.com, ops@example.com
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

/** Role a user with this e-mail should have right now. */
export function roleForEmail(email, adminEmails = parseAdminEmails()) {
  return isAdminEmail(email, adminEmails) ? "admin" : "user";
}
