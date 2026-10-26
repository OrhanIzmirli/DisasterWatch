import { useCallback, useEffect, useState } from "react";

/** As GET /api/alerts/email answers (backend services/emailChannel.js). */
export type EmailChannelState = "active" | "limit-reached" | "not-configured" | "unknown";
export type EmailSettings = {
  enabled: boolean;
  consentAt: string | null;
  /** double opt-in: the confirmation link sent to the address was opened */
  verified: boolean;
  /** the confirmation e-mail of the current opt-in, while the address is unconfirmed */
  confirmation: { status: "queued" | "pending" | "sent" | "failed" | "cancelled"; at: string | null } | null;
  channel: { state: EmailChannelState; dailyLimit: number | null; sentLast24h: number };
};

export function isEmailSettings(data: unknown): data is EmailSettings {
  const d = data as EmailSettings | null;
  return Boolean(d && typeof d.enabled === "boolean" && d.channel && typeof d.channel.state === "string");
}

/** The e-mail line of "Delivery channels": "active" only when the server really sends e-mail. */
export function emailChannelText(settings: EmailSettings | null, failed: boolean): string {
  if (failed) return "E-mail: status unavailable";
  if (!settings) return "E-mail: checking…";
  const { state, dailyLimit } = settings.channel;
  if (state === "not-configured") return "E-mail: not available yet (not set up on this server)";
  if (state === "unknown") return "E-mail: status unknown (the e-mail service has not reported in the last 12 hours)";
  if (state === "limit-reached")
    return `E-mail: paused, the limit of ${dailyLimit ?? "?"} e-mails per 24 hours is used up; new alerts stay in the app until it frees up`;
  if (!settings.enabled) return "E-mail: available, off for your account";
  return settings.verified ? "E-mail: active" : "E-mail: waiting for you to confirm your address (see the confirmation e-mail)";
}

export function useEmailSettings(signedIn: boolean) {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts/email", { credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (!isEmailSettings(data)) throw new Error("unexpected answer");
      setSettings(data);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    if (signedIn) load();
    else setSettings(null);
  }, [signedIn, load]);
  return { settings, setSettings, failed };
}
