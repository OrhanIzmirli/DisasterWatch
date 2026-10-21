/**
 * Admin role assignment is driven by the ADMIN_EMAILS environment variable:
 * a comma-separated list of e-mail addresses. Comparison is case-insensitive
 * and ignores surrounding whitespace.
 *
 *   ADMIN_EMAILS=owner@example.com, ops@example.com
 *
 * Registration does not prove that someone owns an address, and a click on
 * the confirmation link proves only the mailbox, not who registered the
 * account. A listed address is therefore an admin only once the link was
 * opened while signed in to that very account (emailConfirmedSignedInAt).
 * Otherwise someone could register a listed address before its owner, and the
 * owner's click on the e-mail, or adding the address to the list later, would
 * hand them the admin console.
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

/** Role a user should have right now: listed in ADMIN_EMAILS and confirmed while signed in. */
export function roleFor(user, adminEmails = parseAdminEmails()) {
  return user?.emailConfirmedSignedInAt && isAdminEmail(user.email, adminEmails) ? "admin" : "user";
}
