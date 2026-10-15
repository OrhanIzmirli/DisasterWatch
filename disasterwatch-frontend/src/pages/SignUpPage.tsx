import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { AuthUser } from "../App";

type Props = {
  onSignedIn: (user: AuthUser) => void;
};

const SignUpPage = ({ onSignedIn }: Props) => {
  const navigate = useNavigate();

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
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/users/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim(), password }),
      });

      const data = await res.json().catch(() => null);

      if (res.status === 409) {
        setError("This e-mail is already registered. Sign in instead.");
        return;
      }

      if (!res.ok) {
        setError(data?.message || "Sign up failed.");
        return;
      }

      // Registration also starts a session, so treat the user as signed in
      onSignedIn(data.user);
      navigate("/", { replace: true });
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">Sign up</h1>
        <p className="auth-subtitle">
          Create a free account to save alert subscriptions for places you care
          about and get notified when a matching disaster is detected.
        </p>

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
              placeholder="At least 8 characters"
              type="password"
              autoComplete="new-password"
            />
          </div>

          {error && (
            <div className="form-error">
              {error}{" "}
              {error.startsWith("Bu e-posta") && (
                <Link className="auth-link" to="/signin">
                  Giriş yap
                </Link>
              )}
            </div>
          )}

          <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
            {submitting ? "Creating account…" : "Create account"}
          </button>
        </form>

        <div className="auth-footer">
          <span>Already have an account?</span>{" "}
          <Link to="/signin" className="auth-link">
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
};

export default SignUpPage;
