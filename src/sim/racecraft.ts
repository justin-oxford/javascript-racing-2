// AI racecraft (POLISH card): three racing lines and a racecraft mode that picks between them.
//   NEUTRAL  the racing line itself (minimum curvature)
//   EXIT     slow in, fast out: through a corner that leads onto a long straight, the neutral line's lateral
//            path shifted later (a later apex), for more speed down the straight
//   INSIDE   tighter to the inside into braking zones: where you out-brake someone or cover the inside
// EXIT and INSIDE are lateral offsets from the neutral line, point for point (same indices), so the AI blends
// between lines by blending an offset, and each line has its own speed profile. Derived from the neutral line
// when it's built (no extra track data to keep in step).
// Modes (re-evaluated a few times a second, with hysteresis): MANAGE (default) / ATTACK (a car ahead close and
// closing, or in its tow) / DEFEND (a car behind close and closing) / NURSE (worn tyres or damage).

/** A closed path in metres with curvature (+ = turning right) and room to the edges (the AI's AiPath). */
export interface LinePath { n: number; x: Float64Array; y: Float64Array; k: Float64Array; left: Float64Array; right: Float64Array }

export interface Corner { from: number; to: number; dir: 'L' | 'R'; apex: number }

/** Corners: runs of line points with |curvature| > 1/80 m, small gaps merged, at least 8 m long (handling-diag). */
export function cornersOf(line: Pick<LinePath, 'n' | 'k'>): Corner[] {
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
        let sum = 0, kMax = 0, apex = cur.from;
        for (let j = 0; j < len; j++) { const p = (cur.from + j) % n; sum += line.k[p]!; if (Math.abs(line.k[p]!) > kMax) { kMax = Math.abs(line.k[p]!); apex = p; } }
        out.push({ ...cur, dir: sum > 0 ? 'R' : 'L', apex });
      }
      cur = undefined;
    }
  }
  return out;
}

/** config/ai.json racecraft. */
export interface RacecraftConfig {
  enabled: boolean;
  /** INSIDE: how far toward the inside (m), starting insideLeadM before the corner. */
  insideM: number;
  insideLeadM: number;
  /** EXIT: only for corners followed by at least exitStraightM of straight; re-optimised through the corner and
   *  exitShiftM past it with the exit's curvature weighted exitWeight x the entry's (a later apex). */
  exitStraightM: number;
  exitShiftM: number;
  exitWeight: number;
  exitIterations: number;
  /** Keep this far from the track edge (m, beyond half a car). */
  edgeM: number;
  /** ATTACK within attackGapSec of the car ahead (closing, or in its tow); DEFEND with a car within defendGapSec behind, closing. */
  attackGapSec: number;
  defendGapSec: number;
  /** NURSE when the average tyre is below this (raw wear) or any damage zone is past nurseDamage. */
  nurseWear: number;
  nurseDamage: number;
  /** Re-evaluate every evalSec; hold a mode at least holdSec (hysteresis). */
  evalSec: number;
  holdSec: number;
  /** Line blend: how much of a change per metre travelled (1 / blendPerM metres for a full change). */
  blendPerM: number;
}

export type CraftMode = 'manage' | 'attack' | 'defend' | 'nurse';
export type LineId = 'neutral' | 'exit' | 'inside';
export const LINE_IDS: readonly LineId[] = ['neutral', 'exit', 'inside'];

const wrap = (q: number, n: number) => ((q % n) + n) % n;
/** 0..1..0 bump: 0 at a, rising to 1 at b, 1 until c, back to 0 at d (indices along the loop, a<=b<=c<=d unwrapped). */
const bump = (i: number, a: number, b: number, c: number, d: number) => (i < a || i > d ? 0 : i < b ? (i - a) / Math.max(1, b - a) : i <= c ? 1 : (d - i) / Math.max(1, d - c));

/** Lateral offsets (m, + = right) for EXIT and INSIDE, point for point on the neutral line. */
export function lineOffsets(line: LinePath, cfg: RacecraftConfig, halfCarM: number): { exit: Float64Array; inside: Float64Array } {
  const n = line.n, step = 2, corners = cornersOf(line);
  const exit = new Float64Array(n), inside = new Float64Array(n);
  const room = (q: number, side: number) => Math.max(0, (side > 0 ? line.right[q]! : line.left[q]!) - halfCarM - cfg.edgeM);
  // Which corner each point belongs to: a corner's own body beats another's lead-in (a chicane's second
  // corner mustn't pull the car to the wrong side at the first one's apex).
  const owner = new Int16Array(n).fill(-1);
  corners.forEach((c, ci) => { for (let j = 0; j <= wrap(c.to - c.from, n) + 3; j++) owner[wrap(c.from + j, n)] = ci; });
  corners.forEach((c, ci) => {
    const len = wrap(c.to - c.from, n), side = c.dir === 'R' ? 1 : -1;
    // INSIDE: ramp in over insideLeadM before the corner, hold to the apex, out by the corner's end.
    const lead = Math.round(cfg.insideLeadM / step), apexAt = wrap(c.apex - c.from, n);
    for (let j = -lead; j <= len + 3; j++) {
      const q = wrap(c.from + j, n), w = bump(j, -lead, 0, apexAt, len + 3);
      if (owner[q] !== -1 && owner[q] !== ci) continue; // another corner's body
      const v = side * Math.min(cfg.insideM, room(q, side)) * w;
      if (owner[q] === ci || Math.abs(v) > Math.abs(inside[q]!)) inside[q] = v;
    }
    // EXIT: only before a long straight. Re-optimise the line's sideways position through the corner to
    // minimise curvature weighted far more on the exit than the entry (exitWeight): the apex moves later and
    // the car straightens up sooner onto the straight. Ends pinned to the neutral line; inside the track.
    const next = corners[(ci + 1) % corners.length]!;
    const straight = wrap(next.from - c.to, n) * step;
    if (straight < cfg.exitStraightM) return;
    const a0 = -lead, a1 = len + Math.round(cfg.exitShiftM / step) + 10, m = a1 - a0 + 1;
    const qs = Array.from({ length: m }, (_, j) => wrap(c.from + a0 + j, n));
    const w = qs.map((_, j) => (a0 + j <= apexAt ? 1 : cfg.exitWeight));
    const d = new Float64Array(m), h2 = step * step;
    const kAt = (j: number) => line.k[qs[j]!]! + (d[j - 1]! - 2 * d[j]! + d[j + 1]!) / h2;
    const rate = (h2 * h2) / (16 * Math.max(...w)) * 0.9;
    for (let it = 0; it < cfg.exitIterations; it++) {
      for (let j = 2; j < m - 2; j++) {
        // dE/dd_j for E = sum w k^2, with k_i depending on d_{i-1}, d_i, d_{i+1}.
        const g = (2 / h2) * (w[j - 1]! * kAt(j - 1) - 2 * w[j]! * kAt(j) + w[j + 1]! * kAt(j + 1));
        let v = d[j]! - rate * g;
        v = v > 0 ? Math.min(v, room(qs[j]!, 1)) : Math.max(v, -room(qs[j]!, -1));
        d[j] = v;
      }
    }
    for (let j = 0; j < m; j++) if (Math.abs(d[j]!) > Math.abs(exit[qs[j]!]!)) exit[qs[j]!] = d[j]!;
  });
  return { exit, inside };
}

/** A variant line's points (neutral + offset along the right-hand normal) and their curvature. */
export function offsetPath(line: LinePath, off: Float64Array): { x: Float64Array; y: Float64Array; k: Float64Array } {
  const n = line.n, x = new Float64Array(n), y = new Float64Array(n), k = new Float64Array(n), raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = wrap(i - 1, n), b = wrap(i + 1, n);
    const tx = line.x[b]! - line.x[a]!, ty = line.y[b]! - line.y[a]!, l = Math.hypot(tx, ty) || 1;
    // Right of travel (heading 0 = up = -y): (-ty, tx) / l.
    x[i] = line.x[i]! + (-ty / l) * off[i]!;
    y[i] = line.y[i]! + (tx / l) * off[i]!;
  }
  for (let i = 0; i < n; i++) {
    const a = wrap(i - 3, n), b = wrap(i + 3, n);
    const ax = x[i]! - x[a]!, ay = y[i]! - y[a]!, bx = x[b]! - x[i]!, by = y[b]! - y[i]!;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by), lc = Math.hypot(x[b]! - x[a]!, y[b]! - y[a]!);
    raw[i] = la && lb && lc ? (2 * (ax * by - ay * bx)) / (la * lb * lc) : 0;
  }
  for (let i = 0; i < n; i++) k[i] = (raw[wrap(i - 1, n)]! + 2 * raw[i]! + raw[wrap(i + 1, n)]!) / 4;
  return { x, y, k };
}

/**
 * Keep an EXIT line only where it earns it: per corner, the EXIT speed profile must be faster 30 m into the
 * following straight than the neutral one, and not cost more than half the corner's minimum speed. Elsewhere
 * its offsets are zeroed (ATTACK then takes INSIDE there). `neutral` / `exit` are speed profiles (m/s).
 */
export function keepGoodExits(line: LinePath, offsets: { exit: Float64Array; inside: Float64Array }, neutral: ArrayLike<number>, exit: ArrayLike<number>, cfg: RacecraftConfig): { exit: Float64Array; inside: Float64Array } {
  const n = line.n, corners = cornersOf(line), out = Float64Array.from(offsets.exit);
  const lead = Math.round(cfg.insideLeadM / 2);
  corners.forEach((c) => {
    const len = wrap(c.to - c.from, n), span = len + Math.round(cfg.exitShiftM / 2) + 10;
    const qs = Array.from({ length: span + lead + 1 }, (_, j) => wrap(c.from - lead + j, n));
    if (!qs.some((q) => out[q] !== 0)) return;
    let minN = Infinity, minE = Infinity;
    for (let j = 0; j <= len; j++) { const q = wrap(c.from + j, n); minN = Math.min(minN, neutral[q]!); minE = Math.min(minE, exit[q]!); }
    const into = wrap(c.to + 15, n);
    if (!(exit[into]! > neutral[into]! + 0.15 && minE > 0.5 * minN)) for (const q of qs) out[q] = 0;
  });
  return { exit: out, inside: offsets.inside };
}

/** Which line a mode wants at line point q: ATTACK takes EXIT where there is one (onto a straight) else INSIDE. */
export function lineFor(mode: CraftMode, q: number, offsets: { exit: Float64Array; inside: Float64Array }): LineId {
  if (mode === 'attack') return offsets.exit[q] !== 0 ? 'exit' : 'inside';
  if (mode === 'defend') return 'inside';
  return 'neutral';
}

/** The racecraft mode from the race situation (gaps in seconds; Infinity = nobody there). */
export function chooseMode(s: { aheadGapSec: number; aheadClosing: boolean; inTow: boolean; behindGapSec: number; behindClosing: boolean; wear: number; damage: number }, cfg: RacecraftConfig): CraftMode {
  if (s.wear < cfg.nurseWear || s.damage > cfg.nurseDamage) return 'nurse';
  if (s.behindGapSec < cfg.defendGapSec && s.behindClosing) return 'defend';
  if ((s.aheadGapSec < cfg.attackGapSec && s.aheadClosing) || s.inTow) return 'attack';
  return 'manage';
}
