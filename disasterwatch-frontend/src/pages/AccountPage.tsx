import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AuthUser } from "../App";
import { formatDate } from "../utils/formatDate";

type Props = {
  user: AuthUser | null;
  onSignOut: () => void;
  onAccountDeleted: () => void;
};

/** Deletes the account after the password is entered again; the server removes everything that belongs to it. */
function DeleteAccount({ onDeleted }: { onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError("Enter your password to delete the account.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/users/me", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok || res.status === 401) {
        // 401: the account or the session was already gone; either way there is nothing left to delete
        onDeleted();
        return;
      }
      setError(data?.message || "Could not delete the account.");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card account-delete" aria-labelledby="account-delete-title">
      <h2 id="account-delete-title" className="card-title">
        Delete account
      </h2>
      <p className="channel-note">
        Deletes your account, your alert subscriptions, your notifications and the record of e-mails we sent you, right away. This
        cannot be undone. <Link to="/privacy" className="text-link">What we store</Link>
      </p>
      {!open ? (
        <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>
          Delete my account…
        </button>
      ) : (
        <form className="account-delete-form" onSubmit={submit}>
          <div className="form-field">
            <label htmlFor="delete-password">Your password</label>
            <input
              id="delete-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby={error ? "delete-error" : undefined}
            />
          </div>
          {error && (
            <div id="delete-error" className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions-row">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setOpen(false);
                setPassword("");
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-danger" disabled={busy}>
              {busy ? "Deleting…" : "Delete account permanently"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

const AccountPage = ({ user, onSignOut, onAccountDeleted }: Props) => {
  // Start from the session user, then refresh from the server so the
  // subscription count reflects changes made on the Alerts page.
  const [profile, setProfile] = useState<AuthUser | null>(user);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/users/me", { credentials: "include" });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          if (!cancelled) setError(data?.message || "Could not load profile.");
          return;
        }
        if (!cancelled) setProfile(data.user);
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const p = profile ?? user;
  const isAdmin = p?.role === "admin";
  const memberSince = formatDate(p?.createdAt);
  const subscriptionCount = p?.subscriptionCount;

  // "…" while the profile is still loading, "-" only if the server really has no value
  const pending = loading ? "…" : "-";

  return (
    <main className="page page-narrow account-page">
      <header className="page-header">
        <h1 className="page-title">My account</h1>
        <p className="page-subtitle">Your profile and alert preferences.</p>
      </header>

      {error && <div className="form-error">{error}</div>}

      <section className="card">
        <dl className="account-details">
          <div className="account-row">
            <dt>Email</dt>
            <dd>{p?.email ?? pending}</dd>
          </div>
          <div className="account-row">
            <dt>Role</dt>
            <dd>
              {p?.role ?? pending}
              {isAdmin && <span className="nav-user-badge">Admin</span>}
            </dd>
          </div>
          <div className="account-row">
            <dt>Member since</dt>
            <dd>{memberSince ?? pending}</dd>
          </div>
          <div className="account-row">
            <dt>Alert subscriptions</dt>
            <dd>
              {subscriptionCount === undefined
                ? pending
                : `${subscriptionCount} ${subscriptionCount === 1 ? "subscription" : "subscriptions"}`}
              <span className="dd-sep">·</span>
              <Link to="/alerts" className="text-link">
                Manage
              </Link>
            </dd>
          </div>
        </dl>

        <div className="card-actions">
          <Link to="/alerts" className="btn btn-primary">
            Open Alert center
          </Link>
          {isAdmin && (
            <Link to="/admin" className="btn btn-secondary">
              Admin console
            </Link>
          )}
          <button type="button" className="btn btn-ghost" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </section>

      <DeleteAccount onDeleted={onAccountDeleted} />
    </main>
  );
};

export default AccountPage;
