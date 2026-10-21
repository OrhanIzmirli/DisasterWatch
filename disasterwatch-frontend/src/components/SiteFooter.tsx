import { Link } from "react-router-dom";

/** Footer of the content pages (not the dashboard, whose map fills the viewport). */
export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <span>DisasterWatch</span>
      <span aria-hidden="true">·</span>
      <Link to="/privacy" className="site-footer-link">
        Privacy
      </Link>
    </footer>
  );
}
