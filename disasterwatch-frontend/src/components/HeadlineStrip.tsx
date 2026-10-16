import { Link } from "react-router-dom";

type Props = {
  /** The sentence from utils/headline (already final text). */
  text: string;
  tone: "loading" | "significant" | "quiet" | "offline";
  signedIn: boolean;
};

/**
 * One-line summary of the real feed, with the alerts call-to-action next to
 * it. The text comes from headlineText(); nothing here invents a number.
 */
export default function HeadlineStrip({ text, tone, signedIn }: Props) {
  return (
    <section className={`headline-strip headline-${tone}`} aria-label="Summary">
      <p className="headline-text" role="status">
        {text}
      </p>
      <div className="headline-cta">
        <Link to="/alerts" className="btn btn-primary headline-cta-btn">
          Get alerts for your area
        </Link>
        <span className="headline-cta-hint">
          {signedIn
            ? "Choose places, a radius and the hazards you want to hear about."
            : "Create an account, pick a place and a radius, and matching events appear in your notifications."}
        </span>
      </div>
    </section>
  );
}
