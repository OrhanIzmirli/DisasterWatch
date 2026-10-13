import express from "express";
import { z } from "zod";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const router = express.Router();

const idParam = z.coerce.number().int().positive();

const notificationSelect = {
  id: true,
  eventId: true,
  title: true,
  type: true,
  severity: true,
  lat: true,
  lng: true,
  distanceKm: true,
  occurredAt: true,
  createdAt: true,
  readAt: true,
  subscriptionId: true,
  subscription: { select: { label: true } },
};

function publicNotification(n) {
  const { subscription, ...rest } = n;
  return { ...rest, subscriptionLabel: subscription?.label ?? null };
}

// All notification routes are scoped to the signed-in user
router.use(requireAuth);

/* ===========================
   GET /notifications — latest 50 + unread count
=========================== */
router.get("/", async (req, res) => {
  try {
    const [items, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.user.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
        select: notificationSelect,
      }),
      prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
    ]);

    res.json({ items: items.map(publicNotification), count: items.length, unreadCount });
  } catch (err) {
    console.error("LIST NOTIFICATIONS ERROR:", err?.message || err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===========================
   POST /notifications/:id/read
=========================== */
router.post("/:id/read", async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) {
    return res.status(404).json({ message: "Notification not found" });
  }

  try {
    // Scoped by userId: someone else's notification looks like it doesn't exist
    const result = await prisma.notification.updateMany({
      where: { id: id.data, userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });

    if (result.count === 0) {
      const exists = await prisma.notification.findFirst({
        where: { id: id.data, userId: req.user.id },
        select: { id: true },
      });
      if (!exists) {
        return res.status(404).json({ message: "Notification not found" });
      }
      // already read: idempotent success
    }

    const unreadCount = await prisma.notification.count({
      where: { userId: req.user.id, readAt: null },
    });
    res.json({ ok: true, id: id.data, unreadCount });
  } catch (err) {
    console.error("READ NOTIFICATION ERROR:", err?.message || err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===========================
   POST /notifications/read-all
=========================== */
router.post("/read-all", async (req, res) => {
  try {
    const result = await prisma.notification.updateMany({
      where: { userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ ok: true, marked: result.count, unreadCount: 0 });
  } catch (err) {
    console.error("READ ALL NOTIFICATIONS ERROR:", err?.message || err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
