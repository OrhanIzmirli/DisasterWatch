import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

type State = "working" | "done" | "invalid" | "error";

/**
 * Target of the unsubscribe link in every alert e-mail (/unsubscribe?token=...).
 * No sign-in: opening the page switches e-mail alerts off with one POST and
 * confirms it. The page load itself (a GET) changes nothing on the server, so
 * mail scanners that only fetch the link do not unsubscribe anyone. The token
 * is removed from the address bar right away.
 */
export default function UnsubscribePage() {
  // read once, before the effect removes it from the address bar
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token") ?? "");
  const [state, setState] = useState<State>(token ? "working" : "invalid");
  const sent = useRef(false);

  useEffect(() => {
    const previous = document.title;
    document.title = "Unsubscribe – DisasterWatch";
    return () => {
      document.title = previous;
    };
  }, []);

  useEffect(() => {
    if (sent.current) return; // StrictMode runs effects twice in development
    sent.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    if (!token) return;
    (async () => {
      try {
        const res = await fetch("/api/email/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        setState(res.ok ? "done" : res.status === 404 ? "invalid" : "error");
      } catch {
        setState("error");
      }
    })();
  }, [token]);

  return (
    <main className="page page-narrow unsubscribe-page" aria-labelledby="unsubscribe-title">
      <header className="page-header">
        <h1 id="unsubscribe-title" className="page-title">
          E-mail alerts
        </h1>
      </header>
      <div className="card" role="status" aria-live="polite">
        {state === "working" && <p>Unsubscribing…</p>}
        {state === "done" && (
          <>
            <p>
              <strong>You are unsubscribed.</strong> DisasterWatch will not send you alert e-mails any more.
            </p>
            <p className="muted">Your alerts and in-app notifications are unchanged. You can turn e-mails back on in the Alert center.</p>
          </>
        )}
        {state === "invalid" && (
          <p>
            This unsubscribe link is not valid. If you still get alert e-mails, sign in and turn them off in the Alert center.
          </p>
        )}
        {state === "error" && <p>Something went wrong, nothing was changed. Please open the link again in a moment.</p>}
        <div className="card-actions">
          <Link to="/alerts" className="btn btn-secondary">
            Alert center
          </Link>
        </div>
      </div>
    </main>
  );
}
