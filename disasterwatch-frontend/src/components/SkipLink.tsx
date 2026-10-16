type Props = {
  /** Id of the region to skip to; its first `.disaster-row` gets focus, else its heading. */
  targetId?: string;
  label?: string;
};

/**
 * Visually hidden until focused; the first Tab stop on the dashboard. Moves
 * focus straight to the first feed row so a keyboard user does not have to
 * tab through every map marker. While the feed has no rows (loading,
 * offline, empty) focus goes to the feed heading instead.
 */
export default function SkipLink({ targetId = "disaster-feed", label = "Skip to feed" }: Props) {
  return (
    <a
      href={`#${targetId}`}
      className="skip-link"
      onClick={(e) => {
        const region = document.getElementById(targetId);
        if (!region) return; // let the browser follow the fragment
        e.preventDefault();
        const target = region.querySelector<HTMLElement>(".disaster-row") ?? region.querySelector<HTMLElement>("[data-skip-fallback]");
        target?.focus();
      }}
    >
      {label}
    </a>
  );
}
