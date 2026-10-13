import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AuthUser } from "../App";

type Props = {
  user: AuthUser | null;
  onSignOut: () => void;
};

function formatDate(iso?: string) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
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
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const p = profile ?? user;
  const subscriptionCount = p?.subscriptionCount ?? 0;

  return (
    <div className="account-page">
      <div className="account-header">
        <h1 className="account-title">My account</h1>
        <p className="account-subtitle">Your profile and alert preferences.</p>
      </div>

      {error && <div className="auth-error">{error}</div>}

      <div className="account-card">
        <dl className="account-details">
          <div className="account-row">
            <dt>Email</dt>
            <dd>{p?.email ?? "-"}</dd>
          </div>
          <div className="account-row">
            <dt>Role</dt>
            <dd>
              {p?.role ?? "-"}
              {p?.role === "admin" && <span className="nav-user-badge">Admin</span>}
            </dd>
          </div>
          <div className="account-row">
            <dt>Member since</dt>
            <dd>{formatDate(p?.createdAt)}</dd>
          </div>
          <div className="account-row">
            <dt>Alert subscriptions</dt>
            <dd>
              {subscriptionCount}{" "}
              <Link to="/alerts" className="auth-link">
                Manage in Alert center
              </Link>
            </dd>
          </div>
        </dl>

        <div className="account-actions">
          <Link to="/alerts" className="alerts-add-btn">
            Open Alert center
          </Link>
          {p?.role === "admin" && (
            <Link to="/admin" className="admin-refresh-btn">
              Admin console
            </Link>
          )}
          <button type="button" className="account-signout-btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
};

export default AccountPage;
