import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";

/** Real 404 for unknown routes (no silent redirect): says what happened and offers the way back. */
export default function NotFoundPage() {
  const { pathname } = useLocation();

  useEffect(() => {
    const previous = document.title;
    document.title = "Page not found – DisasterWatch";
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <main className="page page-narrow not-found-page" aria-labelledby="not-found-title">
      <header className="page-header">
        <p className="not-found-code" aria-hidden="true">
          404
        </p>
        <h1 id="not-found-title" className="page-title">
          Page not found
        </h1>
        <p className="page-subtitle">
          There is no page at <code className="not-found-path">{pathname}</code>. The address may be mistyped, or the page may have
          moved.
        </p>
      </header>
      <div className="card not-found-card">
        <p className="muted">Where to go next</p>
        <div className="card-actions">
          <Link to="/" className="btn btn-primary">
            Open the dashboard
          </Link>
          <Link to="/alerts" className="btn btn-secondary">
            Alert center
          </Link>
        </div>
      </div>
    </main>
  );
}
