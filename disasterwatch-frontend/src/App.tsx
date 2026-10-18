import { lazy, Suspense, useCallback, useEffect, useState } from "react";
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
import NewsPanel from "./components/NewsPanel";
import StatusBar from "./components/StatusBar";
import NotificationBell from "./components/NotificationBell";
import NotFoundPage from "./pages/NotFoundPage";
import SkipLink from "./components/SkipLink";
import { readSessionHint, shouldCheckSession, writeSessionHint } from "./utils/sessionHint";

// Pages other than the dashboard load on demand (smaller first download).
const AlertsPage = lazy(() => import("./pages/AlertsPage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const AccountPage = lazy(() => import("./pages/AccountPage"));
const SignInPage = lazy(() => import("./pages/SignInPage"));
const SignUpPage = lazy(() => import("./pages/SignUpPage"));
const UnsubscribePage = lazy(() => import("./pages/UnsubscribePage"));
const ConfirmEmailPage = lazy(() => import("./pages/ConfirmEmailPage"));

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
  const { pathname } = useLocation();
  const [isNewsOpen, setIsNewsOpen] = useState(false);

  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Real session check against the backend on mount (httpOnly cookie)
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Signed out last time: no request, so no expected-401 in the console (see utils/sessionHint)
      if (!shouldCheckSession(readSessionHint())) {
        if (!cancelled) {
          setUser(null);
          setAuthLoading(false);
        }
        return;
      }
      try {
        const res = await fetch("/api/users/me", { credentials: "include" });
        if (!res.ok) {
          if (res.status === 401) writeSessionHint("out");
          if (!cancelled) setUser(null);
          return;
        }
        const data = await res.json();
        writeSessionHint(data?.user ? "in" : "out");
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
    writeSessionHint("in");
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
      writeSessionHint("out");
      setUser(null);
      navigate("/", { replace: true });
    }
  }, [navigate]);

  const isAdmin = user?.role === "admin";

  const navClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? "nav-btn active" : "nav-btn";

  return (
    <div className="app-root">
      {/* first Tab stop on the dashboard: past the header and every map marker, straight to the feed */}
      {pathname === "/" && <SkipLink />}
      <header className="app-header" data-map-obstruction>
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
        <Suspense fallback={<div className="auth-loading">Loading…</div>}>
          <Routes>
            <Route path="/" element={<DashboardPage signedIn={Boolean(user)} />} />

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
            <Route path="/unsubscribe" element={<UnsubscribePage />} />
            <Route path="/confirm-email" element={<ConfirmEmailPage />} />

            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </div>

      <NewsPanel isOpen={isNewsOpen} onClose={() => setIsNewsOpen(false)} />
    </div>
  );
}
