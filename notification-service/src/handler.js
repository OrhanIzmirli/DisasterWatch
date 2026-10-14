/**
 * Processes one Kafka message. Dependencies are injected so it can be unit
 * tested without Kafka or Postgres.
 *
 *  - invalid JSON / contract violations: logged and skipped (returns
 *    { status: "invalid" }); the consumer must never get stuck on them;
 *  - database errors: thrown, so KafkaJS retries the message.
 */
import { disasterEventSchema } from "./contract.js";
import { buildNotifications } from "./match.js";

export function createMessageHandler({ loadSubscriptions, insertNotifications, log = console, now = () => new Date() }) {
  return async function handleMessage(rawValue) {
    let payload;
    try {
      payload = JSON.parse(rawValue);
    } catch {
      log.warn("[consumer] skipping message: not JSON");
      return { status: "invalid", reason: "not-json" };
    }

    const parsed = disasterEventSchema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      log.warn(
        `[consumer] skipping message: ${issue?.path?.join(".") || "event"}: ${issue?.message || "invalid"}`
      );
      return { status: "invalid", reason: "contract" };
    }
    const event = parsed.data;

    // DB errors propagate on purpose (see module comment)
    const subscriptions = await loadSubscriptions();
    const rows = buildNotifications(event, subscriptions, now());
    const inserted = rows.length ? await insertNotifications(rows) : 0;

    log.log(
      `[consumer] ${event.eventId} (${event.type}/${event.severity}): ` +
        `${subscriptions.length} active subscription(s), ${rows.length} match(es), ${inserted} notification(s) created`
    );

    return { status: "processed", eventId: event.eventId, matches: rows.length, inserted };
  };
}
