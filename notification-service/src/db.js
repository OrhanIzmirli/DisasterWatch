/**
 * Postgres access for the consumer, via `pg` (no Prisma here: the backend
 * owns the schema; this service only reads AlertSubscription and writes
 * Notification). Column names are the Prisma ones, hence the quoting.
 */
import pg from "pg";

const { Pool } = pg;

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set; the notification service needs the app database");
  }
  // Neon and other hosted Postgres require TLS; local docker-compose does not.
  const ssl = /sslmode=require|neon\.tech/.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined;
  return new Pool({ connectionString, ssl, max: 3 });
}

/** All active subscriptions with the fields the matcher needs. */
export async function loadActiveSubscriptions(pool) {
  const { rows } = await pool.query(
    `SELECT "id", "userId", "type", "minSeverity", "label",
            "centerLat", "centerLng", "radiusKm", "active", "createdAt"
       FROM "AlertSubscription"
      WHERE "active" = true`
  );
  return rows;
}

/**
 * Inserts notification rows; duplicates for (userId, eventId) are ignored.
 * Returns the number of rows actually inserted.
 */
export async function insertNotifications(pool, rows) {
  if (!rows.length) return 0;

  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const base = i * 10;
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`
    );
    params.push(
      r.userId,
      r.subscriptionId ?? null,
      r.eventId,
      r.title,
      r.type,
      r.severity,
      r.lat,
      r.lng,
      r.distanceKm,
      new Date(r.occurredAt)
    );
  });

  const { rowCount } = await pool.query(
    `INSERT INTO "Notification"
       ("userId", "subscriptionId", "eventId", "title", "type", "severity", "lat", "lng", "distanceKm", "occurredAt")
     VALUES ${values.join(", ")}
     ON CONFLICT ("userId", "eventId") DO NOTHING`,
    params
  );
  return rowCount ?? 0;
}
