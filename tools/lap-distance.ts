// Lap distance over a track's racing surface (asphalt + kerb; pit lane excluded), measured from the
// forward side of start/finish with the line blocked, so distance has to go all the way round.
// Used by suggest-timing-lines (sector lines at lap thirds) and by headless lap checks (a centre path).
import type { Point, SimTrack, TimingLine } from '../src/sim/index.ts';
import { surfaces } from './load-track-node.ts';

export interface LapGeometry {
  /** Distance in px from start/finish for every pixel (Infinity off the racing surface). */
  dist: Float64Array;
  /** Shortest lap (inside line), px. */
  lap: number;
  /** A timing line across the track at this lap distance, arrow pointing the driving direction. */
  lineAt(target: number): TimingLine;
  /** Near a lap fraction (+/- 8%), the narrowest (straightest) crossing. */
  bestNear(fraction: number): { line: TimingLine; at: number };
  /** Middle of the track at this lap distance. */
  centreAt(target: number): Point;
}

export function lapGeometry(track: SimTrack): LapGeometry {
  const { width: w, height: h, data } = track.mask;
  const sf = track.json.timingLines.startFinish;
  if (!sf) throw new Error(`${track.json.id}: place a start/finish line first (editor, ?edit=1).`);
  const racing = new Set(['asphalt', 'kerb'].map((s) => surfaces.findIndex((x) => x.id === s)));
  const passable = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) passable[i] = racing.has(data[i]!) ? 1 : 0;

  // Block the start/finish line (3 px thick) so distance has to go round the lap.
  const dx = sf.b.x - sf.a.x, dy = sf.b.y - sf.a.y, len = Math.hypot(dx, dy);
  const n = { x: -dy / len, y: dx / len }; // right-hand normal = valid crossing direction
  for (let t = 0; t <= len; t += 0.5)
    for (let o = -1.5; o <= 1.5; o += 0.5) {
      const x = Math.round(sf.a.x + (dx * t) / len + n.x * o), y = Math.round(sf.a.y + (dy * t) / len + n.y * o);
      if (x >= 0 && y >= 0 && x < w && y < h) passable[y * w + x] = 0;
    }

  // Shortest-path distance in pixels, 8 directions (diagonal steps cost ~sqrt 2: integer weights 5 and 7,
  // a bucket queue keeps it fast), from the forward side of the line.
  const ORTH = 5, DIAG = 7;
  const cost = new Int32Array(w * h).fill(0x7fffffff);
  const buckets: number[][] = [];
  const push = (i: number, c: number) => { (buckets[c] ??= []).push(i); };
  const seedSide = (s: number): number[] => {
    const out: number[] = [];
    for (let t = 0; t <= len; t += 1) {
      const x = Math.round(sf.a.x + (dx * t) / len + n.x * 3 * s), y = Math.round(sf.a.y + (dy * t) / len + n.y * 3 * s);
      if (x >= 0 && y >= 0 && x < w && y < h && passable[y * w + x]) out.push(y * w + x);
    }
    return out;
  };
  for (const i of seedSide(1)) { cost[i] = 0; push(i, 0); }
  for (let c = 0; c < buckets.length; c++) {
    for (const i of buckets[c] ?? []) {
      if (cost[i] !== c) continue;
      const x = i % w;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          if ((!ox && !oy) || x + ox < 0 || x + ox >= w) continue;
          const j = i + oy * w + ox;
          if (j < 0 || j >= w * h || !passable[j]) continue;
          // No corner-cutting through a wall pixel on a diagonal step.
          if (ox && oy && (!passable[i + ox] || !passable[i + oy * w])) continue;
          const nc = c + (ox && oy ? DIAG : ORTH);
          if (nc < cost[j]!) { cost[j] = nc; push(j, nc); }
        }
    }
    buckets[c] = [];
  }
  const dist = Float64Array.from(cost, (v) => (v === 0x7fffffff ? Infinity : v / ORTH));
  const lap = Math.min(...seedSide(-1).map((i) => dist[i]!));
  if (!Number.isFinite(lap)) throw new Error('The racing surface doesn\'t connect the two sides of start/finish: is the line across a closed track?');

  /** A line across the track where distance = target, from the biggest contour piece, extended past the edges. */
  /** The biggest connected piece of the iso-distance contour at `target`: the track's cross-section there. */
  function crossSection(target: number): Point[] {
    const band = [];
    for (let i = 0; i < w * h; i++) if (Math.abs(dist[i]! - target) <= 0.75) band.push(i);
    // Biggest 8-connected piece of the contour (ignore stray bits).
    const inBand = new Set(band);
    let best: number[] = [];
    for (const s of band) {
      if (!inBand.has(s)) continue;
      inBand.delete(s);
      const piece = [s], st = [s];
      while (st.length) {
        const i = st.pop()!, x = i % w;
        for (let oy = -1; oy <= 1; oy++)
          for (let ox = -1; ox <= 1; ox++) {
            if (x + ox < 0 || x + ox >= w) continue;
            const j = i + oy * w + ox;
            if (inBand.has(j)) { inBand.delete(j); piece.push(j); st.push(j); }
          }
      }
      if (piece.length > best.length) best = piece;
    }
    return best.map((i) => ({ x: i % w, y: Math.floor(i / w) }));
  }

  /** Middle of the track at `target` lap distance. */
  function centreAt(target: number): Point {
    const pts = crossSection(target);
    return { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
  }

  function lineAt(target: number): TimingLine {
    // Endpoints = the two contour pixels farthest apart (along the principal axis).
    const pts = crossSection(target);
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) { sxx += (p.x - cx) ** 2; syy += (p.y - cy) ** 2; sxy += (p.x - cx) * (p.y - cy); }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ax = { x: Math.cos(ang), y: Math.sin(ang) };
    const proj = (p: Point) => (p.x - cx) * ax.x + (p.y - cy) * ax.y;
    let lo = pts[0]!, hi = pts[0]!;
    for (const p of pts) { if (proj(p) < proj(lo)) lo = p; if (proj(p) > proj(hi)) hi = p; }
    const ext = 12; // px past each edge, so a car on the kerb edge still crosses it
    let a = { x: lo.x - ax.x * ext, y: lo.y - ax.y * ext }, b = { x: hi.x + ax.x * ext, y: hi.y + ax.y * ext };
    // Orient: the arrow (right-hand normal of a->b) must point the way distance grows.
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, l = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / l, ny = (b.x - a.x) / l;
    const at = (x: number, y: number) => dist[Math.round(y) * w + Math.round(x)] ?? Infinity;
    if (at(mx + nx * 6, my + ny * 6) < at(mx - nx * 6, my - ny * 6)) [a, b] = [b, a];
    const r = (v: number) => Math.round(v * 2) / 2;
    return { a: { x: r(a.x), y: r(a.y) }, b: { x: r(b.x), y: r(b.y) } };
  }

  /**
   * Near `fraction` of the lap (+/- 8%), the narrowest crossing: the shortest line across the track is
   * the straightest bit (a line through the middle of a hairpin is long and awkward).
   */
  function bestNear(fraction: number): { line: TimingLine; at: number } {
    let best: { line: TimingLine; at: number; len: number } | undefined;
    for (let f = fraction - 0.08; f <= fraction + 0.0801; f += 0.01) {
      const line = lineAt(lap * f);
      const l = Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y);
      // Prefer near the exact third when widths are about equal.
      const score = l * (1 + Math.abs(f - fraction));
      if (!best || score < best.len) best = { line, at: f, len: score };
    }
    return best!;
  }
  return { dist, lap, lineAt, bestNear, centreAt };
}
