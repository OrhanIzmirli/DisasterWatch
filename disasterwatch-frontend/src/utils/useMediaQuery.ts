import { useCallback, useSyncExternalStore } from "react";

/** Phone layout breakpoint; the same width as the `@media (max-width: 480px)` block in App.css. */
export const PHONE_QUERY = "(max-width: 480px)";

const media = (query: string) => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null);

/** True while the media query matches (follows live changes, e.g. rotating a phone). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const m = media(query);
      if (!m) return () => {};
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => media(query)?.matches ?? false,
    () => false
  );
}
