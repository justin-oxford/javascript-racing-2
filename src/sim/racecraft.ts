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
  /** COVERING (AI overtaking round 3): the INSIDE line starts this far before the corner (ramping in over
   *  insideLeadM), so a defender covering the inside is there through the braking zone. Absent: insideLeadM. */
  coverLeadM?: number;
  /** The INSIDE line moves sideways at most this many metres per metre along (absent: no limit). */
  insideSlope?: number;
  /** ...then this many passes of a 5-point average round off its corners. */
  insideSmooth?: number;
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
  /** ...and stays ATTACKING within attackStayGapSec of it, closing or not (absent: 0). */
  attackStayGapSec?: number;
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

/** Shrink offsets (never grow them: they stay inside the road) until neighbouring points differ by at most maxStep
 *  metres, round the loop; changing side passes through 0. The INSIDE line's room collapses to nothing at most apexes
 *  (the racing line touches the inside there) and corners' lead-ins overlap: unlimited, its offset jumped 2.5 m in a
 *  few metres, and on the kinks its speed profile fell to 6 m/s (a 37 s lap against 27 s, AI overtaking round 3). */
export function limitSlope(off: Float64Array, maxStep: number): void {
  const n = off.length;
  if (!Number.isFinite(maxStep) || n < 3) return;
  for (let pass = 0; pass < 4; pass++) for (const dir of [1, -1]) {
    for (let k = 0; k < 2 * n; k++) {
      const q = dir > 0 ? k % n : (2 * n - 1 - k) % n, prev = off[(q - dir + n) % n]!, v = off[q]!;
      const cap = Math.sign(v) === Math.sign(prev) || prev === 0 ? Math.abs(prev) + maxStep : Math.max(0, maxStep - Math.abs(prev));
      if (Math.abs(v) > cap) off[q] = Math.sign(v) * cap;
    }
  }
}

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
    const cover = Math.max(lead, Math.round((cfg.coverLeadM ?? cfg.insideLeadM) / step));
    for (let j = -cover; j <= len + 3; j++) {
      const q = wrap(c.from + j, n), w = bump(j, -cover, -cover + lead, apexAt, len + 3);
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
  limitSlope(inside, (cfg.insideSlope ?? Infinity) * step);
  // ...and rounded off (a few passes of a 5-point average, kept inside the road): the slope limit's corners are
  // curvature spikes of their own.
  if (cfg.insideSlope !== undefined) for (let pass = 0; pass < (cfg.insideSmooth ?? 0); pass++) {
    const src = Float64Array.from(inside);
    for (let q = 0; q < n; q++) {
      let v = 0;
      for (let d = -2; d <= 2; d++) v += src[wrap(q + d, n)]!;
      v /= 5;
      inside[q] = v > 0 ? Math.min(v, room(q, 1)) : Math.max(v, -room(q, -1));
    }
  }
  return { exit, inside };
}

/**
 * EXIT line, time-weighted (Racing line optimizer card, Justin 2026-11-13): for every corner followed by at least
 * exitStraightM of straight, move the line sideways by a sum of smooth bumps (no kinks) from exitLeadM before
 * the corner to exitShiftM after it, choosing the bump sizes that minimise the TIME from before the corner to
 * the end of the following straight. `timeOver(offsets, from, to)` is the lap's speed profile on the offset
 * line, timed over line points from..to (the caller supplies the physics). Inside the track: room minus half a
 * car and edgeM. Returns offsets (+ = right of travel), 0 away from those corners.
 */
export function optimizeExitOffsets(line: LinePath, timeOver: (off: Float64Array, from: number, to: number) => number, cfg: Pick<RacecraftConfig, 'exitStraightM' | 'exitShiftM' | 'edgeM'> & { exitLeadM: number; exitBumps: number }, halfCarM: number): Float64Array {
  const n = line.n, step = 2, corners = cornersOf(line), out = new Float64Array(n);
  const room = (q: number, side: number) => Math.max(0, (side > 0 ? line.right[q]! : line.left[q]!) - halfCarM - cfg.edgeM);
  corners.forEach((c, ci) => {
    const next = corners[(ci + 1) % corners.length]!;
    if (wrap(next.from - c.to, n) * step < cfg.exitStraightM) return;
    const a = c.from - Math.round(cfg.exitLeadM / step), b = c.to + Math.round(cfg.exitShiftM / step), span = b - a;
    const to = a + wrap(next.from - a, n); // timed to the end of the straight (unwrapped: may run past index 0)
    const K = Math.max(2, cfg.exitBumps), width = span / (K - 1) * 1.25;
    // Raised-cosine bumps, centred evenly between the ends (each end itself pinned at 0).
    const centre = (k: number) => a + (span * (k + 1)) / (K + 1);
    const basis = (k: number, j: number) => { const u = (j - centre(k)) / width; return Math.abs(u) < 1 ? 0.5 * (1 + Math.cos(Math.PI * u)) : 0; };
    const coef = new Float64Array(K);
    const build = (cf: Float64Array): Float64Array | undefined => {
      const off = Float64Array.from(out);
      for (let j = a; j <= b; j++) {
        let v = 0;
        for (let k = 0; k < K; k++) v += cf[k]! * basis(k, j);
        const q = wrap(j, n);
        if (v > room(q, 1) + 1e-9 || -v > room(q, -1) + 1e-9) return undefined; // off the usable road
        off[q] = v;
      }
      return off;
    };
    let best = timeOver(build(coef)!, a, to);
    for (const h of [1, 0.5, 0.25, 0.1]) {
      for (let pass = 0, improved = true; pass < 6 && improved; pass++) {
        improved = false;
        for (let k = 0; k < K; k++) for (const dir of [-1, 1]) {
          const cand = Float64Array.from(coef); cand[k] = cand[k]! + dir * h;
          const off = build(cand);
          if (!off) continue;
          const t = timeOver(off, a, to);
          if (t < best - 1e-4) { best = t; coef.set(cand); improved = true; }
        }
      }
    }
    const done = build(coef)!;
    for (let j = a; j <= b; j++) out[wrap(j, n)] = done[wrap(j, n)]!;
  });
  return out;
}

/** Offsets of a stored line (track.json racingLineExit, metres) from this line, point by point (+ = right). */
export function offsetsFromPoints(line: LinePath, pts: ReadonlyArray<{ x: number; y: number }>): Float64Array {
  const n = line.n, out = new Float64Array(n);
  if (pts.length < 3) return out;
  let j = 0, bd = Infinity;
  for (let i = 0; i < pts.length; i++) { const d = (pts[i]!.x - line.x[0]!) ** 2 + (pts[i]!.y - line.y[0]!) ** 2; if (d < bd) { bd = d; j = i; } }
  for (let q = 0; q < n; q++) {
    // Walk forward along the stored points to the nearest one (they run the same way round).
    for (let s = 0; s < 8; s++) {
      const nj = (j + 1) % pts.length, dn = (pts[nj]!.x - line.x[q]!) ** 2 + (pts[nj]!.y - line.y[q]!) ** 2, dc = (pts[j]!.x - line.x[q]!) ** 2 + (pts[j]!.y - line.y[q]!) ** 2;
      if (dn < dc) j = nj; else break;
    }
    const a = wrap(q - 1, n), b = wrap(q + 1, n);
    const tx = line.x[b]! - line.x[a]!, ty = line.y[b]! - line.y[a]!, l = Math.hypot(tx, ty) || 1;
    out[q] = (pts[j]!.x - line.x[q]!) * (-ty / l) + (pts[j]!.y - line.y[q]!) * (tx / l);
  }
  return out;
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

/** AI overtaking card (config/ai.json "overtaking"). */
export interface OvertakingConfig {
  /** Overlapped = within this much lengthwise (centre to centre): front wheels past the other car's rear wheels. */
  overlapM: number;
  /** Pull out of a tow this many seconds before the braking point, plus aggression x pullOutAggrSec. */
  pullOutSec: number;
  pullOutAggrSec: number;
  /** ATTACKING, out of braking zones: follow at a car length + 1.5 m + this x (1.5 - aggression) seconds. */
  attackHeadwaySec: number;
  /** ...except within this many seconds of a braking point (the full headway into braking zones). */
  closeUntilBrakeSec: number;
  /** ...on lap one (the whole field nose to tail; absent: closeUntilBrakeSec). */
  lapOneCloseUntilBrakeSec?: number;
  /** ATTACKING, following: plan braking at this fraction of its braking (0.8 when merely following). */
  attackFollowBrake: number;
  /** Pulled out and closing within commitM: the move is on (it keeps that side until past, or aborts if the car
   *  gets more than commitM away, or it isn't alongside, within 1.5 car lengths, by the corner). */
  commitM: number;
  /** A committed move looks this many seconds ahead for room (absent: the usual 2 s). */
  commitLookSec?: number;
  /** A car with another overlapped on its inside for the coming corner takes a line a car width + gap wide of it. */
  leaveRoom?: boolean;
  /** A defender with aggression below this lifts and lets an overlapped car on the inside go. */
  concedeBelow: number;
  /** BLUE FLAGS: a car this many laps or more ahead in the race always has the right of way, and once it's
   *  pulled out and alongside (its nose within blueBehindM behind ours up to overlapM ahead) the lapped car lifts. */
  blueLaps: number;
  blueBehindM: number;
  /** How much a lapped car lifts on the straight to let it by (fraction of its speed). */
  blueLift: number;
}

/** Whether the OTHER car has the right of way (the one without it yields when there's no room for both).
 *  The overlap rule: side by side within overlapM lengthwise (front wheels past the other car's rear wheels)
 *  with a corner coming, the car on its INSIDE has it, so the car on the outside leaves it room rather than
 *  turn in on it. Otherwise the car ahead has it; level, the lower car number. Exactly one of a pair has it.
 *  ahead: other's distance ahead of us (m), side: its lateral offset (+ right), nextTurn: +1 right, -1 left, 0 none. */
export function otherHasRightOfWay(ahead: number, side: number, nextTurn: number, otherIsLower: boolean, overlapM: number): boolean {
  if (nextTurn !== 0 && Math.abs(ahead) <= overlapM && side !== 0) return Math.sign(side) === nextTurn;
  return ahead > 0.5 || (Math.abs(ahead) <= 0.5 && otherIsLower);
}

/** Conceding: a low-aggression defender heading into a braking zone, with a car overlapped on the inside of
 *  the corner (just behind or level), lifts and lets it go rather than turn in on it. */
export function concedes(aggression: number, brakingSoon: boolean, ahead: number, side: number, nextTurn: number, widthM: number, cfg: OvertakingConfig): boolean {
  return brakingSoon && aggression < cfg.concedeBelow && nextTurn !== 0 && ahead <= 0 && ahead >= -cfg.overlapM
    && Math.sign(side) === nextTurn && Math.abs(side) >= widthM;
}

/** Blue flags: whether to lift for a car lapping us (raceLapsAhead laps further on) that has pulled out
 *  (at least a car width across) and come alongside (ahead m: from blueBehindM behind to overlapM ahead). */
export function blueFlag(raceLapsAhead: number, ahead: number, side: number, widthM: number, cfg: OvertakingConfig): boolean {
  return raceLapsAhead >= cfg.blueLaps && ahead >= -cfg.blueBehindM && ahead <= cfg.overlapM && Math.abs(side) >= widthM;
}

/** Which line a mode wants at line point q: ATTACK takes EXIT where there is one (onto a straight), else the racing line.
 *  A defender that chose to COVER the inside into this braking zone (defenceChoice) takes INSIDE. */
export function lineFor(mode: CraftMode, q: number, offsets: { exit: Float64Array; inside: Float64Array }, cover = false): LineId {
  if (cover && offsets.inside[q] !== 0) return 'inside';
  // ATTACK takes EXIT where there is one, else stays on the racing line: the INSIDE line is the slower way
  // round, and taking it into every corner while attacking just dropped the attacker back (AI overtaking card).
  if (mode === 'attack') return offsets.exit[q] !== 0 ? 'exit' : 'neutral';
  // DEFEND holds the racing line too: on the slower INSIDE line, defenders got run into from behind (AI
  // overtaking card measurements). The INSIDE line stays generated, for the editor and later use.
  return 'neutral';
}

/** The racecraft mode from the race situation (gaps in seconds; Infinity = nobody there). */
export function chooseMode(s: { aheadGapSec: number; aheadClosing: boolean; inTow: boolean; behindGapSec: number; behindClosing: boolean; wear: number; damage: number }, cfg: RacecraftConfig): CraftMode {
  if (s.wear < cfg.nurseWear || s.damage > cfg.nurseDamage) return 'nurse';
  if (s.behindGapSec < cfg.defendGapSec && s.behindClosing) return 'defend';
  // (Round 3: also while right behind it, closing or not: in and out of ATTACK with every speed change, the
  // close-up never lasted through a corner.)
  if ((s.aheadGapSec < cfg.attackGapSec && (s.aheadClosing || s.aheadGapSec < (cfg.attackStayGapSec ?? 0))) || s.inTow) return 'attack';
  return 'manage';
}

/** AI overtaking round 3 (config/ai.json "defence"): the defender's choice into each braking zone.
 *  COVER the inside (one move before the braking zone: the INSIDE line, slower through the corner; the attacker's
 *  answer is the cutback) or HOLD the racing line (the inside stays open: a close attacker dives). */
export interface DefenceConfig {
  /** Decide this many seconds before the braking point, against the nearest car within gapSec behind. */
  decideSec: number;
  gapSec: number;
  /** The chance to cover, as a logistic: bias + aggrW x (aggression - 0.5) + threatW x (1 + craftW x (racecraft -
   *  0.5)) x (threat - 0.5) - tyreW x tyre used. threat (0..1): how close (gap), how fast it's closing (closingRefMps
   *  = all of it), and whether it has the tow or is deploying. */
  bias: number;
  aggrW: number;
  threatW: number;
  craftW: number;
  tyreW: number;
  closingRefMps: number;
  /** A car ahead is on the INSIDE line (covering) once this far toward the corner's inside (m). */
  coverDetectM: number;
}

export interface DefenceSituation {
  /** The defender's AGGRESSION and RACECRAFT, 0..1. */
  aggression: number;
  racecraft: number;
  /** The attacker: seconds behind, closing speed (m/s), in the tow or deploying. */
  gapSec: number;
  closingMps: number;
  tow: boolean;
  /** The defender's tyres: fraction used (0 new .. 1 gone). */
  tyreUsed: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** How threatening the attacker is, 0..1: half from the gap, 0.3 from its closing speed, 0.2 the tow / deploy. */
export function defenceThreat(s: DefenceSituation, cfg: DefenceConfig): number {
  return 0.5 * clamp01(1 - s.gapSec / cfg.gapSec) + 0.3 * clamp01(s.closingMps / cfg.closingRefMps) + (s.tow ? 0.2 : 0);
}

/** The chance the defender covers the inside (vs holding the racing line). Aggressive drivers cover more; good
 *  racecraft covers when the threat is real and holds when it isn't (a sharper response to the threat); worn
 *  tyres make covering (the slower line, every lap) less attractive. The draw against it is seeded noise. */
export function coverChance(s: DefenceSituation, cfg: DefenceConfig): number {
  const z = cfg.bias + cfg.aggrW * (s.aggression - 0.5) + cfg.threatW * (1 + cfg.craftW * (s.racecraft - 0.5)) * (defenceThreat(s, cfg) - 0.5) - cfg.tyreW * s.tyreUsed;
  return 1 / (1 + Math.exp(-z));
}
