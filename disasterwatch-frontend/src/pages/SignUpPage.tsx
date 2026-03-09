import { useState } from "react";
import { Link } from "react-router-dom";

const SignUpPage = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;
    setDone(true);
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">Sign up</h1>
        <p className="auth-subtitle">
          Demo registration for front-end evaluation.
        </p>

        {!done ? (
          <form className="auth-form" onSubmit={submit}>
            <div className="form-field">
              <label>Email</label>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
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
                autoComplete="new-password"
              />
            </div>

            <button className="auth-btn" type="submit">
              Create account
            </button>
          </form>
        ) : (
          <div className="auth-success">
            Account created (demo). You can now{" "}
            <Link className="auth-link" to="/signin">
              sign in
            </Link>
            .
          </div>
        )}

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
