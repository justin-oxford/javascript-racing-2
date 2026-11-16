// Racing line optimizer (card "Racing line optimizer"). Pure: runs in the editor (browser) and in
// tools/optimize-racing-line.ts (Node).
//
// 1. SEED: the track's hand-placed or earlier line, for driving direction only. Resampled evenly.
// 2. USABLE WIDTH: along each point's normal, how far the line may move before the car (half its width
//    + a safety margin) would leave the racing surface. Kerbs count for `kerbUse` of their width.
// 3. OPTIMIZE: each point moves only sideways, t[i] along the seed normal, to minimise total squared
//    curvature (second differences), optionally blended toward the shortest path. A box-constrained
//    quadratic: projected Gauss-Seidel with over-relaxation, then a distance-transform check pushes any
//    point that's too close to an edge back in, so the line can never cost a lap (all four wheels off).
// 4. SPEED PROFILE: max corner speed from curvature and the car's grip (03b tyres), then a backward
//    pass (braking, friction circle) and a forward pass (acceleration).
import { mechLockRad, type PhysicsConfig, type Stats } from './car-config';
import type { Point, SimTrack } from './track';
import { surfaceAt } from './track';
import { offsetPath, optimizeExitOffsets, type LinePath } from './racecraft';

const G = 9.81;

/** config/racing-line.json */
export interface LineOptimizerConfig {
  spacingM: number;
  /** Extra room beyond half the car's width, metres. */
  safetyMarginM: number;
  /** How much of a kerb the line may use, 0..1. */
  kerbUse: number;
  /** 0 = pure minimum curvature; higher pulls toward the shortest path on gentle sections. */
  shortestBlend: number;
  iterations: number;
  /** Over-relaxation, 1..1.9. */
  relax: number;
  /** Hard rule 1: room beyond half the car's width that must be drivable (asphalt / kerb) all along the line, metres. Absent = 0.2. */
  footprintMarginM?: number;
  /** Hard rule 2: the line's radius over the car's tightest radius at the planned speed must be at least this. Absent = 0.99. */
  turnRatioMin?: number;
}

export interface OptimizedLine {
  /** Track pixels, closed, in driving order. */
  line: Point[];
  lengthM: number;
  minRadiusM: number;
  /** Smallest distance from the line to the edge of what it may use (asphalt + kerbUse of kerbs), metres; >= half width + margin. */
  minClearanceM: number;
  /** Points the clearance check had to push back in. */
  pushedIn: number;
}

/** Resample a closed polyline to n evenly spaced points. */
function resampleClosed(src: readonly Point[], n: number): Point[] {
  const cum = [0];
  for (let i = 1; i <= src.length; i++) {
    const a = src[i - 1]!, b = src[i % src.length]!;
    cum.push(cum[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = cum[src.length]!;
  const out: Point[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (total * k) / n;
    while (j < src.length - 1 && cum[j + 1]! < s) j++;
    const a = src[j]!, b = src[(j + 1) % src.length]!, f = (s - cum[j]!) / (cum[j + 1]! - cum[j]! || 1);
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  }
  return out;
}

/** Chamfer (3-4) distance in pixels from each pixel to the nearest pixel where `inside` is false. */
function distanceTo(track: SimTrack, inside: (palette: number) => boolean): Float32Array {
  const { width: w, height: h, data } = track.mask;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = inside(data[i]!) ? 1e9 : 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w]! + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1]! + 1.414);
        if (x < w - 1) v = Math.min(v, d[i - w + 1]! + 1.414);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i]!;
      if (x < w - 1) v = Math.min(v, d[i + 1]! + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w]! + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1]! + 1.414);
        if (x > 0) v = Math.min(v, d[i + w - 1]! + 1.414);
      }
      d[i] = v;
    }
  return d;
}

export function optimizeRacingLine(track: SimTrack, seedPx: readonly Point[], cfg: LineOptimizerConfig, physics: Pick<PhysicsConfig, 'car'>): OptimizedLine {
  const ppm = track.json.pxPerMeter;
  const ids = track.surfaces.map((s) => s.id);
  const isAsphalt = (p: number) => ids[p] === 'asphalt';
  const isRacing = (p: number) => ids[p] === 'asphalt' || ids[p] === 'kerb';
  const need = (physics.car.widthM / 2 + cfg.safetyMarginM) * ppm; // px from the usable edge

  // Seed, evenly spaced, in px.
  let seedLen = 0;
  for (let i = 0; i < seedPx.length; i++) { const a = seedPx[i]!, b = seedPx[(i + 1) % seedPx.length]!; seedLen += Math.hypot(b.x - a.x, b.y - a.y); }
  const n = Math.max(16, Math.round(seedLen / (cfg.spacingM * ppm)));
  const seed = resampleClosed(seedPx, n);
  const at = (i: number) => ((i % n) + n) % n;
  // Normals (right of travel), from a smoothed tangent.
  const nx = new Float64Array(n), ny = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = seed[at(i - 2)]!, b = seed[at(i + 2)]!, l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    nx[i] = -(b.y - a.y) / l; ny[i] = (b.x - a.x) / l;
  }

  // HARD RULE 1 (footprint): a seed point without room for the car (on grass, an island tip, a wall) gives
  // degenerate bounds and the line could never leave it. Move it along its normal to the nearest spot with
  // room (either side, nearer wins), so the bounds below describe real road.
  const dD = distanceToUndrivable(track), fpNeed = (physics.car.widthM / 2 + (cfg.footprintMarginM ?? 0.2)) * ppm;
  const roomD = (x: number, y: number) => { const ix = Math.floor(x), iy = Math.floor(y); return ix < 0 || iy < 0 || ix >= track.mask.width || iy >= track.mask.height ? 0 : dD[iy * track.mask.width + ix]!; };
  let seedMoved = 0;
  for (let i = 0; i < n; i++) {
    const p = seed[i]!;
    if (roomD(p.x, p.y) >= fpNeed) continue;
    for (let d = 0.25 * ppm; d <= 15 * ppm; d += 0.25 * ppm) {
      const a = { x: p.x + nx[i]! * d, y: p.y + ny[i]! * d }, b = { x: p.x - nx[i]! * d, y: p.y - ny[i]! * d };
      const okA = roomD(a.x, a.y) >= fpNeed, okB = roomD(b.x, b.y) >= fpNeed;
      if (okA || okB) { seed[i] = okA ? a : b; seedMoved++; break; }
    }
  }

  // Usable width each side: march along the normal; asphalt counts fully, a kerb for kerbUse of it.
  const lo = new Float64Array(n), hi = new Float64Array(n);
  const step = 0.25 * ppm, maxD = 30 * ppm;
  for (let i = 0; i < n; i++) {
    const p = seed[i]!;
    const reach = (sign: number) => {
      let asphalt = -1, racing = -1;
      for (let d = 0; d <= maxD; d += step) {
        const s = surfaceAt(track, p.x + nx[i]! * sign * d, p.y + ny[i]! * sign * d);
        if (asphalt < 0 && !isAsphalt(s)) asphalt = d;
        if (!isRacing(s)) { racing = d; break; }
      }
      if (racing < 0) racing = maxD;
      if (asphalt < 0) asphalt = racing;
      return asphalt + cfg.kerbUse * Math.max(0, racing - asphalt) - need;
    };
    hi[i] = reach(1);
    lo[i] = -reach(-1);
    if (lo[i]! > hi[i]!) lo[i] = hi[i] = (lo[i]! + hi[i]!) / 2; // narrower than the car + margin: stay central
  }

  // Minimise sum |P[i-1] - 2P[i] + P[i+1]|^2 + blend * sum |P[i+1] - P[i]|^2, P[i] = seed[i] + t[i] n[i].
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = Math.min(hi[i]!, Math.max(lo[i]!, 0));
  const px = (i: number) => seed[at(i)]!.x + t[at(i)]! * nx[at(i)]!;
  const py = (i: number) => seed[at(i)]!.y + t[at(i)]! * ny[at(i)]!;
  const lam = cfg.shortestBlend;
  const solve = (iterations: number) => {
    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < n; i++) {
        const sx = seed[i]!.x, sy = seed[i]!.y, ux = nx[i]!, uy = ny[i]!;
        // Second differences that contain P[i], with P[i] at the seed (t = 0): coefficients +1, -2, +1.
        const r = (j: number, c: number): number => {
          const ax = px(j - 1), ay = py(j - 1), bx = j === i ? sx : px(j), by = j === i ? sy : py(j), cx = px(j + 1), cy = py(j + 1);
          const dx = (j - 1 === i ? sx : ax) - 2 * bx + (j + 1 === i ? sx : cx), dy = (j - 1 === i ? sy : ay) - 2 * by + (j + 1 === i ? sy : cy);
          return c * (dx * ux + dy * uy);
        };
        let num = r(i - 1, 1) + r(i, -2) + r(i + 1, 1);
        let den = 6;
        if (lam > 0) {
          // First differences P[i] - P[i-1] (+1) and P[i+1] - P[i] (-1).
          num += lam * ((sx - px(i - 1)) * ux + (sy - py(i - 1)) * uy) - lam * ((px(i + 1) - sx) * ux + (py(i + 1) - sy) * uy);
          den += 2 * lam;
        }
        const best = -num / den;
        const relaxed = t[i]! + cfg.relax * (best - t[i]!);
        t[i] = Math.min(hi[i]!, Math.max(lo[i]!, relaxed));
      }
    }
  };

  // Check with a real distance transform (a normal can graze an edge at an angle the march missed). A
  // point that's too close tightens its bound to where there IS room, and the solve re-runs, so the
  // final line stays smooth instead of being kinked back in point by point.
  const dA = distanceTo(track, isAsphalt), dR = distanceTo(track, isRacing);
  const room = (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= track.mask.width || iy >= track.mask.height) return -1e9;
    const k = iy * track.mask.width + ix, a = dA[k]!, r = dR[k]!;
    return a + cfg.kerbUse * Math.max(0, r - a);
  };
  const roomAt = (i: number, ti: number) => room(seed[i]!.x + ti * nx[i]!, seed[i]!.y + ti * ny[i]!);
  let pushedIn = 0;
  solve(cfg.iterations);
  for (let round = 0; round < 8; round++) {
    let bad = 0;
    for (let i = 0; i < n; i++) {
      if (roomAt(i, t[i]!) >= need) continue;
      bad++;
      const toward = Math.sign((lo[i]! + hi[i]!) / 2 - t[i]!) || 1;
      let ti = t[i]!;
      for (let k = 0; k < 400 && roomAt(i, ti) < need; k++) ti += toward * 0.5;
      if (toward > 0) lo[i] = Math.min(hi[i]!, ti); else hi[i] = Math.max(lo[i]!, ti);
      t[i] = ti;
    }
    if (!bad) break;
    pushedIn += bad;
    solve(Math.ceil(cfg.iterations / 4));
  }
  // HARD RULE 1, enforced: every segment's footprint on drivable surface (footprintCheck). A point whose
  // segment fails gets its bound tightened toward room (it and its next point), and the solve re-runs.
  const ptAt = (i: number): Point => ({ x: seed[at(i)]!.x + t[at(i)]! * nx[at(i)]!, y: seed[at(i)]!.y + t[at(i)]! * ny[at(i)]! });
  let fpRounds = 0;
  for (; fpRounds < 40; fpRounds++) {
    const pts = Array.from({ length: n }, (_, i) => ptAt(i));
    const fp = footprintCheck(track, pts, physics.car.widthM / 2, cfg.footprintMarginM ?? 0.2);
    if (!fp.bad.length) break;
    for (const { i } of fp.bad)
      for (const j of [i, at(i + 1)]) {
        const toward = Math.sign((lo[j]! + hi[j]!) / 2 - t[j]!) || 1;
        let tj = t[j]! + toward * 0.5;
        for (let k = 0; k < 400 && roomD(seed[j]!.x + tj * nx[j]!, seed[j]!.y + tj * ny[j]!) < fpNeed + 0.25 * ppm; k++) tj += toward * 0.5;
        if (toward > 0) lo[j] = Math.min(hi[j]!, Math.max(lo[j]!, tj)); else hi[j] = Math.max(lo[j]!, Math.min(hi[j]!, tj));
        t[j] = tj;
      }
    pushedIn += fp.bad.length;
    solve(Math.ceil(cfg.iterations / 4));
  }

  const line: Point[] = [];
  let minClear = Infinity;
  for (let i = 0; i < n; i++) {
    const ti = t[i]!;
    const p = { x: seed[i]!.x + ti * nx[i]!, y: seed[i]!.y + ti * ny[i]! };
    minClear = Math.min(minClear, room(p.x, p.y));
    line.push(p);
  }

  let len = 0, minR = Infinity;
  for (let i = 0; i < n; i++) {
    const a = line[at(i - 1)]!, p = line[i]!, b = line[at(i + 1)]!;
    len += Math.hypot(b.x - p.x, b.y - p.y);
    const ax = p.x - a.x, ay = p.y - a.y, bx = b.x - p.x, by = b.y - p.y;
    const cross = ax * by - ay * bx, la = Math.hypot(ax, ay), lb = Math.hypot(bx, by), lc = Math.hypot(b.x - a.x, b.y - a.y);
    if (Math.abs(cross) > 1e-9) minR = Math.min(minR, (la * lb * lc) / (2 * Math.abs(cross)));
  }
  const round = (v: number) => Math.round(v * 2) / 2;
  return { line: line.map((p) => ({ x: round(p.x), y: round(p.y) })), lengthM: len / ppm, minRadiusM: minR / ppm, minClearanceM: minClear / ppm, pushedIn };
}

/** Signed curvature (1/m) of a closed or open path in metres, from points +-3 apart, lightly smoothed. */
export function pathCurvature(x: ArrayLike<number>, y: ArrayLike<number>, closed: boolean): Float64Array {
  const n = x.length;
  const at = (i: number) => (closed ? ((i % n) + n) % n : Math.min(n - 1, Math.max(0, i)));
  const raw = new Float64Array(n), k = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = at(i - 3), b = at(i + 3);
    const ax = x[i]! - x[a]!, ay = y[i]! - y[a]!, bx = x[b]! - x[i]!, by = y[b]! - y[i]!;
    const cross = ax * by - ay * bx;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by), lc = Math.hypot(x[b]! - x[a]!, y[b]! - y[a]!);
    raw[i] = la && lb && lc ? (2 * cross) / (la * lb * lc) : 0;
  }
  for (let i = 0; i < n; i++) k[i] = (raw[at(i - 1)]! + 2 * raw[i]! + raw[at(i + 1)]!) / 4;
  return k;
}

export interface ProfileOptions {
  /** Fraction of the computed corner speed used (AI preset cornerMargin; 1 for the reference line). */
  cornerMargin: number;
  /** The car's measured cornering limits (car-limits.ts cornerTable). Absent = the analytic both-axles model. */
  table?: CornerTable | undefined;
  /** Fraction of the braking estimate planned with (AI preset brakeMargin; 1 for the reference line). */
  brakeMargin: number;
  /** Fuel load for the estimate, kg. */
  fuelKg: number;
}

/**
 * Target speed (m/s) at each point of a closed path in metres: max corner speed from curvature and grip
 * (v^2 |k| = mu_lat g (1 + kAero v^2)), then backward (braking within what cornering leaves: friction
 * circle) and forward (engine + grip) passes, twice round so the lap closes up.
 */
export function speedProfile(x: ArrayLike<number>, y: ArrayLike<number>, physics: PhysicsConfig, stats: Stats, opt: ProfileOptions): Float64Array {
  const n = x.length;
  const k = pathCurvature(x, y, true);
  const ds = new Float64Array(n);
  for (let i = 0; i < n; i++) ds[i] = Math.hypot(x[(i + 1) % n]! - x[i]!, y[(i + 1) % n]! - y[i]!);
  const t = physics.tyres, c = physics.car, wf = c.weightFront;
  const mass = c.dryMassKg + opt.fuelKg;
  const axleGrip = t.frontGrip * wf + t.rearGrip * (1 - wf);
  // Fuel weight (Race strategy card): load sensitivity at this fuel load.
  const mu = t.baseGrip * stats.grip * axleGrip * (t.loadSensitivity ? (c.dryMassKg / mass) ** t.loadSensitivity : 1);
  const muLat = mu * t.lateralGrip * transferGripFactor(mu * t.lateralGrip, physics);
  const kAero = physics.aero.downforceCoef * stats.downforce;
  const vTop = (physics.engine.topSpeedKph / 3.6) * stats.topSpeed;
  const latMax = (v: number) => { if (!opt.table) return muLat * G * (1 + kAero * v * v); const u = Math.max(v, 1); return (u * u) / Math.max(1e-6, plannedRadius(opt.table, u, physics, stats, opt.fuelKg)); };
  // Steering lock limits corner speed too: the front wheels must reach about wheelbase x curvature
  // (Ackermann) within the lock available at that speed, which shrinks with speed (lockFalloffKph).
  // A car gets round a little tighter than pure geometry (tyre slip, some rotation): half a peak slip
  // angle of allowance. Without this the AI arrives at grip speed and simply can't turn tight enough.
  // Floor of 6 m/s: tighter than the lock allows at all, it can still crawl round on slip and rotation.
  const slipAllow = ((t.peakSlipDeg * Math.PI) / 180) * 0.5;
  // The fastest speed whose lock (mechLockRad, falling with speed) still reaches `need` (bisection).
  const lockV = (kk: number) => {
    const need = c.wheelbaseM * Math.abs(kk) - slipAllow;
    if (need <= 1e-6 || mechLockRad(vTop, physics.steering) >= need) return vTop;
    if (mechLockRad(0, physics.steering) <= need) return 6;
    let lo = 0, hi = vTop;
    for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (mechLockRad(mid, physics.steering) >= need) lo = mid; else hi = mid; }
    return Math.max(6, lo);
  };
  const corner = (kk: number) => {
    // MEASURED LIMITS: the fastest speed whose measured radius still fits this curvature (lock and either axle included).
    if (opt.table) return (Math.abs(kk) < 1e-9 ? vTop : plannedSpeed(opt.table, 1 / Math.abs(kk), physics, stats, vTop, opt.fuelKg)) * opt.cornerMargin;
    const den = Math.abs(kk) - muLat * G * kAero;
    const grip = den <= 0 ? vTop : Math.min(vTop, Math.sqrt((muLat * G) / den));
    return Math.min(grip, lockV(kk)) * opt.cornerMargin;
  };
  const brakeF = physics.brakes.maxForceN * stats.brakes, bias = physics.brakes.frontBias;
  const brakeA = (v: number) => {
    const grip = mu * mass * G * (1 + kAero * v * v);
    return ((Math.min(brakeF * bias, grip * wf) + Math.min(brakeF * (1 - bias), grip * (1 - wf))) / mass) * opt.brakeMargin;
  };
  const accelA = (v: number) => {
    const drive = Math.min(physics.engine.maxDriveForceN * stats.engine, (physics.engine.powerKW * 1000 * stats.engine) / Math.max(v, 1));
    const rearGrip = mu * mass * G * (1 + kAero * v * v) * (1 - wf);
    return (Math.min(drive, rearGrip) - physics.aero.dragCoef * stats.drag * v * v) / mass;
  };
  const circle = (v: number, kk: number) => { const u = Math.min(1, (v * v * Math.abs(kk)) / latMax(v)); return Math.sqrt(Math.max(0.05, 1 - u * u)); };
  // Braking while cornering, planned conservatively (linear, not the friction circle): cornering unloads
  // the inside front, and both fronts get the same brake force, so it locks long before the circle says.
  // Braking mostly happens before turn-in.
  const brakeCircle = (v: number, kk: number) => Math.max(0.05, 1 - Math.min(1, (v * v * Math.abs(kk)) / latMax(v)));
  const v = Float64Array.from(k, corner);
  for (let lap = 0; lap < 2; lap++) {
    for (let q = 2 * n - 1; q >= 0; q--) {
      const i = q % n, j = (i + 1) % n;
      v[i] = Math.min(v[i]!, Math.sqrt(v[j]! * v[j]! + 2 * brakeA(v[j]!) * brakeCircle(v[j]!, k[j]!) * ds[i]!));
    }
    for (let q = 0; q < 2 * n; q++) {
      const i = q % n, j = (i + 1) % n;
      v[j] = Math.min(v[j]!, Math.sqrt(Math.max(0, v[i]! * v[i]! + 2 * Math.max(0, accelA(v[i]!)) * circle(v[i]!, k[i]!) * ds[i]!)));
    }
  }
  return v;
}

/**
 * The EXIT line (Racing line optimizer card): the racing line moved for exit speed before long straights,
 * timed with this speed profile (see racecraft.ts optimizeExitOffsets). Returns the whole lap's points in
 * track pixels (track.json racingLineExit) and the offsets. Used by npm run optimize-exit-line and the editor.
 */
export function computeExitLine(line: LinePath, physics: PhysicsConfig, stats: Stats, cfg: { exitStraightM: number; exitShiftM: number; edgeM: number; exitLeadM: number; exitBumps: number }, ppm: number, table?: CornerTable): { points: Point[]; offsets: Float64Array; speed: (x: ArrayLike<number>, y: ArrayLike<number>) => Float64Array; time: (x: ArrayLike<number>, y: ArrayLike<number>, v: ArrayLike<number>, from: number, to: number) => number } {
  const n = line.n, wrap = (q: number) => ((q % n) + n) % n;
  const speed = (x: ArrayLike<number>, y: ArrayLike<number>) => speedProfile(x, y, physics, stats, { cornerMargin: 1, brakeMargin: 1, fuelKg: physics.fuel.startKg / 2, table });
  const time = (x: ArrayLike<number>, y: ArrayLike<number>, v: ArrayLike<number>, from: number, to: number) => {
    let t = 0;
    for (let q = from; q < to; q++) { const i = wrap(q), j = wrap(q + 1); t += Math.hypot(x[j]! - x[i]!, y[j]! - y[i]!) / Math.max(1, (v[i]! + v[j]!) / 2); }
    return t;
  };
  const offsets = optimizeExitOffsets(line, (off, from, to) => { const p = offsetPath(line, off); return time(p.x, p.y, speed(p.x, p.y), from, to); }, cfg, physics.car.widthM / 2);
  const p = offsetPath(line, offsets);
  return { points: Array.from({ length: n }, (_, i) => ({ x: Math.round(p.x[i]! * ppm * 10) / 10, y: Math.round(p.y[i]! * ppm * 10) / 10 })), offsets, speed, time };
}

/**
 * Cornering grip left after load transfer (tyres.transferSensitivity), for the speed plans: the outside
 * tyre's extra load as a share of the pair's mean, r = cgHeight x mu_lat / trackWidth (independent of speed:
 * downforce raises both the load and the grip; half the full-limit figure, since cars corner short of the
 * limit most of the way: with the full figure the AI ran ~1 s a lap slow), at most 1; the pair then grips
 * ((1 + r)^(1-k) + (1 - r)^(1-k)) / 2 of what it would without load sensitivity. 1 when k is 0.
 */
export function transferGripFactor(muLat: number, physics: Pick<PhysicsConfig, 'tyres' | 'car'>): number {
  const k = physics.tyres.transferSensitivity ?? 0;
  if (!k) return 1;
  const r = Math.min(1, (physics.car.cgHeightM * muLat) / physics.car.trackWidthM);
  return ((1 + r) ** (1 - k) + (1 - r) ** (1 - k)) / 2;
}

// ---------------------------------------------------------------------------------------------------------------
// Hard limits (card "Racing line optimizer: hard track and turning limits"): checks any line can be put through.

/** Drivable for a line: asphalt and kerb. Grass, gravel, walls, the pit lane and out of bounds are not. */
const lineDrivable = (track: SimTrack) => { const ids = track.surfaces.map((s) => s.id); return (p: number) => ids[p] === 'asphalt' || ids[p] === 'kerb'; };

/** Per-track cache of the distance (px) from each pixel to the nearest non-drivable pixel. */
const drivableDist = new WeakMap<SimTrack, Float32Array>();
export function distanceToUndrivable(track: SimTrack): Float32Array {
  let d = drivableDist.get(track);
  if (!d) { d = distanceTo(track, lineDrivable(track)); drivableDist.set(track, d); }
  return d;
}

export interface FootprintCheck {
  /** Smallest room either side of the line, metres (distance to non-drivable surface). */
  minRoomM: number;
  /** Line point (index) where it's smallest. */
  at: number;
  /** Points whose segment to the next point comes closer than the footprint needs, with the room found. */
  bad: Array<{ i: number; roomM: number }>;
}

/**
 * RULE 1, ON TRACK: the car's footprint (half its width + `marginM` either side of the line) on drivable surface
 * all along a closed line in track pixels, sampled every ~0.25 m along each segment (a thin island tip between
 * two points counts too).
 */
export function footprintCheck(track: SimTrack, line: readonly Point[], halfWidthM: number, marginM: number): FootprintCheck {
  const ppm = track.json.pxPerMeter, d = distanceToUndrivable(track), { width: w, height: h } = track.mask;
  const room = (x: number, y: number) => { const ix = Math.floor(x), iy = Math.floor(y); return ix < 0 || iy < 0 || ix >= w || iy >= h ? 0 : d[iy * w + ix]! / ppm; };
  const need = halfWidthM + marginM, n = line.length;
  let minRoom = Infinity, at = 0;
  const bad: FootprintCheck['bad'] = [];
  for (let i = 0; i < n; i++) {
    const a = line[i]!, b = line[(i + 1) % n]!, steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (0.25 * ppm)));
    let segMin = Infinity;
    for (let s = 0; s < steps; s++) segMin = Math.min(segMin, room(a.x + ((b.x - a.x) * s) / steps, a.y + ((b.y - a.y) * s) / steps));
    if (segMin < minRoom) { minRoom = segMin; at = i; }
    if (segMin < need) bad.push({ i, roomM: segMin });
  }
  return { minRoomM: minRoom, at, bad };
}

/**
 * The tightest steady radius the car can turn at speed v (m/s), metres, from the car model: the steering lock
 * available at that speed (mechLockRad, plus the half peak-slip allowance the speed profile gives) and the
 * cornering grip (with downforce). The larger of the two limits it.
 */
export function carTurnRadiusM(v: number, physics: PhysicsConfig, stats: Stats, fuelKg = physics.fuel.startKg / 2): { radiusM: number; lockM: number; gripM: number } {
  const t = physics.tyres, c = physics.car, wf = c.weightFront, mass = c.dryMassKg + fuelKg;
  const mu = t.baseGrip * stats.grip * (t.frontGrip * wf + t.rearGrip * (1 - wf)) * (t.loadSensitivity ? (c.dryMassKg / mass) ** t.loadSensitivity : 1);
  const muLat = mu * t.lateralGrip * transferGripFactor(mu * t.lateralGrip, physics);
  const lat = muLat * G * (1 + physics.aero.downforceCoef * stats.downforce * v * v);
  const lockM = c.wheelbaseM / Math.tan(mechLockRad(v, physics.steering) + ((t.peakSlipDeg * Math.PI) / 180) * 0.5);
  const gripM = (v * v) / lat;
  return { radiusM: Math.max(lockM, gripM), lockM, gripM };
}

export interface TurnCheck {
  /** Worst ratio of the line's radius to the car's tightest radius at the planned speed (< 1 = can't turn). */
  minRatio: number;
  at: number;
  pathRadiusM: number;
  carRadiusM: number;
  /** Planned speed there, kph. */
  kph: number;
  /** Line points under ratioMin (the car is at its limit at exactly 1). */
  bad: number[];
}

/**
 * RULE 2, TURNABLE: the line's radius (pathCurvature, as the AI and the speed profile see it) against the car's
 * tightest radius at the speed the reference profile plans there. Line in metres.
 */
export function turnCheck(x: ArrayLike<number>, y: ArrayLike<number>, physics: PhysicsConfig, stats: Stats, ratioMin = 0.99, table?: CornerTable): TurnCheck {
  const k = pathCurvature(x, y, true);
  const v = speedProfile(x, y, physics, stats, { cornerMargin: 1, brakeMargin: 1, fuelKg: physics.fuel.startKg / 2, table });
  let minRatio = Infinity, at = 0;
  const bad: number[] = [];
  for (let i = 0; i < k.length; i++) {
    const pathR = Math.abs(k[i]!) > 1e-9 ? 1 / Math.abs(k[i]!) : Infinity;
    const car = plannedRadius(table, v[i]!, physics, stats);
    const ratio = pathR / car;
    if (ratio < minRatio) { minRatio = ratio; at = i; }
    if (ratio < ratioMin) bad.push(i);
  }
  const pathR = 1 / Math.max(1e-9, Math.abs(k[at]!));
  return { minRatio, at, pathRadiusM: pathR, carRadiusM: plannedRadius(table, v[at]!, physics, stats), kph: v[at]! * 3.6, bad };
}

// ---------------------------------------------------------------------------------------------------------------
// The car's measured cornering limits (car-limits.ts measures the table; these read it).

export interface CornerTable {
  /** Speeds measured, m/s, ascending. */
  v: number[];
  /** Tightest steady radius held at each speed, m (non-decreasing after a monotone clean-up). */
  r: number[];
  /** Measured radius / the analytic model's radius (carTurnRadiusM) for the same car at each speed: how much wider
   *  the real car turns than the both-axles-at-the-limit model says. Other team stats scale through the model. */
  ratio: number[];
}

/** The measured / model ratio at speed v (interpolated; the end values beyond the measured range). */
export function ratioAt(t: CornerTable, v: number): number {
  const n = t.v.length;
  if (!n) return 1;
  if (v <= t.v[0]!) return t.ratio[0]!;
  for (let i = 1; i < n; i++) if (v <= t.v[i]!) { const f = (v - t.v[i - 1]!) / (t.v[i]! - t.v[i - 1]!); return t.ratio[i - 1]! + f * (t.ratio[i]! - t.ratio[i - 1]!); }
  return t.ratio[n - 1]!;
}

/** This car's tightest steady radius at speed v, m: the model's for its own stats x the measured ratio. */
export function plannedRadius(t: CornerTable | undefined, v: number, physics: PhysicsConfig, stats: Stats, fuelKg?: number): number {
  const m = carTurnRadiusM(v, physics, stats, fuelKg).radiusM;
  return t ? m * ratioAt(t, v) : m;
}

/** The fastest speed (m/s, up to vMax) whose planned radius still fits radius R (bisection; radius grows with speed). */
export function plannedSpeed(t: CornerTable | undefined, R: number, physics: PhysicsConfig, stats: Stats, vMax: number, fuelKg?: number): number {
  if (plannedRadius(t, vMax, physics, stats, fuelKg) <= R) return vMax;
  let lo = 0.5, hi = vMax;
  // Tighter than the car turns even at walking pace: it can still crawl round on slip and rotation (the analytic plan's
  // 6 m/s floor; at 0.5 m/s cars stopped dead at the pit-box entry kinks).
  if (plannedRadius(t, lo, physics, stats, fuelKg) > R) return Math.min(vMax, 6);
  for (let k = 0; k < 32; k++) { const mid = (lo + hi) / 2; if (plannedRadius(t, mid, physics, stats, fuelKg) <= R) lo = mid; else hi = mid; }
  return Math.max(lo, Math.min(vMax, 6));
}

