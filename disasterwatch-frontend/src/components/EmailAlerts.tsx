import { useState } from "react";
import { isEmailSettings, type EmailSettings } from "../utils/emailSettings";

type Props = {
  email: string;
  settings: EmailSettings | null;
  onChange: (next: EmailSettings) => void;
};

/** Opt-in switch with the consent text next to it. Off by default; turning it on sends the explicit consent. */
const EmailAlerts = ({ email, settings, onChange }: Props) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = Boolean(settings?.enabled);
  // cannot be turned on while the server has no e-mail set up; can always be turned off
  const unavailable = !enabled && settings?.channel.state === "not-configured";

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/alerts/email", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(enabled ? { enabled: false } : { enabled: true, consent: true }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !isEmailSettings(data)) {
        setError(data?.message || "Could not change the e-mail setting.");
        return;
      }
      onChange(data);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="email-optin">
      <label className="email-switch">
        <input
          type="checkbox"
          role="switch"
          checked={enabled}
          disabled={!settings || busy || unavailable}
          onChange={toggle}
          aria-describedby="email-consent"
        />
        <span>E-mail me a summary of new alerts</span>
      </label>
      <p id="email-consent" className="channel-note">
        {enabled
          ? `On: a summary goes to ${email} when new events match your alerts. Turn it off here at any time, or use the unsubscribe link in any of the e-mails.`
          : `Off. By turning this on you agree that DisasterWatch sends a summary e-mail to ${email} when new events match your alerts (at most one per check, about once an hour). You can turn it off here at any time, or with the unsubscribe link in every e-mail.`}
      </p>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
};

export default EmailAlerts;
