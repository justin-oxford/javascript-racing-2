// Trace wall and tyre-barrier regions of a mask into simplified closed outlines.
// Pure. Card 03 decides how physics consumes these (e.g. building Planck chains from them).
import type { TrackMask, WallChain } from './track';

export interface TraceOptions {
  /** Douglas-Peucker tolerance, mask pixels. */
  simplifyTolerancePx: number;
  /** Outlines enclosing less area than this (px^2) are noise and dropped. */
  minLoopAreaPx: number;
}

/**
 * Outline every 4-connected region whose pixels are in `indices`.
 * Boundaries run along pixel edges (vertices at integer coordinates), with the region
 * on the right-hand side when walking the outline in screen coordinates.
 */
export function traceRegions(mask: TrackMask, indices: ReadonlySet<number>, opts: TraceOptions): number[][] {
  const { width: w, height: h, data } = mask;
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && indices.has(data[y * w + x]!);
  const W1 = w + 1;
  const vid = (x: number, y: number): number => y * W1 + x;

  // Directed boundary edges, keyed by start vertex. Region kept on the right.
  // Directions: 0 = +x, 1 = +y, 2 = -x, 3 = -y.
  const out = new Map<number, number[]>(); // start vertex -> list of directions
  const add = (x: number, y: number, dir: number): void => {
    const k = vid(x, y);
    const list = out.get(k);
    if (list) list.push(dir);
    else out.set(k, [dir]);
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) add(x, y, 0); // top edge, walk +x
      if (!inside(x + 1, y)) add(x + 1, y, 1); // right edge, walk +y
      if (!inside(x, y + 1)) add(x + 1, y + 1, 2); // bottom edge, walk -x
      if (!inside(x - 1, y)) add(x, y + 1, 3); // left edge, walk -y
    }

  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const loops: number[][] = [];

  for (const [startKey, dirs] of out) {
    while (dirs.length) {
      const pts: number[] = [];
      let x = startKey % W1;
      let y = (startKey - x) / W1;
      let dir = dirs.pop()!;
      const sx = x, sy = y;
      for (;;) {
        pts.push(x, y);
        x += DX[dir]!;
        y += DY[dir]!;
        if (x === sx && y === sy) break;
        const next = out.get(vid(x, y));
        if (!next || next.length === 0) break; // shouldn't happen on a valid boundary
        // At a diagonal pinch two edges leave this vertex; turning right keeps
        // diagonal-only neighbours as separate regions (4-connectivity).
        let pick = next.indexOf((dir + 1) % 4);
        if (pick < 0) pick = next.indexOf(dir);
        if (pick < 0) pick = next.indexOf((dir + 3) % 4);
        if (pick < 0) pick = 0;
        dir = next.splice(pick, 1)[0]!;
      }
      const simplified = simplifyClosed(dropCollinear(pts), opts.simplifyTolerancePx);
      if (Math.abs(polygonArea(simplified)) >= opts.minLoopAreaPx) loops.push(simplified);
    }
  }
  return loops;
}

export function traceWalls(
  mask: TrackMask,
  wallIndex: number,
  barrierIndex: number,
  opts: TraceOptions,
): WallChain[] {
  return [
    ...traceRegions(mask, new Set([wallIndex]), opts).map((points) => ({ points, barrier: false })),
    ...traceRegions(mask, new Set([barrierIndex]), opts).map((points) => ({ points, barrier: true })),
  ];
}

function dropCollinear(p: number[]): number[] {
  const n = p.length / 2;
  if (n < 4) return p;
  const outPts: number[] = [];
  for (let i = 0; i < n; i++) {
    const ax = p[((i - 1 + n) % n) * 2]!, ay = p[((i - 1 + n) % n) * 2 + 1]!;
    const bx = p[i * 2]!, by = p[i * 2 + 1]!;
    const cx = p[((i + 1) % n) * 2]!, cy = p[((i + 1) % n) * 2 + 1]!;
    if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) !== 0) outPts.push(bx, by);
  }
  return outPts;
}

export function polygonArea(p: number[]): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2]! * p[j * 2 + 1]! - p[j * 2]! * p[i * 2 + 1]!;
  }
  return a / 2;
}

function perpDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Douglas-Peucker on an open polyline (flat array). */
export function simplifyOpen(p: number[], tol: number): number[] {
  const n = p.length / 2;
  if (n <= 2) return p.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(p[i * 2]!, p[i * 2 + 1]!, p[s * 2]!, p[s * 2 + 1]!, p[e * 2]!, p[e * 2 + 1]!);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const outPts: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) outPts.push(p[i * 2]!, p[i * 2 + 1]!);
  return outPts;
}

/** Douglas-Peucker on a closed loop: split at the vertex farthest from vertex 0. */
export function simplifyClosed(p: number[], tol: number): number[] {
  const n = p.length / 2;
  if (n <= 3) return p.slice();
  let far = 0, farD = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(p[i * 2]! - p[0]!, p[i * 2 + 1]! - p[1]!);
    if (d > farD) { farD = d; far = i; }
  }
  const first = simplifyOpen(p.slice(0, far * 2 + 2), tol);
  const second = simplifyOpen([...p.slice(far * 2), p[0]!, p[1]!], tol);
  // first ends at `far`, second starts at `far` and ends back at 0: drop the duplicates.
  return [...first, ...second.slice(2, -2)];
}
