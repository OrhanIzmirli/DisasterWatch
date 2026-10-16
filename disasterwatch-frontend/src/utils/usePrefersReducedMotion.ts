import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

const media = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null);

function subscribe(onChange: () => void) {
  const m = media();
  if (!m) return () => {};
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}

/** True while the visitor's system asks for reduced motion (follows live changes). */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => media()?.matches ?? false,
    () => false
  );
}
