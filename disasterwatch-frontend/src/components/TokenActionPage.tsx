import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

type State = "ready" | "working" | "done" | "invalid" | "error";

type Props = {
  title: string;
  /** what the button does, e.g. "Unsubscribe" */
  action: string;
  intro: ReactNode;
  done: ReactNode;
  invalid: ReactNode;
  /** POST endpoint that takes { token } */
  endpoint: string;
};

/**
 * Pages opened from a link in an e-mail (/unsubscribe, /confirm-email). The
 * change happens only when the person presses the button (one POST); the
 * token leaves the address bar once it has been used (a reload before the
 * press still works). Opening the
 * page changes nothing, so mail scanners that open links, even ones that run
 * JavaScript, can neither unsubscribe nor confirm anyone.
 */
export default function TokenActionPage({ title, action, intro, done, invalid, endpoint }: Props) {
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token") ?? "");
  const [state, setState] = useState<State>(token ? "ready" : "invalid");

  useEffect(() => {
    const previous = document.title;
    document.title = `${title} – DisasterWatch`;
    return () => {
      document.title = previous;
    };
  }, [title]);

  const submit = async () => {
    setState("working");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const next = res.ok ? "done" : res.status === 404 ? "invalid" : "error";
      if (next !== "error") window.history.replaceState(null, "", window.location.pathname); // used up: out of the address bar
      setState(next);
    } catch {
      setState("error");
    }
  };

  return (
    <main className="page page-narrow token-action-page" aria-labelledby="token-action-title">
      <header className="page-header">
        <h1 id="token-action-title" className="page-title">
          {title}
        </h1>
      </header>
      <div className="card" role="status" aria-live="polite">
        {(state === "ready" || state === "working") && (
          <>
            {intro}
            <div className="card-actions">
              <button type="button" className="btn btn-primary" onClick={submit} disabled={state === "working"}>
                {state === "working" ? "Please wait…" : action}
              </button>
            </div>
          </>
        )}
        {state === "done" && done}
        {state === "invalid" && invalid}
        {state === "error" && <p>Something went wrong, nothing was changed. Please try again in a moment.</p>}
        <div className="card-actions">
          <Link to="/alerts" className="btn btn-secondary">
            Alert center
          </Link>
        </div>
      </div>
    </main>
  );
}
