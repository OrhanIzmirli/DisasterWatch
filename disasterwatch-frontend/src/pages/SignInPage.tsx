import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { AuthUser } from "../App";

type Props = {
  onSignedIn: (user: AuthUser) => void;
};

const SignInPage = ({ onSignedIn }: Props) => {
  const navigate = useNavigate();
  const location = useLocation();

  const from = useMemo(() => {
    const s = location.state as { from?: string } | null;
    return s?.from || "/admin";
  }, [location.state]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password.trim()) {
      setError("Please enter email and password.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim(), password }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.message || "Sign in failed.");
        return;
      }

      onSignedIn(data.user);
      navigate(from, { replace: true });
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">Sign in</h1>
        <p className="auth-subtitle">Sign in to manage your alert subscriptions.</p>

        <form className="auth-form" onSubmit={submit}>
          <div className="form-field">
            <label>Email</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              autoComplete="email"
              type="email"
            />
          </div>

          <div className="form-field">
            <label>Password</label>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              type="password"
              autoComplete="current-password"
            />
          </div>

          {error && <div className="form-error">{error}</div>}

          <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="auth-footer">
          <span>Not a member?</span>{" "}
          <Link to="/signup" className="auth-link">
            Create an account
          </Link>
        </div>
      </div>
    </div>
  );
};

export default SignInPage;
