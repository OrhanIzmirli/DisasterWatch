import { useState } from "react";
import { Link } from "react-router-dom";
import { isEmailSettings, type EmailSettings } from "../utils/emailSettings";

/** What happened to the confirmation e-mail of the current opt-in (double opt-in). */
function confirmationText(status: string | undefined, email: string): string {
  if (status === "sent")
    return `Almost done: we sent a confirmation link to ${email}. Alert e-mails start after you open it and confirm. Nothing there? Check the spam folder, or turn this off and on again for a new link (at most one per hour).`;
  if (status === "failed" || status === "cancelled")
    return `The confirmation e-mail to ${email} could not be sent. Turn this off and on again to try once more (at most one link per hour).`;
  return `Almost done: a confirmation link to ${email} is on its way (new alerts are checked about once an hour, and at most one link is sent per hour). Alert e-mails start after you open it and confirm.`;
}

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
        {enabled && !settings?.verified
          ? confirmationText(settings?.confirmation?.status, email)
          : enabled
          ? `On: a summary goes to ${email} when new events match your alerts. Turn it off here at any time, or use the unsubscribe link in any of the e-mails.`
          : `Off. By turning this on you agree that DisasterWatch sends a summary e-mail to ${email} when new events match your alerts (at most one per check, about once an hour). We first send a link to confirm the address. You can turn it off here at any time, or with the unsubscribe link in every e-mail.`}{" "}
        <Link to="/privacy" className="text-link">
          Privacy
        </Link>
      </p>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
};

export default EmailAlerts;
