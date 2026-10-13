import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";

import DashboardPage from "./pages/DashboardPage";
import AlertsPage from "./pages/AlertsPage";
import AdminPage from "./pages/AdminPage";
import SignInPage from "./pages/SignInPage";
import SignUpPage from "./pages/SignUpPage";
import NewsPanel from "./components/NewsPanel";

export type AuthUser = {
  email: string;
  role: string;
};

type ProtectedRouteProps = {
  user: AuthUser | null;
  authLoading: boolean;
  children: React.ReactNode;
};

function ProtectedRoute({ user, authLoading, children }: ProtectedRouteProps) {
  const location = useLocation();

  // Session check still in flight: don't redirect yet, show a brief placeholder
  if (authLoading) {
    return <div className="auth-loading">Checking session…</div>;
  }

  if (!user) {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

export default function App() {
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
    }
  }, []);

  const isAuthed = Boolean(user);

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

            <NavLink to="/admin" className={navClass}>
              Admin
            </NavLink>

            {!isAuthed ? (
              <NavLink to="/signin" className={navClass}>
                Sign in
              </NavLink>
            ) : (
              <button type="button" className="nav-btn" onClick={signOut}>
                Sign out
              </button>
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

      {/* GLOBAL STATUS BAR */}
      <div className="status-bar">
        <div className="status-left">
          <span className="status-dot" />
          <span>
            <strong>System status:</strong> Operational
          </span>
          <span>•</span>
          <span>Uptime: 0 min</span>
        </div>
        <div className="status-right">API latency: ~120 ms · News API: OK</div>
      </div>

      <div className="page-content">
        <Routes>
          <Route path="/" element={<DashboardPage />} />

          {/* Pass isAuthed down to the page */}
          <Route path="/alerts" element={<AlertsPage isAuthed={isAuthed} />} />

          <Route
            path="/admin"
            element={
              <ProtectedRoute user={user} authLoading={authLoading}>
                <AdminPage user={user} />
              </ProtectedRoute>
            }
          />

          <Route path="/signin" element={<SignInPage onSignedIn={onSignedIn} />} />
          <Route path="/signup" element={<SignUpPage onSignedIn={onSignedIn} />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>

      <NewsPanel isOpen={isNewsOpen} onClose={() => setIsNewsOpen(false)} />
    </div>
  );
}
