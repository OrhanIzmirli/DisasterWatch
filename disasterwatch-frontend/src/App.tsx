import { useCallback, useEffect, useState } from "react";
import "./App.css";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";

import DashboardPage from "./pages/DashboardPage";
import AlertsPage from "./pages/AlertsPage";
import AdminPage from "./pages/AdminPage";
import AccountPage from "./pages/AccountPage";
import SignInPage from "./pages/SignInPage";
import SignUpPage from "./pages/SignUpPage";
import NewsPanel from "./components/NewsPanel";
import StatusBar from "./components/StatusBar";
import NotificationBell from "./components/NotificationBell";
import NotFoundPage from "./pages/NotFoundPage";

export type AuthUser = {
  email: string;
  role: string;
  createdAt?: string;
  subscriptionCount?: number;
};

type GuardProps = {
  user: AuthUser | null;
  authLoading: boolean;
  children: React.ReactNode;
};

/** Any signed-in user. While the session check is in flight nothing is redirected. */
function ProtectedRoute({ user, authLoading, children }: GuardProps) {
  const location = useLocation();

  if (authLoading) {
    return <div className="auth-loading">Checking session…</div>;
  }

  if (!user) {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

/**
 * Admins only. Signed-out users go to /signin, signed-in non-admins go home.
 * Nothing of the admin UI is rendered for anyone else; the backend enforces
 * the role on every admin endpoint regardless.
 */
function AdminRoute({ user, authLoading, children }: GuardProps) {
  const location = useLocation();

  if (authLoading) {
    return <div className="auth-loading">Checking session…</div>;
  }

  if (!user) {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  }

  if (user.role !== "admin") {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

// Keep long addresses from blowing up the header: "someverylongname@example.com" -> "someverylo…@example.com"
function shortEmail(email: string, max = 22) {
  if (email.length <= max) return email;
  const at = email.lastIndexOf("@");
  if (at <= 0) return email.slice(0, max - 1) + "…";
  const domain = email.slice(at);
  const localMax = Math.max(4, max - domain.length - 1);
  return email.slice(0, localMax) + "…" + domain;
}

export default function App() {
  const navigate = useNavigate();
  const [isNewsOpen, setIsNewsOpen] = useState(false);

  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Real session check against the backend on mount (httpOnly cookie)
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/users/me", { credentials: "include" });
        if (!res.ok) {
          if (!cancelled) setUser(null);
          return;
        }
        const data = await res.json();
        if (!cancelled) setUser(data?.user ?? null);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const onSignedIn = useCallback((signedInUser: AuthUser) => {
    setUser(signedInUser);
    setAuthLoading(false);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await fetch("/api/users/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // Even if the request fails, drop the local session state
    } finally {
      setUser(null);
      navigate("/", { replace: true });
    }
  }, [navigate]);

  const isAdmin = user?.role === "admin";

  const navClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? "nav-btn active" : "nav-btn";

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="logo">
          <div className="logo-mark">DW</div>
          <div className="logo-text">
            <span className="logo-title">DisasterWatch</span>
            <span className="logo-subtitle">Global Hazard Monitor</span>
          </div>
        </div>

        <div className="header-right">
          <nav className="nav-links">
            <NavLink to="/" end className={navClass}>
              Dashboard
            </NavLink>

            <NavLink to="/alerts" className={navClass}>
              Alerts
            </NavLink>

            {isAdmin && (
              <NavLink to="/admin" className={navClass}>
                Admin
              </NavLink>
            )}

            {!user ? (
              <NavLink to="/signin" className={navClass}>
                Sign in
              </NavLink>
            ) : (
              <>
                <NotificationBell />
                <NavLink
                  to="/account"
                  className={({ isActive }) =>
                    isActive ? "nav-user active" : "nav-user"
                  }
                  title={user.email}
                >
                  <span className="nav-user-email">{shortEmail(user.email)}</span>
                  {isAdmin && <span className="nav-user-badge">Admin</span>}
                </NavLink>
                <button type="button" className="nav-btn" onClick={signOut}>
                  Sign out
                </button>
              </>
            )}
          </nav>

          <button
            type="button"
            className="news-toggle-btn"
            onClick={() => setIsNewsOpen(true)}
          >
            News
          </button>
        </div>
      </header>

      {/* GLOBAL STATUS BAR (measured, not hard-coded) */}
      <StatusBar />

      <div className="page-content">
        <Routes>
          <Route path="/" element={<DashboardPage />} />

          <Route
            path="/alerts"
            element={<AlertsPage user={user} authLoading={authLoading} />}
          />

          <Route
            path="/admin"
            element={
              <AdminRoute user={user} authLoading={authLoading}>
                <AdminPage user={user} />
              </AdminRoute>
            }
          />

          <Route
            path="/account"
            element={
              <ProtectedRoute user={user} authLoading={authLoading}>
                <AccountPage user={user} onSignOut={signOut} />
              </ProtectedRoute>
            }
          />

          <Route path="/signin" element={<SignInPage onSignedIn={onSignedIn} />} />
          <Route path="/signup" element={<SignUpPage onSignedIn={onSignedIn} />} />

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </div>

      <NewsPanel isOpen={isNewsOpen} onClose={() => setIsNewsOpen(false)} />
    </div>
  );
}
