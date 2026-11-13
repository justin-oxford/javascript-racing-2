// Setup balance readout (Car setup overhaul card): per corner of the racing line, which axle went past its
// grip limit first on each of the player's passes (handling-diag's numbers, for one driver, live). "T3: front
// first 70%" says add front wing / soften the front. Client only; reads sim state.
import type { CarState, RacingLine } from '../../sim';

export interface Corner { from: number; to: number; dir: 'L' | 'R' }

/** Corners: runs of racing-line points with |curvature| > 1/80 m, small gaps merged, at least 8 m long. */
export function cornersOf(line: Pick<RacingLine, 'n' | 'k'>): Corner[] {
  const n = line.n, bend = (q: number) => Math.abs(line.k[((q % n) + n) % n]!) > 1 / 80;
  const out: Corner[] = [];
  let start = 0;
  while (bend(start) && start < n) start++; // begin on a straight so no corner straddles index 0
  let q = start, cur: { from: number; to: number } | undefined;
  for (let k = 0; k < n; k++, q++) {
    const i = q % n;
    if (bend(i)) { if (!cur) cur = { from: i, to: i }; else cur.to = i; }
    else if (cur && !(bend(i + 1) || bend(i + 2))) {
      const len = ((cur.to - cur.from + n) % n) + 1;
      if (len >= 4) {
        let sum = 0;
        for (let j = 0; j < len; j++) sum += line.k[(cur.from + j) % n]!;
        out.push({ ...cur, dir: sum > 0 ? 'R' : 'L' });
      }
      cur = undefined;
    }
  }
  return out;
}

export interface CornerBalance { front: number; rear: number; neither: number }

/** Tracks one car's passes through each corner: which axle (the loaded, outside wheel) went past peak first. */
export class BalanceTracker {
  readonly corners: Corner[];
  readonly stats: CornerBalance[];
  private near = -1;
  private corner = -1;
  private first: '' | 'front' | 'rear' = '';

  constructor(private readonly line: RacingLine) {
    this.corners = cornersOf(line);
    this.stats = this.corners.map(() => ({ front: 0, rear: 0, neither: 0 }));
  }

  reset(): void {
    for (const s of this.stats) { s.front = 0; s.rear = 0; s.neither = 0; }
    this.corner = -1;
    this.first = '';
  }

  /** After each sim tick, with the player's car. */
  update(c: CarState): void {
    const l = this.line;
    // Nearest racing-line point (local search from the last one).
    let best = -1, bd = Infinity;
    const scan = (q: number) => { const d = (l.x[q]! - c.x) ** 2 + (l.y[q]! - c.y) ** 2; if (d < bd) { bd = d; best = q; } };
    if (this.near >= 0) for (let d = -8; d <= 12; d++) scan((((this.near + d) % l.n) + l.n) % l.n);
    if (best < 0 || bd > 15 * 15) for (let q = 0; q < l.n; q++) scan(q);
    this.near = best;
    const k = bd < 12 * 12 ? this.corners.findIndex((r) => (r.from <= r.to ? best >= r.from && best <= r.to : best >= r.from || best <= r.to)) : -1;
    if (k !== this.corner) { this.close(); this.corner = k; }
    if (k < 0 || this.first) return;
    const aRight = c.speed * c.angVel;
    const f = c.wheels[aRight > 0 ? 0 : 1].usage > 1, r = c.wheels[aRight > 0 ? 2 : 3].usage > 1;
    if (f || r) this.first = f && !r ? 'front' : r && !f ? 'rear' : 'front'; // both on one tick: count it as the front (it's steering-led)
  }

  private close(): void {
    if (this.corner >= 0) {
      const s = this.stats[this.corner]!;
      if (this.first === 'front') s.front++; else if (this.first === 'rear') s.rear++; else s.neither++;
    }
    this.corner = -1;
    this.first = '';
  }
}
