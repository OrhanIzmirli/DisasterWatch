export type FeedRowProps = {
  /** Visible labels, already formatted by the dashboard. */
  typeLabel: string;
  typeClass: string;
  title: string;
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
export default function FeedRow({ typeLabel, typeClass, title, meta, severityLabel, severityClass, onSelect }: FeedRowProps) {
  return (
    <li className="disaster-row-item">
      <button
        type="button"
        className="disaster-row"
        aria-label={`${typeLabel}: ${title}, ${severityLabel.replace(/^[^A-Za-z]+/, "").toLowerCase()}`}
        onClick={(e) => onSelect(e.currentTarget)}
      >
        <span className="disaster-row-main">
          <span className="disaster-row-top">
            <span className={`disaster-type-tag ${typeClass}`}>{typeLabel}</span>
            <span className="disaster-location">{title}</span>
          </span>
          <span className="disaster-meta">{meta}</span>
        </span>
        <span className={`disaster-severity ${severityClass}`}>{severityLabel}</span>
      </button>
    </li>
  );
}
