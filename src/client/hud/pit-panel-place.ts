// Where the pit panel goes (HUD v2 card): just below YOUR pit box, never over pit lane or pit box pixels,
// fully on the canvas and clear of the top bar. Pure: box + panel size + a "is this pit?" test in, a
// top-left corner out (track px).

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export interface PlaceInput {
  /** Your pit box's bounding box, track px. */
  box: Rect;
  /** Panel size, track px. */
  w: number;
  h: number;
  /** Canvas size, track px. */
  width: number;
  height: number;
  /** Reserved top band (the HUD bar), track px: the panel never goes up there. */
  top: number;
  /** True on pit lane or pit box pixels. */
  isPit(x: number, y: number): boolean;
  /** Gap between the box (or the lane) and the panel, track px. */
  gap?: number;
  /** Sampling step for the overlap test, track px. */
  step?: number;
}

/** Does the rectangle cover any pit lane / pit box pixel? (Sampled on a grid, edges included.) */
export function coversPit(x: number, y: number, w: number, h: number, isPit: PlaceInput['isPit'], step = 4): boolean {
  for (let yy = y; yy <= y + h; yy += Math.min(step, Math.max(1, y + h - yy))) {
    for (let xx = x; xx <= x + w; xx += Math.min(step, Math.max(1, x + w - xx))) if (isPit(xx, yy)) return true;
    if (yy === y + h) break;
  }
  return false;
}

/**
 * Below the box first, sliding further down until it clears the pit lane (below the lane / pit wall);
 * with no room below, above the box the same way; as a last resort, the clamped spot below the box.
 * x: centred on the box, clamped to the canvas.
 */
export function placePitPanel(p: PlaceInput): { x: number; y: number; side: 'below' | 'above' | 'clamped' } {
  const gap = p.gap ?? 8, step = p.step ?? 4;
  const cx = (p.box.x0 + p.box.x1) / 2;
  const x = Math.round(Math.max(0, Math.min(p.width - p.w, cx - p.w / 2)));
  const maxY = p.height - p.h, minY = p.top;
  const clear = (y: number) => !coversPit(x, y, p.w, p.h, p.isPit, step);
  for (let y = Math.max(minY, p.box.y1 + gap); y <= maxY; y += step) if (clear(y)) return { x, y: Math.round(y), side: 'below' };
  for (let y = Math.min(maxY, p.box.y0 - gap - p.h); y >= minY; y -= step) if (clear(y)) return { x, y: Math.round(y), side: 'above' };
  return { x, y: Math.round(Math.max(minY, Math.min(maxY, p.box.y1 + gap))), side: 'clamped' };
}
