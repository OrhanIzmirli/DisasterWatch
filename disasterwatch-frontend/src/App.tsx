import { useMemo, useState } from "react";
import "./App.css";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";

import DashboardPage from "./pages/DashboardPage";
import AlertsPage from "./pages/AlertsPage";
import AdminPage from "./pages/AdminPage";
import SignInPage from "./pages/SignInPage";
import SignUpPage from "./pages/SignUpPage";
import NewsPanel from "./components/NewsPanel";

const TOKEN_KEY = "dw_token";

const getToken = () => localStorage.getItem(TOKEN_KEY);
const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);
const clearToken = () => localStorage.removeItem(TOKEN_KEY);

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const isAuthed = Boolean(getToken());

  if (!isAuthed) {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

export default function App() {
  const [isNewsOpen, setIsNewsOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const isAuthed = useMemo(() => Boolean(getToken()), [refreshKey]);

  const onSignedIn = () => {
    setToken("demo-token");
    setRefreshKey((k) => k + 1);
  };

  const signOut = () => {
    clearToken();
    setRefreshKey((k) => k + 1);
  };

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

          {/* ✅ BURASI: isAuthed prop’unu veriyoruz */}
          <Route path="/alerts" element={<AlertsPage isAuthed={isAuthed} />} />

          <Route
            path="/admin"
            element={
              <ProtectedRoute>
                <AdminPage />
              </ProtectedRoute>
            }
          />

          <Route path="/signin" element={<SignInPage onSignedIn={onSignedIn} />} />
          <Route path="/signup" element={<SignUpPage />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>

      <NewsPanel isOpen={isNewsOpen} onClose={() => setIsNewsOpen(false)} />
    </div>
  );
}
