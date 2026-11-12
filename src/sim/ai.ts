// AI drivers (card 05). An AI is just an InputSource: it reads the world and outputs { throttle, brake,
// steer } exactly like the keyboard, then drives the same physics. No speed, grip or teleport cheats;
// its estimates of corner speed and braking come from the car's own config and stats.
// Pure: aiDrive(state in) -> (input, state out). State is plain data, randomness is a seeded PRNG kept
// in that state, so the server (card 07) runs it unchanged and replays stay exact.
import { buildStats } from './car-config';
import { speedProfile } from './line-optimizer';
import type { SimTrack } from './track';
import { surfaceAt } from './track';
import type { CarInput, CarState, InputSource, WorldState } from './types';
import { steerLimit, TICK_DT, wearGrip, type SimContext } from './world';

export interface AiPreset {
  cornerMargin: number;
  brakeMargin: number;
  lookaheadBaseM: number;
  lookaheadPerMps: number;
  steerKp: number;
  steerKd: number;
  noise: number;
  mistakesPerMin: number;
  trafficConeM: number;
  overtakeOffsetM: number;
  throttleCap: number;
}

export interface AiConfig {
  defaultPreset: string;
  presets: Record<string, AiPreset>;
  recovery: { stuckSec: number; reverseSec: number; backwardsDeg: number };
  pits?: { fuelLaps: number; minWear: number; pitSpeedMarginKph: number };
  /** Traction control: from tcSlip (rear longitudinal slip as a fraction of peak), fully off tcRange later. */
  aids?: { tcSlip: number; tcRange: number };
  /** Race starts: reaction to lights out, a random delay in this range per driver. */
  start?: { reactionMinSec: number; reactionMaxSec: number };
}

const G = 9.81;
const SPACING_M = 2;

/** A path the AI follows (the racing line, or a pit path), resampled every 2 m, in metres. */
export interface AiPath {
  x: Float64Array;
  y: Float64Array;
  /** Signed curvature 1/m (+ = turning right / clockwise). */
  k: Float64Array;
  /** Room to the edge of drivable surface on each side, metres. */
  left: Float64Array;
  right: Float64Array;
  n: number;
  length: number;
  closed: boolean;
}

export interface PitPath extends AiPath {
  /** Path index of the pit box stop (box 0). */
  box: number;
  /** Per pit box (SimTrack.boxes order): path index to stop at, and the box centre, metres. */
  boxStops: Array<{ q: number; x: number; y: number }>;
  /** Racing-line index where the pit path leaves the line, and where it rejoins. */
  entry: number;
  exit: number;
  /** Path index range that is pit lane (limiter applies). */
  laneFrom: number;
  laneTo: number;
}

export interface RacingLine extends AiPath {
  pit: PitPath | undefined;
}

/** Resample a polyline every 2 m and add curvature + free width either side. */
function makePath(src: Array<{ x: number; y: number }>, closed: boolean, track: SimTrack, freeOk: (id: string) => boolean): AiPath {
  const ppm = track.json.pxPerMeter;
  const segs = closed ? src.length : src.length - 1;
  const cum = [0];
  for (let i = 1; i <= segs; i++) {
    const a = src[i - 1]!, b = src[i % src.length]!;
    cum.push(cum[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const length = cum[segs]!;
  const n = Math.max(closed ? 8 : 2, Math.round(length / SPACING_M) + (closed ? 0 : 1));
  const x = new Float64Array(n), y = new Float64Array(n), k = new Float64Array(n), left = new Float64Array(n), right = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = closed ? (length * i) / n : (length * i) / Math.max(1, n - 1);
    while (j < segs - 1 && cum[j + 1]! < s) j++;
    const a = src[j]!, b = src[(j + 1) % src.length]!, f = (s - cum[j]!) / (cum[j + 1]! - cum[j]! || 1);
    x[i] = a.x + (b.x - a.x) * f;
    y[i] = a.y + (b.y - a.y) * f;
  }
  const at = (i: number) => (closed ? ((i % n) + n) % n : Math.min(n - 1, Math.max(0, i)));
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = at(i - 3), b = at(i + 3);
    const ax = x[i]! - x[a]!, ay = y[i]! - y[a]!, bx = x[b]! - x[i]!, by = y[b]! - y[i]!;
    const cross = ax * by - ay * bx;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by), lc = Math.hypot(x[b]! - x[a]!, y[b]! - y[a]!);
    raw[i] = la && lb && lc ? (2 * cross) / (la * lb * lc) : 0;
  }
  for (let i = 0; i < n; i++) k[i] = (raw[at(i - 1)]! + 2 * raw[i]! + raw[at(i + 1)]!) / 4;
  const ok = (px: number, py: number) => {
    const s = track.surfaces[surfaceAt(track, px * ppm, py * ppm)];
    return !!s && freeOk(s.id);
  };
  for (let i = 0; i < n; i++) {
    const tx = x[at(i + 1)]! - x[at(i - 1)]!, ty = y[at(i + 1)]! - y[at(i - 1)]!, tl = Math.hypot(tx, ty) || 1;
    const rx = -ty / tl, ry = tx / tl; // right of the direction of travel (screen coords)
    const free = (sign: number) => {
      let d = 0;
      while (d < 15 && ok(x[i]! + rx * sign * (d + 0.25), y[i]! + ry * sign * (d + 0.25))) d += 0.25;
      return d;
    };
    right[i] = free(1);
    left[i] = free(-1);
  }
  return { x, y, k, left, right, n, length, closed };
}

/** Build the AI's view of the racing line (and the pit path, if the track has a pit lane). */
export function buildRacingLine(track: SimTrack): RacingLine | undefined {
  const ppm = track.json.pxPerMeter;
  const src = track.json.racingLine.map((p) => ({ x: p.x / ppm, y: p.y / ppm }));
  if (src.length < 3) return undefined;
  const racing = (id: string) => id === 'asphalt' || id === 'kerb';
  const line = makePath(src, true, track, racing);
  return { ...line, pit: buildPitPath(track, line) };
}

/**
 * Pit path: racing line -> pit entry -> centre of the pit lane -> pit exit -> racing line.
 * The pit lane's two "mouths" are where it meets legal track; which one is the entry follows from the
 * driving direction (the exit is the one the racing line reaches shortly after the entry).
 * The connections to the line follow legal surface (breadth-first search), so they never cut a wall.
 */
function buildPitPath(track: SimTrack, line: AiPath): PitPath | undefined {
  const { width: w, height: h, data } = track.mask;
  const ppm = track.json.pxPerMeter;
  const { pitLane, pitBox } = track.index;
  const isPit = (i: number) => data[i] === pitLane || data[i] === pitBox;
  const isTrack = (i: number) => {
    const s = track.surfaces[data[i]!];
    return !!s && s.legal && !isPit(i);
  };
  const nb = (i: number) => {
    const x = i % w;
    return [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1].filter((j) => j >= 0);
  };
  // Mouths: pit pixels touching track, grouped into connected pieces.
  const mouthSet = new Set<number>();
  for (let i = 0; i < w * h; i++) if (isPit(i) && nb(i).some(isTrack)) mouthSet.add(i);
  const mouths: number[][] = [];
  for (const s of mouthSet) {
    if (!mouthSet.has(s)) continue;
    mouthSet.delete(s);
    const piece = [s], st = [s];
    while (st.length) {
      const i = st.pop()!;
      for (const dy of [-1, 0, 1])
        for (const dx of [-1, 0, 1]) {
          const j = i + dy * w + dx;
          if (mouthSet.has(j)) { mouthSet.delete(j); piece.push(j); st.push(j); }
        }
    }
    mouths.push(piece);
  }
  mouths.sort((a, b) => b.length - a.length);
  if (mouths.length < 2) return undefined;
  const [mA, mB] = mouths as [number[], number[]];

  // Which mouth is the entry: the racing line reaches the exit mouth shortly after the entry mouth.
  const centre = (px: number[]) => ({ x: px.reduce((a2, i) => a2 + (i % w), 0) / px.length / ppm, y: px.reduce((a2, i) => a2 + Math.floor(i / w), 0) / px.length / ppm });
  const nearestOnLine = (p: { x: number; y: number }) => {
    let best = 0, bd = Infinity;
    for (let q = 0; q < line.n; q++) { const d = (line.x[q]! - p.x) ** 2 + (line.y[q]! - p.y) ** 2; if (d < bd) { bd = d; best = q; } }
    return best;
  };
  const a = nearestOnLine(centre(mA)), b = nearestOnLine(centre(mB));
  const forward = (from: number, to: number) => (to - from + line.n) % line.n;
  const [entryIdx, exitIdx, entryMouth, exitMouth] = forward(a, b) < line.n / 2 ? [a, b, mA, mB] : [b, a, mB, mA];

  // Through the lane: distance from the entry mouth over pit pixels, centroids of 2 m bands.
  const dist = new Int32Array(w * h).fill(-1);
  const q2 = [...entryMouth];
  for (const m of entryMouth) dist[m] = 0;
  for (let qi = 0; qi < q2.length; qi++) {
    const i = q2[qi]!;
    for (const j of nb(i)) if (dist[j] === -1 && isPit(j)) { dist[j] = dist[i]! + 1; q2.push(j); }
  }
  const exitD = Math.max(...exitMouth.map((m) => dist[m]!));
  if (exitD <= 0) return undefined;
  const band = SPACING_M * ppm, bins = Math.ceil(exitD / band) + 1;
  const sx = new Float64Array(bins), sy = new Float64Array(bins), cnt = new Float64Array(bins);
  for (let i = 0; i < w * h; i++) {
    if (dist[i]! < 0 || dist[i]! > exitD) continue;
    const bi = Math.floor(dist[i]! / band);
    sx[bi] = sx[bi]! + (i % w); sy[bi] = sy[bi]! + Math.floor(i / w); cnt[bi] = cnt[bi]! + 1;
  }
  const lane: Array<{ x: number; y: number }> = [];
  for (let bi = 0; bi < bins; bi++) if (cnt[bi]) lane.push({ x: sx[bi]! / cnt[bi]! / ppm, y: sy[bi]! / cnt[bi]! / ppm });
  // Joining the line: a straight run between the lane end and a racing-line point, with a car's width
  // of legal surface either side all the way (so it never cuts a wall or the grass). The join is the
  // furthest such point from the lane, so the turn off the line (and back on) is as gentle as it gets.
  const legalAt = (x: number, y: number) => {
    const s2 = track.surfaces[surfaceAt(track, x * ppm, y * ppm)];
    return !!s2 && s2.legal;
  };
  const clear = (p: { x: number; y: number }, q: { x: number; y: number }) => {
    const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
    for (let d = 0; d <= len; d += 0.5)
      for (const o of [-1.6, 0, 1.6]) if (!legalAt(p.x + (dx * d) / len + nx * o, p.y + (dy * d) / len + ny * o)) return false;
    return true;
  };
  const lp = (q: number) => { const r = ((q % line.n) + line.n) % line.n; return { x: line.x[r]!, y: line.y[r]! }; };
  const laneIn = lane[0]!, laneOut = lane[lane.length - 1]!;
  let join = entryIdx;
  for (let d = 80; d >= -5; d--) if (clear(lp(entryIdx - d), laneIn)) { join = entryIdx - d; break; }
  let rejoin = exitIdx;
  for (let d = 80; d >= -5; d--) if (clear(laneOut, lp(exitIdx + d))) { rejoin = exitIdx + d; break; }
  // Lead-in and lead-out along the racing line, so the AI sees (and brakes for) the pit entry well
  // before it reaches it, and is back on the line at speed before it hands over.
  const LEAD = 50, TAIL = 15;
  const linePts = (from: number, count: number) => Array.from({ length: count }, (_, k2) => lp(from + k2));
  const all = [...linePts(join - LEAD, LEAD + 1), ...lane, ...linePts(rejoin, TAIL)];
  const path = makePath(all, false, track, (id) => id === 'asphalt' || id === 'kerb' || id === 'pitLane' || id === 'pitBox');
  // Lane range and box stop, by nearest path point.
  const nearestOnPath = (p: { x: number; y: number }) => {
    let best = 0, bd = Infinity;
    for (let q = 0; q < path.n; q++) { const d = (path.x[q]! - p.x) ** 2 + (path.y[q]! - p.y) ** 2; if (d < bd) { bd = d; best = q; } }
    return best;
  };
  const boxStops = track.boxes.map((b) => { const p = { x: b.x / ppm, y: b.y / ppm }; return { q: nearestOnPath(p), ...p }; });
  const box = boxStops[0]?.q ?? nearestOnPath(lane[Math.floor(lane.length / 2)]!);
  return { ...path, box, boxStops, entry: (((join - LEAD) % line.n) + line.n) % line.n, exit: (rejoin + TAIL - 1) % line.n, laneFrom: nearestOnPath(lane[0]!), laneTo: nearestOnPath(lane[lane.length - 1]!) };
}

export interface AiState {
  /** 'race' follows the racing line; 'pit' follows the pit path. */
  mode: 'race' | 'pit';
  /** Index of the nearest point on the current path (-1 = not found yet). */
  near: number;
  lastErr: number;
  /** Ticks spent stuck / facing backwards. */
  stuckTicks: number;
  /** Ticks left of a reverse-out manoeuvre. */
  recoverTicks: number;
  /** Current sideways offset from the line, metres (+ = right). */
  offset: number;
  /** A mistake in progress: kind and ticks left. */
  mistake: { kind: 'lateBrake' | 'wide'; ticks: number } | undefined;
  /** Seeded PRNG state (mulberry32). */
  rng: number;
  /** Pits: wants to stop next time round; has been serviced this stop; fuel use per lap (measured). */
  pitWanted: boolean;
  serviced: boolean;
  fuelAtLap: number;
  fuelPerLap: number;
  /** Counters for reports (ai-run). */
  stuckEvents: number;
  mistakes: number;
  pitStops: number;
  /** Race start: the tick it goes after lights out (-1 = not drawn yet). */
  launchTick: number;
  /** How much of its computed corner speed it trusts (learned: drops when it runs wide), 0.85..1. */
  trust: number;
  /** Debug: the speed it planned for last tick, m/s. */
  lastAllowed: number;
}

export function newAiState(seed: number): AiState {
  return {
    mode: 'race', near: -1, lastErr: 0, stuckTicks: 0, recoverTicks: 0, offset: 0, mistake: undefined, rng: seed >>> 0 || 1,
    pitWanted: false, serviced: false, fuelAtLap: -1, fuelPerLap: 0, stuckEvents: 0, mistakes: 0, pitStops: 0, launchTick: -1, trust: 1, lastAllowed: 0,
  };
}

/** mulberry32: returns [0,1) and the next state. */
function rand(s: number): [number, number] {
  const n = (s + 0x6d2b79f5) >>> 0;
  let t = n;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, n];
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Nearest point on a path, tracked continuously (window around last time); global search only if lost. */
function locate(path: AiPath, car: CarState, prev: number, speed: number, ahead = 60): number {
  const { n } = path;
  const d2 = (q: number) => (path.x[q]! - car.x) ** 2 + (path.y[q]! - car.y) ** 2;
  const idx = (q: number) => (path.closed ? ((q % n) + n) % n : Math.min(n - 1, Math.max(0, q)));
  let best = -1, bd = Infinity;
  if (prev >= 0)
    for (let d = -15; d <= ahead; d++) {
      const q = idx(prev + d);
      const v = d2(q);
      if (v < bd) { bd = v; best = q; }
    }
  if (best < 0 || Math.sqrt(bd) > 30) {
    // Lost: anywhere, but only points heading roughly the way the car moves (sections run side by side
    // in opposite directions on Oxford; the wrong one would make the AI "turn back").
    best = -1; bd = Infinity;
    for (let q = 0; q < n; q++) {
      const tx = path.x[idx(q + 1)]! - path.x[q]!, ty = path.y[idx(q + 1)]! - path.y[q]!;
      if (speed >= 2 && tx * car.vx + ty * car.vy <= 0) continue;
      const v = d2(q);
      if (v < bd) { bd = v; best = q; }
    }
    if (best < 0) best = Math.max(0, prev);
  }
  return best;
}

// Speed profiles per line x car build x preset x the physics numbers that matter: static data computed
// once (not state), so a memo is fine; physics tuned live gives a new key and a fresh profile.
const profiles = new WeakMap<AiPath, Map<string, Float64Array>>();
function carProfile(line: AiPath, car: CarState, ctx: SimContext, preset: AiPreset): Float64Array {
  const p = ctx.physics;
  const key = JSON.stringify([car.build, preset.cornerMargin, preset.brakeMargin, p.tyres, p.car, p.engine, p.brakes, p.aero]);
  let m = profiles.get(line);
  if (!m) profiles.set(line, (m = new Map()));
  let prof = m.get(key);
  if (!prof) {
    if (m.size > 64) m.clear();
    prof = speedProfile(line.x, line.y, p, buildStats(car.build, ctx.catalog), { cornerMargin: preset.cornerMargin, brakeMargin: preset.brakeMargin, fuelKg: p.fuel.startKg / 2 });
    m.set(key, prof);
  }
  return prof;
}

/** One tick of an AI driver for car `i`. */
export function aiDrive(world: WorldState, i: number, prevState: AiState, line: RacingLine, ctx: SimContext, preset: AiPreset, cfg: AiConfig): { input: CarInput; state: AiState } {
  const car = world.cars[i]!;
  const st: AiState = { ...prevState };
  // Race start: sit still under the lights (throttle now = a jump start), then react to lights out.
  const race = world.race;
  if (race && (race.phase === 'grid' || race.phase === 'lights')) return { input: { throttle: 0, brake: 0, steer: 0 }, state: st };
  if (race && race.phase === 'racing' && race.phaseTick > 0 && world.tick - race.phaseTick < 120) {
    if (st.launchTick < 0) {
      const [r0, next] = rand(st.rng);
      st.rng = next;
      const s0 = cfg.start ?? { reactionMinSec: 0.2, reactionMaxSec: 0.2 };
      st.launchTick = race.phaseTick + Math.round((s0.reactionMinSec + r0 * (s0.reactionMaxSec - s0.reactionMinSec)) / TICK_DT);
    }
    if (world.tick < st.launchTick) return { input: { throttle: 0, brake: 0, steer: 0 }, state: st };
  }
  const speed = Math.hypot(car.vx, car.vy);
  const phys = ctx.physics;
  const pits = cfg.pits ?? { fuelLaps: 2.2, minWear: 0.45, pitSpeedMarginKph: 4 };
  let r: number;

  // Which path: racing line, or the pit path once a stop is wanted and the car reaches the entry.
  if (st.mode === 'race') {
    const was = st.near;
    st.near = locate(line, car, st.near, speed);
    // Lap boundary on the line: measure fuel used per lap (for when to pit).
    if (was >= 0 && st.near < was - line.n / 2) {
      if (st.fuelAtLap >= 0) st.fuelPerLap = Math.max(0, st.fuelAtLap - car.fuelKg);
      st.fuelAtLap = car.fuelKg;
    }
    if (st.fuelAtLap < 0) st.fuelAtLap = car.fuelKg;
    const need = st.fuelPerLap > 0 ? st.fuelPerLap * pits.fuelLaps : phys.fuel.burnKgPerSec * 40;
    let want = car.fuelKg < need || car.wheels.some((wh) => wh.wear < pits.minWear);
    // Racing: no stop it doesn't need to reach the flag (enough fuel, tyres not near the cliff).
    if (want && race && st.fuelPerLap > 0) {
      const lapsLeft = race.laps - car.timing.laps;
      if (car.fuelKg > st.fuelPerLap * (lapsLeft + 0.3) && car.wheels.every((wh) => wh.wear > 0.3)) want = false;
    }
    if (line.pit && want) st.pitWanted = true;
    if (line.pit && st.pitWanted) {
      const toEntry = (line.pit.entry - st.near + line.n) % line.n;
      if (toEntry <= 3 || toEntry >= line.n - 2) {
        st.mode = 'pit';
        st.near = 0;
        st.serviced = false;
        st.offset = 0;
      }
    }
  }
  const pit = st.mode === 'pit' ? line.pit! : undefined;
  const path: AiPath = pit ?? line;
  if (pit) {
    st.near = locate(pit, car, st.near, speed, 8);
    if (st.near >= pit.n - 2) {
      // Back on the line.
      st.mode = 'race';
      st.pitWanted = st.pitWanted && !st.serviced;
      st.near = pit.exit;
      st.fuelAtLap = -1;
      return aiDrive(world, i, { ...st, near: pit.exit }, line, ctx, preset, cfg);
    }
  }
  const { n } = path;
  const best = st.near;
  const idx = (q: number) => (path.closed ? ((q % n) + n) % n : Math.min(n - 1, Math.max(0, q)));
  const pathHeading = Math.atan2(path.x[idx(best + 1)]! - path.x[best]!, -(path.y[idx(best + 1)]! - path.y[best]!));
  /** Signed distance of a point right of the path at index q (+ = right), and the path direction there. */
  const tangent = (q: number) => {
    const a = idx(q), b = idx(q + 1) === a ? idx(q - 1) : idx(q + 1), sg = idx(q + 1) === a ? -1 : 1;
    const tx0 = (path.x[b]! - path.x[a]!) * sg, ty0 = (path.y[b]! - path.y[a]!) * sg, l = Math.hypot(tx0, ty0) || 1;
    return { x: tx0 / l, y: ty0 / l };
  };
  const lateral = (q: number, px: number, py: number) => { const tg = tangent(q); return (px - path.x[idx(q)]!) * -tg.y + (py - path.y[idx(q)]!) * tg.x; };
  const crossErr = lateral(best, car.x, car.y);
  // A fresh driver (first tick, e.g. on the grid) starts in the lane it's in and merges, rather than
  // steering straight across to the line through whoever is next to it.
  if (prevState.near < 0 && st.mode === 'race') st.offset = crossErr;

  // 5. RECOVERY: stuck (not moving though trying) or facing backwards for too long -> reverse out.
  const backwards = Math.abs(wrap(car.heading - pathHeading)) > (cfg.recovery.backwardsDeg * Math.PI) / 180;
  if (st.recoverTicks > 0) {
    st.recoverTicks--;
    const err = wrap(pathHeading - car.heading);
    return { input: { throttle: 0, brake: 1, steer: -Math.sign(err || 1) }, state: st }; // reversing: steer the tail round
  }
  // Which box to stop in: its own in a race, otherwise the first (practice: any box services).
  const myBox = pit ? pit.boxStops[Math.max(0, world.race?.cars[i]?.box ?? 0)] : undefined;
  const stopQ = myBox?.q ?? pit?.box ?? 0;
  const waitingInBox = !!pit && !st.serviced && Math.abs(best - stopQ) <= 2;
  st.stuckTicks = !waitingInBox && ((speed < 1.5 && car.controls.throttle > 0.1) || backwards) ? st.stuckTicks + 1 : 0;
  if (st.stuckTicks > cfg.recovery.stuckSec / TICK_DT) {
    st.stuckTicks = 0;
    st.recoverTicks = Math.round(cfg.recovery.reverseSec / TICK_DT);
    st.stuckEvents++;
    return { input: { throttle: 0, brake: 1, steer: 0 }, state: st };
  }

  // Mistakes: occasionally a late brake or a wide line, for ~2 s (never in the pits).
  [r, st.rng] = rand(st.rng);
  if (!pit && !st.mistake && r < (preset.mistakesPerMin / 60) * TICK_DT) {
    [r, st.rng] = rand(st.rng);
    st.mistake = { kind: r < 0.5 ? 'lateBrake' : 'wide', ticks: Math.round(2 / TICK_DT) };
    st.mistakes++;
  }
  if (st.mistake && --st.mistake.ticks <= 0) st.mistake = undefined;

  // 3. SPEED: what this car can corner and brake at, from its own config and stats.
  const stats = buildStats(car.build, ctx.catalog);
  const mass = phys.car.dryMassKg + Math.max(0, car.fuelKg);
  const tyre = car.wheels.reduce((a, w) => a + wearGrip(w.wear), 0) / 4;
  const mu = phys.tyres.baseGrip * stats.grip * tyre;
  const kAero = phys.aero.downforceCoef * stats.downforce;
  const vTop = (phys.engine.topSpeedKph / 3.6) * stats.topSpeed;
  const latMax = (v: number) => mu * phys.tyres.lateralGrip * G * (1 + kAero * v * v);
  /** Max cornering speed at curvature k: v^2 |k| = mu_lat g (1 + kAero v^2). */
  const cornerV = (k: number) => {
    const muLat = mu * phys.tyres.lateralGrip;
    const den = Math.abs(k) - muLat * G * kAero;
    return den <= 0 ? vTop : Math.min(vTop, Math.sqrt((muLat * G) / den));
  };
  // Close behind another car (in its lane, within ~1.5 s): brake earlier, since it may brake harder
  // than we can (better brakes, lighter on fuel) and we can't see its plan.
  // Other cars in the path's frame: distance ahead ALONG the line and lateral offset from us across
  // it. (In our own heading's frame a car on the line round a bend looks off to the side.)
  const relSteps = Math.ceil(Math.max(preset.trafficConeM, (speed * speed) / 8 + 30) / SPACING_M);
  const rel = (other: CarState) => {
    let bq = -1, bd = Infinity;
    for (let d = -4; d <= relSteps; d++) {
      if (!path.closed && (best + d < 0 || best + d > n - 1)) continue;
      const q = idx(best + d), v = (path.x[q]! - other.x) ** 2 + (path.y[q]! - other.y) ** 2;
      if (v < bd) { bd = v; bq = d; }
    }
    if (bq < -3 || bd > 12 * 12) return { ahead: -Infinity, side: 0, along: 0 };
    const tg = tangent(best + bq);
    const proj = (other.x - path.x[idx(best + bq)]!) * tg.x + (other.y - path.y[idx(best + bq)]!) * tg.y;
    const ownProj = (car.x - path.x[best]!) * tangent(best).x + (car.y - path.y[best]!) * tangent(best).y;
    return { ahead: bq * SPACING_M + proj - ownProj, side: lateral(best + bq, other.x, other.y) - crossErr, along: other.vx * tg.x + other.vy * tg.y };
  };
  const others = world.cars.map((o, oi) => (oi === i ? undefined : rel(o)));
  const following = others.some((o) => !!o && o.ahead > 0 && o.ahead < 8 + speed * 1.5 && Math.abs(o.side) < 2.8);
  const late = (st.mistake?.kind === 'lateBrake' ? 1.35 : 1) * (following ? 0.8 : 1);
  /** Braking it plans with at speed v: each axle gives the lesser of its brake share and its grip. */
  const bias = phys.brakes.frontBias, wf = phys.car.weightFront, brakeF = phys.brakes.maxForceN * stats.brakes;
  const brakeA = (v: number) => {
    const grip = mu * mass * G * (1 + kAero * v * v);
    const front = Math.min(brakeF * bias, grip * wf), rear = Math.min(brakeF * (1 - bias), grip * (1 - wf));
    return ((front + rear) / mass) * preset.brakeMargin * late;
  };
  const pitV = (ctx.rules.pitSpeedLimitKph - pits.pitSpeedMarginKph) / 3.6;
  /** Speed limit at a path point: corner speed, the pit limiter in the lane, a stop at the box. */
  const pointV = (q: number) => {
    let v = cornerV(path.k[q]!) * preset.cornerMargin * st.trust;
    if (pit && q >= pit.laneFrom - 3 && q <= pit.laneTo) v = Math.min(v, pitV);
    if (pit && !st.serviced && q >= stopQ) v = 0; // stop at its box
    return v;
  };
  let allowed: number;
  if (!pit) {
    // ON THE RACING LINE: this car's own speed profile round the whole line (racing line optimizer card),
    // computed once for its build and preset, then scaled by what's changed since: tyre wear (speed goes
    // with the square root of grip) and how much of its corner speed it has learned to trust.
    const prof = carProfile(line, car, ctx, preset);
    const ahead = st.mistake?.kind === 'lateBrake' ? 6 : 1; // a late braker reads the target a few metres on
    allowed = prof[idx(best + ahead)]! * Math.sqrt(Math.max(0.05, tyre)) * st.trust;
  } else {
    // In the pit lane: a short backward scan, since the path is short and has the limiter and the stop.
    const scanM = (speed * speed) / (2 * Math.max(1, brakeA(speed) * 0.4)) + 40;
    const steps = Math.min(n - 1 - best, Math.ceil(scanM / SPACING_M));
    let vNext = pointV(idx(best + steps));
    for (let q = steps - 1; q >= 0; q--) {
      const j = idx(best + q);
      const latUse = Math.min(1, (vNext * vNext * Math.abs(path.k[j]!)) / latMax(vNext));
      const decel = brakeA(vNext) * Math.sqrt(Math.max(0.05, 1 - latUse * latUse));
      vNext = Math.min(pointV(j), Math.sqrt(vNext * vNext + 2 * decel * SPACING_M));
    }
    allowed = vNext;
  }

  // In the box: wait for fresh tyres + fuel (the sim services a car stopped in its pit box).
  let holdInBox = false;
  // "Stopped" = slow enough for the sim to service (fuel.pitServiceMaxKph), not some other threshold.
  if (pit && !st.serviced && best >= stopQ - 3 && speed * 3.6 < phys.fuel.pitServiceMaxKph * 0.8) {
    const full = car.fuelKg >= phys.fuel.tankKg - 0.5 && car.wheels.every((wh) => wh.wear > 0.99);
    if (!car.servicing) st.serviced = true; // stopped short of / past its box: drive on, try again next lap
    else if (full) {
      st.serviced = true;
      st.pitStops++;
    } else holdInBox = true;
  }
  st.lastAllowed = allowed;

  // 4. TRAFFIC. Only cars it will actually reach count: close behind them, or closing fast enough to
  // hit within ~2 s. Pass on the side they're not on if there's room; otherwise follow at a gap
  // (not "their speed minus a bit", which chains slowdowns around the whole field). No passing in pits.
  let wantOffset = !pit && st.mistake?.kind === 'wide' ? Math.sign(path.k[best]!) * -1.5 : 0;
  // Coming up to its box: move across so the car sits in it (boxes can be beside the lane centre).
  if (pit && myBox && !st.serviced && stopQ - best < 20 && best <= stopQ + 2) wantOffset = lateral(stopQ, myBox.x, myBox.y);
  let alongside = 0; // a car next to us: -1 left, +1 right
  const gap = 6 + phys.car.lengthM;
  // Only start (or keep) a pass where the next ~40 m is fairly straight, not side by side into a braking zone.
  let straightAhead = true;
  for (let q = 0; q < 10; q++) if (Math.abs(path.k[idx(best + q)]!) > 0.03) straightAhead = false;
  // A car next to us blocks moving over on its side.
  for (const o of others) if (o && Math.abs(o.ahead) < phys.car.lengthM && Math.abs(o.side) < 4) alongside = Math.sign(o.side) || 1;
  for (const o of others) {
    if (!o) continue;
    const { ahead, side, along: otherFwd } = o;
    const closing = speed - otherFwd;
    // Look far enough to stop for it: a stopped or slow car needs the full braking distance.
    const cone = Math.max(preset.trafficConeM, closing > 0 ? (closing * closing) / (2 * brakeA(speed) * 0.8) + gap + 10 : 0);
    if (ahead <= 0 || ahead > cone || Math.abs(side) > 2.8) continue;
    const ttc = closing > 0.3 ? (ahead - gap) / closing : Infinity;
    if (ttc > 2 && ahead > gap * 1.5 && (closing * closing) / (2 * brakeA(speed) * 0.8) < ahead - gap - 5) continue;
    const sides = side >= 0 ? [-1, 1] : [1, -1];
    const passSide = pit || !straightAhead ? undefined
      : sides.find((sd) => sd !== alongside && (sd > 0 ? path.right[best]! : path.left[best]!) > preset.overtakeOffsetM + 0.5);
    if (passSide !== undefined) wantOffset = passSide * preset.overtakeOffsetM;
    // Following: hold a gap. Passing: still never drive into it while we overlap it sideways (a car
    // is ~2 m wide); once we're out of line, the short gap stops mattering.
    const hold = passSide === undefined ? gap : Math.abs(side) < 2.2 ? phys.car.lengthM + 1.5 : -Infinity;
    // Pulling out from behind a slow or stopped car: creep (it can't steer out of line standing still).
    const creep = passSide !== undefined && ahead > phys.car.lengthM + 0.05 ? clamp(2 + (ahead - phys.car.lengthM - 0.5) * 2, 2, 4) : 0;
    allowed = Math.min(allowed, Math.max(creep, otherFwd + (ahead - hold) * 0.8));
  }
  if (alongside && Math.sign(wantOffset - st.offset) === alongside) wantOffset = st.offset;
  const maxR = Math.max(0, path.right[best]! - 1.5), maxL = Math.max(0, path.left[best]! - 1.5);
  st.offset += clamp(clamp(wantOffset, -maxL, maxR) - st.offset, -3 * TICK_DT, 3 * TICK_DT);

  // 2. STEER: pure pursuit on a target point ahead (further at speed), shifted by the offset.
  const look = preset.lookaheadBaseM + preset.lookaheadPerMps * speed;
  const t = idx(best + Math.max(1, Math.round(look / SPACING_M)));
  const t2 = idx(t + 1) === t ? idx(t - 1) : idx(t + 1);
  const sgn = idx(t + 1) === t ? -1 : 1;
  const tl = Math.hypot(path.x[t2]! - path.x[t]!, path.y[t2]! - path.y[t]!) || 1;
  const nx = (-(path.y[t2]! - path.y[t]!) / tl) * sgn, ny = ((path.x[t2]! - path.x[t]!) / tl) * sgn; // right of travel
  const tx = path.x[t]! + nx * st.offset, ty = path.y[t]! + ny * st.offset;
  const err = wrap(Math.atan2(tx - car.x, -(ty - car.y)) - car.heading);
  // The wheel angle that arcs the car onto the target, divided by the lock the car has at this speed.
  const ld = Math.max(3, Math.hypot(tx - car.x, ty - car.y));
  const wheelAngle = Math.atan((2 * phys.car.wheelbaseM * Math.sin(err)) / ld);
  // The lock available toward that side right now (the same limit the keyboard gets, assist included).
  const lockNow = steerLimit(car, wheelAngle >= 0 ? 1 : -1, phys);
  [r, st.rng] = rand(st.rng);
  let steer = (preset.steerKp * wheelAngle) / lockNow + (preset.steerKd * (err - st.lastErr)) / TICK_DT + preset.noise * (r * 2 - 1);
  st.lastErr = err;
  // Understeering wide: at full lock and drifting to the outside of the corner. Scrub speed until it
  // turns again (full lock alone is normal in a hairpin; running wide with it is not).
  const kHere = path.k[best]!;
  // Room left between the car and the edge of the track on the outside of this corner.
  const roomOut = kHere > 0 ? path.left[best]! + crossErr : path.right[best]! - crossErr;
  const runningOut = speed > 8 && Math.abs(kHere) > 0.015 ? roomOut : Infinity;
  // Learning the car: running out of road lowers how much of the computed corner speed it trusts;
  // clean driving slowly wins it back (~1%/10 s). Nearly off: lift and brake now.
  st.trust = runningOut < 1.6 ? Math.max(0.85, st.trust - 0.0008) : Math.min(1, st.trust + 0.00002);
  const saturated = runningOut < 0.9;
  steer = clamp(steer, -1, 1);

  // Throttle / brake toward the allowed speed.
  let throttle = 0, brake = 0;
  if (holdInBox) brake = speed > 0.5 ? 1 : 0; // brake held at a standstill means reverse: let go once stopped
  else if (speed > allowed + 0.3) brake = clamp((speed - allowed) / 2, 0.3, 1);
  else if (speed < allowed - 1) throttle = preset.throttleCap;
  else throttle = allowed > 0.5 ? preset.throttleCap * 0.5 : 0;
  if (saturated && !holdInBox) {
    throttle = 0;
    brake = Math.max(brake, 0.35);
  }
  // Rear stepping out (body slip: the car pointing a different way from where it's going): lift, the
  // way a driver feathers the throttle out of a slow corner. Gentle slip is fine, more cuts harder.
  const slip = speed > 5 ? Math.abs(wrap(Math.atan2(car.vx, -car.vy) - car.heading)) : 0;
  if (slip > 0.08) throttle *= clamp(1 - (slip - 0.08) / 0.12, 0, 1);
  // Traction control on the tyres (card 03b: wheel.usage = slip as a fraction of the tyre's peak):
  // rears nearing their peak -> less throttle. (An ABS the same way was tried and dropped:
  // it let cars overshoot corners into walls; the brake cap below already keeps the fronts honest.)
  const aids = cfg.aids ?? { tcSlip: 0.9, tcRange: 0.35 };
  // Combined slip (ellipse): throttle is what eats the rears' sideways grip on exit, so cut it on either.
  const rearUse = Math.max(car.wheels[2].usage, car.wheels[3].usage);
  if (rearUse > aids.tcSlip) throttle *= clamp(1 - (rearUse - aids.tcSlip) / aids.tcRange, 0, 1);
  // Facing well off the line at low speed (e.g. after a spin): don't floor it.
  if (Math.abs(err) > 1 && speed < 8) throttle = Math.min(throttle, 0.4);
  // Brake like a driver who knows the car: never press harder than the front tyres can use at this
  // speed (front grip vs the front share of brake force). Where to brake already budgets for the grip
  // cornering uses (the speed profile above), so the pedal isn't reduced again here.
  if (brake > 0 && !holdInBox) {
    const grip = mu * mass * G * (1 + kAero * speed * speed);
    brake = Math.min(brake, Math.max(0.3, Math.min(1, (grip * wf) / (brakeF * bias))));
  }
  return { input: { throttle, brake, steer }, state: st };
}

/** Wrap aiDrive as an InputSource for car `i` (keyboard-compatible). */
export function aiInputSource(
  i: number,
  get: () => { world: WorldState; ctx: SimContext; line: RacingLine | undefined },
  preset: () => AiPreset,
  cfg: () => AiConfig,
  seed: number,
): InputSource & { state: AiState } {
  const src = {
    state: newAiState(seed),
    read(): CarInput {
      const { world, ctx, line } = get();
      if (!line || !world.cars[i]) return { throttle: 0, brake: 0, steer: 0 };
      const out = aiDrive(world, i, src.state, line, ctx, preset(), cfg());
      src.state = out.state;
      return out.input;
    },
  };
  return src;
}
