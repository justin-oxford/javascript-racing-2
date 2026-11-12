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
import type { PhysicsConfig, Stats } from './car-config';
import type { Point, SimTrack } from './track';
import { surfaceAt } from './track';

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
  const mu = t.baseGrip * stats.grip * axleGrip;
  const muLat = mu * t.lateralGrip;
  const kAero = physics.aero.downforceCoef * stats.downforce;
  const vTop = (physics.engine.topSpeedKph / 3.6) * stats.topSpeed;
  const latMax = (v: number) => muLat * G * (1 + kAero * v * v);
  // Steering lock limits corner speed too: the front wheels must reach about wheelbase x curvature
  // (Ackermann) within the lock available at that speed, which shrinks with speed (lockFalloffKph).
  // A car gets round a little tighter than pure geometry (tyre slip, some rotation): half a peak slip
  // angle of allowance. Without this the AI arrives at grip speed and simply can't turn tight enough.
  // Floor of 6 m/s: tighter than the lock allows at all, it can still crawl round on slip and rotation.
  const lockRad = (physics.steering.lockDeg * Math.PI) / 180;
  const slipAllow = ((t.peakSlipDeg * Math.PI) / 180) * 0.5;
  const lockV = (kk: number) => {
    const need = c.wheelbaseM * Math.abs(kk) - slipAllow;
    if (need <= 1e-6) return vTop;
    return Math.max(6, need >= lockRad ? 0 : (physics.steering.lockFalloffKph / 3.6) * (lockRad / need - 1));
  };
  const corner = (kk: number) => {
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
