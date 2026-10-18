/**
 * Runs `fn` now and then every `ms`, but only while the page is visible; when
 * a hidden tab becomes visible again it runs once at once. Returns a cleanup.
 *
 * Why: the backend runs on a free plan that sleeps after ~15 minutes without
 * requests and has a monthly hour budget. A forgotten background tab polling
 * /api/health every 30 s would keep it awake around the clock.
 */
export function pollWhileVisible(fn: () => void, ms: number): () => void {
  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
  if (!hidden()) fn();
  const timer = window.setInterval(() => {
    if (!hidden()) fn();
  }, ms);
  const onVisibility = () => {
    if (!hidden()) fn();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
