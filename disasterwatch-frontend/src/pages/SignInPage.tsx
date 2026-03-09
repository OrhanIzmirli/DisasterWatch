import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

type Props = {
  onSignedIn: (email: string) => void; // <-- IMPORTANT: email param
};

const SignInPage = ({ onSignedIn }: Props) => {
  const navigate = useNavigate();
  const location = useLocation();

  const from = useMemo(() => {
    const s = location.state as any;
    return s?.from || "/admin";
  }, [location.state]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password.trim()) {
      setError("Please enter email and password.");
      return;
    }

    // Demo login
    onSignedIn(email.trim()); // <-- send email
    navigate(from, { replace: true });
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">Sign in</h1>
        <p className="auth-subtitle">Demo authentication for front-end evaluation.</p>

        <form className="auth-form" onSubmit={submit}>
          <div className="form-field">
            <label>Email</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              autoComplete="email"
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

          {error && <div className="auth-error">{error}</div>}

          <button className="auth-btn" type="submit">
            Sign in
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
