import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AuthUser } from "../App";

type Props = {
  user: AuthUser | null;
  onSignOut: () => void;
};

function formatDate(iso?: string) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const AccountPage = ({ user, onSignOut }: Props) => {
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
    <div className="page page-narrow account-page">
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
              {subscriptionCount ?? pending}{" "}
              <Link to="/alerts" className="text-link">
                Manage in Alert center
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
    </div>
  );
};

export default AccountPage;
