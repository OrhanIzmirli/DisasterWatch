import express from "express";
import { z } from "zod";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const router = express.Router();

const MAX_SUBSCRIPTIONS_PER_USER = 20;

const TYPES = ["any", "earthquake", "flood", "wildfire", "storm"];
const SEVERITIES = ["low", "medium", "high"];

const subscriptionFields = {
  type: z.enum(TYPES),
  minSeverity: z.enum(SEVERITIES),
  label: z.string().trim().min(1).max(60),
  centerLat: z.number().min(-90).max(90),
  centerLng: z.number().min(-180).max(180),
  radiusKm: z.number().int().min(10).max(5000),
  active: z.boolean(),
};

const createSchema = z.object({
  ...subscriptionFields,
  type: subscriptionFields.type.default("any"),
  minSeverity: subscriptionFields.minSeverity.default("low"),
  active: subscriptionFields.active.default(true),
});

// Every field optional, but at least one must be present
const updateSchema = z
  .object(subscriptionFields)
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "No fields to update",
  });

const idParam = z.coerce.number().int().positive();

function validationMessage(error) {
  const issue = error.issues[0];
  if (!issue) return "Invalid input";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

// All alert routes require a signed-in user
router.use(requireAuth);

/* ===========================
   GET /alerts — my subscriptions
=========================== */
router.get("/", async (req, res) => {
  try {
    const items = await prisma.alertSubscription.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({ items, count: items.length });
  } catch (err) {
    console.error("LIST ALERTS ERROR:", err?.message || err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===========================
   POST /alerts — create
=========================== */
router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: validationMessage(parsed.error) });
  }

  try {
    const count = await prisma.alertSubscription.count({
      where: { userId: req.user.id },
    });
    if (count >= MAX_SUBSCRIPTIONS_PER_USER) {
      return res.status(400).json({
        message: `You can have at most ${MAX_SUBSCRIPTIONS_PER_USER} alert subscriptions.`,
      });
    }

    const subscription = await prisma.alertSubscription.create({
      data: { ...parsed.data, userId: req.user.id },
    });

    res.status(201).json({ message: "Alert subscription created", subscription });
  } catch (err) {
    console.error("CREATE ALERT ERROR:", err?.message || err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===========================
   PATCH /alerts/:id — update
=========================== */
router.patch("/:id", async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) {
    return res.status(404).json({ message: "Alert subscription not found" });
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: validationMessage(parsed.error) });
  }

  try {
    // Scoped by userId: a subscription owned by someone else looks like it doesn't exist
    const result = await prisma.alertSubscription.updateMany({
      where: { id: id.data, userId: req.user.id },
      data: parsed.data,
    });

    if (result.count === 0) {
      return res.status(404).json({ message: "Alert subscription not found" });
    }

    const subscription = await prisma.alertSubscription.findFirst({
      where: { id: id.data, userId: req.user.id },
    });

    res.json({ message: "Alert subscription updated", subscription });
  } catch (err) {
    console.error("UPDATE ALERT ERROR:", err?.message || err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===========================
   DELETE /alerts/:id
=========================== */
router.delete("/:id", async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) {
    return res.status(404).json({ message: "Alert subscription not found" });
  }

  try {
    const result = await prisma.alertSubscription.deleteMany({
      where: { id: id.data, userId: req.user.id },
    });

    if (result.count === 0) {
      return res.status(404).json({ message: "Alert subscription not found" });
    }

    res.json({ message: "Alert subscription deleted", id: id.data });
  } catch (err) {
    console.error("DELETE ALERT ERROR:", err?.message || err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
