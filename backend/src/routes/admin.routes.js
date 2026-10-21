/**
 * Admin console API: user management and the audit log.
 *
 * Design decisions (fixed):
 *  - no user creation here (invitations arrive with the e-mail PR);
 *  - roles are never changed here: ADMIN_EMAILS plus a confirmed address
 *    decide (utils/adminEmails.js roleFor);
 *  - disable and delete take effect immediately: disable bumps tokenVersion
 *    so every session of that user is rejected on its next request.
 *
 * Every mutation writes its AdminAuditLog row in the same transaction.
 */
import express from "express";
import { z } from "zod";
import prisma from "../prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware.js";
import { roleFor } from "../utils/adminEmails.js";
import { maskEmail, writeAudit } from "../utils/audit.js";
import { eraseAccount } from "../utils/accountDeletion.js";

const router = express.Router();

export const PAGE_SIZE = 20;
export const AUDIT_LIMIT = 100; // the audit endpoint exposes the last 100 rows, paginated

const idParam = z.coerce.number().int().positive();
const pageParam = z.coerce.number().int().positive().catch(1);

// Explicit field lists: the password hash never leaves the database layer.
const userListSelect = {
  id: true,
  email: true,
  emailVerifiedAt: true,
  createdAt: true,
  lastLoginAt: true,
  disabledAt: true,
  _count: { select: { subscriptions: true } },
};

const userDetailSelect = {
  ...userListSelect,
  _count: { select: { subscriptions: true, notifications: true } },
  subscriptions: {
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      type: true,
      minSeverity: true,
      radiusKm: true,
      active: true,
      createdAt: true,
    },
  },
};

function publicUser(u) {
  const { _count, subscriptions, emailVerifiedAt, ...rest } = u;
  return {
    ...rest,
    role: roleFor(u),
    subscriptionCount: _count?.subscriptions ?? 0,
    ...(subscriptions ? { subscriptions, notificationCount: _count?.notifications ?? 0 } : {}),
  };
}

/**
 * Accounts that must not be disabled or deleted: the actor and the admins (listed in
 * ADMIN_EMAILS with a confirmed address). An unconfirmed account that registered a
 * listed address is an ordinary account and can be removed.
 */
function protectedReason(actor, target) {
  if (target.id === actor.id) return "You cannot change your own account";
  if (roleFor(target) === "admin") return "Admin accounts are managed through ADMIN_EMAILS";
  return null;
}

router.use(requireAuth, requireAdmin);

/* ===========================
   GET /admin/users?q=&page=
=========================== */
router.get("/users", async (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const page = pageParam.parse(req.query.page);
  const where = q ? { email: { contains: q } } : {};

  try {
    const [total, items] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: userListSelect,
      }),
    ]);
    res.json({
      items: items.map(publicUser),
      page,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    });
  } catch (err) {
    console.error("ADMIN LIST USERS ERROR:", err?.message || err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===========================
   GET /admin/users/:id
=========================== */
router.get("/users/:id", async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ message: "Invalid user id" });

  try {
    const user = await prisma.user.findUnique({ where: { id: id.data }, select: userDetailSelect });
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error("ADMIN GET USER ERROR:", err?.message || err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===========================
   POST /admin/users/:id/disable | /enable
=========================== */
async function setDisabled(req, res, disabled) {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ message: "Invalid user id" });

  try {
    const target = await prisma.user.findUnique({ where: { id: id.data }, select: { id: true, email: true, emailVerifiedAt: true, disabledAt: true } });
    if (!target) return res.status(404).json({ message: "User not found" });

    if (disabled) {
      const reason = protectedReason(req.user, target);
      if (reason) return res.status(403).json({ message: reason });
    }

    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: target.id },
        // Disabling bumps tokenVersion: every existing session is rejected on its next request.
        data: disabled ? { disabledAt: new Date(), tokenVersion: { increment: 1 } } : { disabledAt: null },
        select: userListSelect,
      });
      await writeAudit(tx, {
        actor: req.user,
        action: disabled ? "user.disable" : "user.enable",
        targetUserId: target.id,
        targetLabel: target.email,
        metadata: disabled ? { previouslyDisabled: target.disabledAt !== null } : null,
      });
      return updated;
    });

    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error("ADMIN SET DISABLED ERROR:", err?.message || err);
    res.status(500).json({ message: "Server error" });
  }
}

router.post("/users/:id/disable", (req, res) => setDisabled(req, res, true));
router.post("/users/:id/enable", (req, res) => setDisabled(req, res, false));

/* ===========================
   DELETE /admin/users/:id   body: { confirmEmail }
=========================== */
router.delete("/users/:id", async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ message: "Invalid user id" });

  const confirmEmail = String(req.body?.confirmEmail ?? "").trim().toLowerCase();

  try {
    const target = await prisma.user.findUnique({
      where: { id: id.data },
      select: { id: true, email: true, emailVerifiedAt: true, _count: { select: { subscriptions: true, notifications: true } } },
    });
    if (!target) return res.status(404).json({ message: "User not found" });

    const reason = protectedReason(req.user, target);
    if (reason) return res.status(403).json({ message: reason });

    if (!confirmEmail || confirmEmail !== target.email.toLowerCase()) {
      return res.status(400).json({ message: "confirmEmail must match the user's e-mail address" });
    }

    await prisma.$transaction(async (tx) => {
      // subscriptions and notifications go with the user, e-mail records are anonymised
      await eraseAccount(tx, target);
      await writeAudit(tx, {
        actor: req.user,
        action: "user.delete",
        targetUserId: target.id,
        targetLabel: maskEmail(target.email),
        metadata: {
          subscriptionsDeleted: target._count.subscriptions,
          notificationsDeleted: target._count.notifications,
        },
      });
    });

    res.json({ ok: true, deletedUserId: target.id });
  } catch (err) {
    console.error("ADMIN DELETE USER ERROR:", err?.message || err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===========================
   GET /admin/audit?page=   (last 100 rows, 20 per page)
=========================== */
router.get("/audit", async (req, res) => {
  const page = pageParam.parse(req.query.page);
  try {
    const totalRows = await prisma.adminAuditLog.count();
    const total = Math.min(totalRows, AUDIT_LIMIT);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const skip = (page - 1) * PAGE_SIZE;
    const items =
      skip >= total
        ? []
        : await prisma.adminAuditLog.findMany({
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip,
            take: Math.min(PAGE_SIZE, total - skip),
          });
    res.json({ items, page, pageSize: PAGE_SIZE, total, totalPages });
  } catch (err) {
    console.error("ADMIN AUDIT ERROR:", err?.message || err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
