/**
 * Deleting an account (the user themselves, or an admin). Run inside one
 * transaction:
 *  - subscriptions and notifications go with the user (onDelete: Cascade);
 *  - e-mail delivery rows stay, anonymised: the message, the provider id and
 *    the error are removed and the user link is set to null (onDelete: SetNull).
 *    The rows must stay because the daily limit and the confirmation cap are
 *    counted from them; deleting them would let anyone reset the limits by
 *    re-registering (register someone's address, send a confirmation, delete,
 *    repeat). A delivery still pending is cancelled first, so it is never sent;
 *  - audit rows about the account keep only the masked address, and manual
 *    disaster entries it made as an admin keep only the masked address too.
 */
import { Prisma } from "@prisma/client";
import { maskEmail } from "./audit.js";

export async function eraseAccount(tx, user) {
  const masked = maskEmail(user.email);
  await tx.emailDelivery.updateMany({ where: { userId: user.id, status: "pending" }, data: { status: "cancelled", leaseUntil: null } });
  await tx.emailDelivery.updateMany({
    where: { userId: user.id },
    data: { payload: Prisma.DbNull, providerMessageId: null, lastError: null },
  });
  await tx.adminAuditLog.updateMany({ where: { targetUserId: user.id }, data: { targetLabel: masked } });
  await tx.disaster.updateMany({ where: { createdBy: user.email }, data: { createdBy: masked } });
  await tx.user.delete({ where: { id: user.id } });
}
