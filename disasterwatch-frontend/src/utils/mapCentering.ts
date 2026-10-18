/**
 * Where on the map a selected event should land so the user actually sees it.
 *
 * The map can be partly covered (the sticky header, the event detail drawer on
 * desktop, the bottom sheet on a phone) or partly scrolled out of the window.
 * These helpers work out the part of the map that is visible and how far its
 * centre is from the map container's centre; the map then flies to a point
 * shifted by that offset so the marker lands in the middle of what is visible.
 */

export type Rect = { left: number; top: number; right: number; bottom: number };

const area = (r: Rect) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * The visible part of `container` (all in viewport coordinates): clipped to the
 * viewport, then each overlapping obstruction is cut away from whichever side
 * leaves the larger area (a full-width header from the top, a bottom sheet from
 * the bottom, a side drawer from the right). Null when nothing is visible.
 */
export function visibleRect(container: Rect, viewport: { width: number; height: number }, obstructions: Rect[]): Rect | null {
  let vis: Rect = {
    left: Math.max(container.left, 0),
    top: Math.max(container.top, 0),
    right: Math.min(container.right, viewport.width),
    bottom: Math.min(container.bottom, viewport.height),
  };
  if (area(vis) === 0) return null;
  for (const o of obstructions) {
    if (area(o) === 0 || !overlaps(vis, o)) continue;
    const cuts: Rect[] = [
      { ...vis, top: Math.max(vis.top, o.bottom) },
      { ...vis, bottom: Math.min(vis.bottom, o.top) },
      { ...vis, left: Math.max(vis.left, o.right) },
      { ...vis, right: Math.min(vis.right, o.left) },
    ];
    const best = cuts.reduce((a, b) => (area(b) > area(a) ? b : a));
    if (area(best) === 0) return null;
    vis = best;
  }
  return vis;
}

/** Offset (px) of the visible area's centre from the container's centre; 0,0 when nothing is visible. */
export function visibleCenterOffset(container: Rect, viewport: { width: number; height: number }, obstructions: Rect[]) {
  const vis = visibleRect(container, viewport, obstructions);
  if (!vis) return { x: 0, y: 0 };
  return {
    x: (vis.left + vis.right) / 2 - (container.left + container.right) / 2,
    y: (vis.top + vis.bottom) / 2 - (container.top + container.bottom) / 2,
  };
}
