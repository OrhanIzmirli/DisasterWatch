export type FeedRowProps = {
  /** Visible labels, already formatted by the dashboard. */
  typeLabel: string;
  typeClass: string;
  title: string;
  /** Tells apart events that share a title (backend `subtitle`); absent for most rows. */
  subtitle?: string | null;
  meta: string;
  severityLabel: string;
  severityClass: string;
  /** Called with the button element so the opener can get focus back when the drawer closes. */
  onSelect: (element: HTMLButtonElement) => void;
};

/**
 * One feed row: a real <button> inside the list item, so it is focusable,
 * Enter and Space activate it natively and screen readers announce a button
 * with the event as its name. The focus ring is drawn for keyboard focus
 * only (:focus-visible), never on a mouse click.
 */
export default function FeedRow({ typeLabel, typeClass, title, subtitle, meta, severityLabel, severityClass, onSelect }: FeedRowProps) {
  return (
    <li className="disaster-row-item">
      <button
        type="button"
        className="disaster-row"
        // the visible text, in its order (WCAG 2.5.3 "label in name"), with separators for speech
        aria-label={`${typeLabel}: ${title}${subtitle ? `, ${subtitle}` : ""}${meta ? `, ${meta}` : ""}, ${severityLabel.replace(/^[^A-Za-z]+/, "").toLowerCase()}`}
        onClick={(e) => onSelect(e.currentTarget)}
      >
        {/* the {" "} keep words apart in the text (accessible name, copy, search); flex ignores them visually */}
        <span className="disaster-row-main">
          <span className="disaster-row-top">
            <span className={`disaster-type-tag ${typeClass}`}>{typeLabel}</span>{" "}
            <span className="disaster-location">{title}</span>
          </span>{" "}
          {subtitle && <span className="disaster-subtitle">{subtitle}</span>}{" "}
          <span className="disaster-meta">{meta}</span>
        </span>{" "}
        <span className={`disaster-severity ${severityClass}`}>{severityLabel}</span>
      </button>
    </li>
  );
}
