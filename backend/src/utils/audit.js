/**
 * Admin audit log. Every administrative action is recorded in the same
 * database transaction as the action itself, so the log can never show an
 * action that did not happen or miss one that did.
 */

export const AUDIT_ACTIONS = ["user.disable", "user.enable", "user.delete", "disaster.create"];

/** "someone@example.com" -> "som***@example.com": enough to recognise, not enough to identify. */
export function maskEmail(email) {
  const s = String(email ?? "");
  const at = s.lastIndexOf("@");
  if (at <= 0) return s ? `${s.slice(0, 3)}***` : "";
  return `${s.slice(0, Math.min(3, at))}***${s.slice(at)}`;
}

/**
 * Write one audit row. `tx` is a Prisma client or an interactive-transaction
 * client, so callers can include the row in their own transaction.
 */
export function writeAudit(tx, { actor, action, targetUserId = null, targetLabel, metadata = null }) {
  if (!AUDIT_ACTIONS.includes(action)) throw new Error(`Unknown audit action: ${action}`);
  return tx.adminAuditLog.create({
    data: {
      actorId: actor.id,
      actorEmail: actor.email,
      action,
      targetUserId,
      targetLabel: String(targetLabel ?? ""),
      metadata: metadata ?? undefined,
    },
  });
}
