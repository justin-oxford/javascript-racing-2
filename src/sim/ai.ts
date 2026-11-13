// AI drivers (card 05). An AI is just an InputSource: it reads the world and outputs { throttle, brake,
// steer } exactly like the keyboard, then drives the same physics. No speed, grip or teleport cheats;
// its estimates of corner speed and braking come from the car's own config and stats.
// Pure: aiDrive(state in) -> (input, state out). State is plain data, randomness is a seeded PRNG kept
// in that state, so the server (card 07) runs it unchanged and replays stay exact.
import { buildStats } from './car-config';
import { damageGrip, isDamaged } from './damage';
import { blueFlag, chooseMode, concedes, keepGoodExits, lineFor, LINE_IDS, lineOffsets, offsetPath, otherHasRightOfWay, type CraftMode, type LineId, type OvertakingConfig, type RacecraftConfig } from './racecraft';
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
  /** From the driver (drivers.ts), 0..1, 0.5 = average when absent: attacking/defending eagerness, traffic judgement, tyre care. */
  aggression?: number;
  racecraft?: number;
  tyreCare?: number;
}

export interface AiConfig {
  defaultPreset: string;
  /** AI driver roster (drivers.ts): spread = how far a driver's PACE stat moves its margins (+- fraction at pace 0 / 100). */
  skill?: { spread: number };
  presets: Record<string, AiPreset>;
  /** resetAfterSec: still in trouble (crawling, reversing out, stuck) this long -> reset to track, same as a player (race.json reset). */
  recovery: { stuckSec: number; reverseSec: number; backwardsDeg: number; resetAfterSec?: number };
  /** fuelLaps: pit with this many laps of fuel left (races, practice); qualiFuelLaps: the same in qualifying (light runs). */
  pits?: { fuelLaps: number; qualiFuelLaps?: number; minWear: number; pitSpeedMarginKph: number; repairDamage?: number; entryCornerMargin?: number };
  /** Pit lane driving: fastLaneM = offset from the pit path away from the boxes when driving through; boxApproachM = distance before its box to pull across into it; laneGapM = sideways clearance (beyond a car width) under which a car ahead is "in our lane"; releaseGapM = how far back up the lane a car must be clear before pulling out of the box; latRateMps = how fast it moves across in the lane. */
  pitLane?: { fastLaneM: number; boxApproachM: number; laneGapM: number; releaseGapM: number; latRateMps: number; creepMps?: number };
  /** Lift and coast: coast (no throttle, no brake) for drops up to coastMaxDropMps; lift liftBeforeBrakeSec before braking. */
  coast?: { coastMaxDropMps: number; liftBeforeBrakeSec: number; coastMinKph?: number };
  /** Side by side: lateral gap kept to a car alongside, beyond the cars' width (3-wide allowed if it fits). */
  traffic?: { sideGapM: number; crawlMps?: number };
  /** Traction control: from tcSlip (rear longitudinal slip as a fraction of peak), fully off tcRange later. */
  aids?: { tcSlip: number; tcRange: number; trailSteer?: number; trailOverspeedMps?: number; trailMaxPedal?: number };
  /** Race starts: reaction to lights out, a random delay in this range per driver. */
  start?: { reactionMinSec: number; reactionMaxSec: number };
  /** AI racecraft card: three lines picked by race situation (racecraft.ts). */
  racecraft?: RacecraftConfig;
  /** AI overtaking card: pulling out of a tow, the overlap rule, conceding, blue flags (racecraft.ts). */
  overtaking?: OvertakingConfig;
}

const G = 9.81;
/** No "overtaking" config: the behaviour from before the AI overtaking card (pull out 3 s before braking, the car
 *  ahead always has the right of way, no closer following, no conceding, no blue flags). */
const OVERTAKING_OFF: OvertakingConfig = { overlapM: -1, pullOutSec: 3, pullOutAggrSec: 0, attackCloseSec: 0, closeUntilBrakeSec: 0, attackFollowBrake: 0.8, commitM: 0, concedeBelow: 0, blueLaps: Infinity, blueBehindM: 0, blueLift: 0 };
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

/** Pit path heading at index q (track radians, 0 = up). */
function pitHeading(pit: PitPath, q: number): number {
  const a = Math.max(0, Math.min(pit.n - 2, q));
  return Math.atan2(pit.x[a + 1]! - pit.x[a]!, -(pit.y[a + 1]! - pit.y[a]!));
}

/**
 * Where cars start qualifying (track pixels): queued nose to tail in the fast lane at the pit exit, like
 * the queue at the light when a session opens. Entry k is k-th in the queue (0 = at the front), 8 m
 * apart, 1.75 m off the pit path away from the boxes. Undefined when the track has no pit path.
 */
export function pitQueuePoses(line: RacingLine | undefined, count: number, ppm: number): Array<{ x: number; y: number; heading: number }> | undefined {
  const pit = line?.pit;
  if (!pit) return undefined;
  const b0 = pit.boxStops[0];
  // Which side the boxes are on (+ = right of the path), so the queue sits on the other side.
  const sideOf = (q: number, x: number, y: number) => {
    const h = pitHeading(pit, q);
    return Math.sign((x - pit.x[q]!) * Math.cos(h) + (y - pit.y[q]!) * Math.sin(h)) || 1;
  };
  const away = b0 ? -sideOf(b0.q, b0.x, b0.y) * 1.75 : 0;
  return Array.from({ length: count }, (_, k) => {
    const q = Math.max(pit.laneFrom, pit.laneTo - 2 - 4 * k); // path points are 2 m apart
    const h = pitHeading(pit, q);
    return { x: (pit.x[q]! + Math.cos(h) * away) * ppm, y: (pit.y[q]! + Math.sin(h) * away) * ppm, heading: h };
  });
}

/** Car parked in pit box `box`, pointing down the lane (track pixels). Undefined without boxes. */
export function pitBoxPose(line: RacingLine | undefined, box: number, ppm: number): { x: number; y: number; heading: number } | undefined {
  const pit = line?.pit, b = pit?.boxStops[box];
  if (!pit || !b) return undefined;
  return { x: b.x * ppm, y: b.y * ppm, heading: pitHeading(pit, b.q) };
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
  /** Reset fallback: ticks spent crawling or stuck (reverse-outs not working); resets it has done. */
  troubleTicks: number;
  resets: number;
  /** Engine modes + deploy (ers.ts): saving fuel to reach the flag without a stop (sticky for the race);
   *  ticks spent in each mode and deploying (ai-run reports them). */
  saving: boolean;
  modeTicks: { save: number; standard: number; push: number };
  deployTicks: number;
  /** Racecraft (racecraft.ts): the mode, ticks until it may change, ticks to the next look; the weight of
   *  each line (neutral, exit, inside) in the blend; ticks per mode and line changes (ai-run). */
  craft: CraftMode;
  craftHold: number;
  craftEval: number;
  lineW: [number, number, number];
  craftTicks: Record<CraftMode, number>;
  lineChanges: number;
  /** AI overtaking card: lifting for an overlapped car on the inside / letting a lapping car by, now and counts. */
  conceding: boolean;
  /** A committed pass: the car it's going for (-1 none) and the side (+1 right, -1 left); moves tried / completed. */
  passTarget: number;
  passSide: number;
  passTries: number;
  passesMade: number;
  concessions: number;
  blueYield: boolean;
  blueYields: number;
  lineTarget: LineId;
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
  /** Passing on the inside into a corner: brakes a little later (set by traffic, used next tick). */
  attack: boolean;
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
    troubleTicks: 0, resets: 0, saving: false, modeTicks: { save: 0, standard: 0, push: 0 }, deployTicks: 0,
    craft: 'manage', craftHold: 0, craftEval: 0, lineW: [1, 0, 0], craftTicks: { manage: 0, attack: 0, defend: 0, nurse: 0 }, lineChanges: 0, lineTarget: 'neutral', conceding: false, passTarget: -1, passSide: 0, passTries: 0, passesMade: 0, concessions: 0, blueYield: false, blueYields: 0,
    pitWanted: false, serviced: false, fuelAtLap: -1, fuelPerLap: 0, stuckEvents: 0, mistakes: 0, pitStops: 0, attack: false, launchTick: -1, trust: 1, lastAllowed: 0,
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

/** The EXIT and INSIDE lines for a racing line (offsets + their geometry as paths), per racecraft config. */
const craftLines = new WeakMap<RacingLine, { key: string; offsets: { exit: Float64Array; inside: Float64Array }; paths: [AiPath, AiPath, AiPath] }>();
function racecraftLines(line: RacingLine, cfg: RacecraftConfig, halfCarM: number, ctx?: SimContext) {
  const key = JSON.stringify([cfg.insideM, cfg.insideLeadM, cfg.exitStraightM, cfg.exitShiftM, cfg.exitWeight, cfg.exitIterations, cfg.edgeM, halfCarM]);
  let c = craftLines.get(line);
  if (!c || c.key !== key) {
    let offsets = lineOffsets(line, cfg, halfCarM);
    // Only EXIT lines that are actually faster onto their straight (with the default car's speed profile).
    if (ctx) {
      const stats = buildStats(ctx.physics.defaultCar, ctx.catalog), o = { cornerMargin: 1, brakeMargin: 1, fuelKg: ctx.physics.fuel.startKg / 2 };
      const ex = offsetPath(line, offsets.exit);
      offsets = keepGoodExits(line, offsets, speedProfile(line.x, line.y, ctx.physics, stats, o), speedProfile(ex.x, ex.y, ctx.physics, stats, o), cfg);
    }
    const ex = offsetPath(line, offsets.exit), ins = offsetPath(line, offsets.inside);
    c = { key, offsets, paths: [line, { ...line, ...ex }, { ...line, ...ins }] };
    craftLines.set(line, c);
  }
  return c;
}
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
  // Qualifying: wait in the pit lane until released (retired cars stay parked).
  const qc = world.quali?.cars[i];
  if (qc && (qc.retired || world.tick < qc.releaseTick)) return { input: { throttle: 0, brake: 0, steer: 0 }, state: st };
  // Starting in the pit lane (qualifying): drive out along the pit path, nothing to service.
  if (prevState.near < 0 && st.mode === 'race' && car.inPitLane && line.pit) {
    st.mode = 'pit';
    st.serviced = true;
    st.near = -1;
  }
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
    // Qualifying runs light: keep going until there's just enough to get back (qualiFuelLaps).
    const lapsLeftWanted = world.quali ? (pits.qualiFuelLaps ?? pits.fuelLaps) : pits.fuelLaps;
    const need = st.fuelPerLap > 0 ? st.fuelPerLap * lapsLeftWanted : (phys.fuel.burnKgPerSec * 40 * lapsLeftWanted) / pits.fuelLaps;
    // Damage (Realistic): pit for repair once any zone is past pits.repairDamage.
    const broken = world.settings?.damage === 'realistic' && Math.max(car.damage.frontWing, car.damage.rearWing, car.damage.left, car.damage.right) > (pits.repairDamage ?? 0.3);
    let want = car.fuelKg < need || car.wheels.some((wh) => wh.wear < pits.minWear) || broken;
    // Racing: no stop it doesn't need to reach the flag (enough fuel, tyres not near the cliff). Fuel per lap
    // as if in STANDARD (what it measured, undone by the mode it ran); if it's a little short, SAVE (ers.ts)
    // can make up the difference instead of a stop.
    if (race && st.fuelPerLap > 0) {
      const lapsLeft = race.laps - car.timing.laps;
      const perLapStd = st.fuelPerLap / (ctx.ers.modes[car.ers.mode]?.fuel ?? 1);
      const needStd = perLapStd * (lapsLeft + 0.3), needSave = needStd * ctx.ers.modes.save.fuel;
      if (car.fuelKg < needStd && car.fuelKg >= needSave) st.saving = true;
      const enough = car.fuelKg > (st.saving ? needSave : needStd);
      if (want && !broken && enough && car.wheels.every((wh) => wh.wear > 0.3)) want = false;
    }
    // Qualifying after the flag: no point stopping, the session is over at the line.
    if (world.quali && world.quali.phase !== 'running') want = false;
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
  // Which box to stop in: its own in a race, otherwise box i (round-robin; any box services outside a
  // race), so cars don't queue for one box.
  const myBox = pit ? pit.boxStops[Math.max(0, world.race?.cars[i]?.box ?? i % pit.boxStops.length)] : undefined;
  const stopQ = myBox?.q ?? pit?.box ?? 0;
  const waitingInBox = !!pit && !st.serviced && Math.abs(best - stopQ) <= 2;
  st.stuckTicks = !waitingInBox && ((speed < 1.5 && car.controls.throttle > 0.1) || backwards) ? st.stuckTicks + 1 : 0;
  if (st.stuckTicks > cfg.recovery.stuckSec / TICK_DT) {
    st.stuckTicks = 0;
    // Pointing well away from the line (nose in a wall): reverse longer, to have room to turn out.
    const off = Math.abs(wrap(pathHeading - car.heading));
    st.recoverTicks = Math.round((cfg.recovery.reverseSec * (1 + off / (Math.PI / 2))) / TICK_DT);
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
  // Grip it has to work with: tyre wear, and (Realistic) damage, both on its own car.
  const dmgGrip = world.settings?.damage === 'realistic' ? [0, 1, 2, 3].reduce((a, w) => a + damageGrip(car.damage, w, ctx.damage), 0) / 4 : 1;
  const tyre = (car.wheels.reduce((a, w) => a + wearGrip(w.wear), 0) / 4) * dmgGrip;
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
  // Following, it brakes earlier (followBrake, safety); attacking, less so (attackFollowBrake): braking that much
  // earlier gave away every metre it gained in the corners (AI overtaking card).
  const ovb = cfg.overtaking ?? OVERTAKING_OFF;
  const late = (st.mistake?.kind === 'lateBrake' ? 1.35 : 1) * (following ? (cfg.racecraft?.enabled && st.craft === 'attack' && !pit ? ovb.attackFollowBrake : 0.8) : 1);
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
    // The pit path's corners (the entry curve) get an extra margin: tighter than anything on the racing line,
    // and a car on full lock there can't hold a planned limit speed (it understeered into the wall).
    let v = cornerV(path.k[q]!) * preset.cornerMargin * st.trust * (pit ? pits.entryCornerMargin ?? 1 : 1);
    if (pit && q >= pit.laneFrom - 3 && q <= pit.laneTo) v = Math.min(v, pitV);
    if (pit && !st.serviced && q >= stopQ) v = 0; // stop at its box
    return v;
  };
  let allowed: number;
  /** A braking zone within ~1.5 s: the moment to pull out of a tow and go for the pass. */
  let brakingSoon = false;
  /** Seconds to the next braking point on the line (Infinity: none within ~6 s): when to pull out of a tow. */
  let brakeInSec = Infinity;
  /** LIFT AND COAST: the speed that, coasting on drag alone from here, just meets every target ahead. */
  let coastLimit = Infinity;
  if (!pit) {
    // ON THE RACING LINE: this car's own speed profile round the whole line (racing line optimizer card),
    // computed once for its build and preset, then scaled by what's changed since: tyre wear (speed goes
    // with the square root of grip) and how much of its corner speed it has learned to trust.
    // RACECRAFT: the line(s) in use, blended; each has its own speed profile and during a blend the slower counts.
    const rc = cfg.racecraft?.enabled ? racecraftLines(line, cfg.racecraft, phys.car.widthM / 2, ctx) : undefined;
    const profs = rc ? rc.paths.map((p, l) => (st.lineW[l]! > 0.01 ? carProfile(p, car, ctx, preset) : undefined)) : [carProfile(line, car, ctx, preset)];
    const prof = { at: (q: number) => { let v = Infinity; for (const p of profs) if (p) v = Math.min(v, p[q]!); return v; } };
    // A late braker (mistake) reads the target 12 m on. (Attacking alongside no longer brakes later: on
    // lap one the whole field is alongside someone, and they all went wide into turn 1 together.)
    const ahead = st.mistake?.kind === 'lateBrake' ? 6 : 1;
    allowed = prof.at(idx(best + ahead)) * Math.sqrt(Math.max(0.05, tyre)) * st.trust;
    for (let q = 1, look = Math.ceil((speed * 6) / SPACING_M); q <= look; q++) if (prof.at(idx(best + q)) < speed * 0.9) { brakeInSec = (q * SPACING_M) / Math.max(1, speed); brakingSoon = brakeInSec <= 3; break; }
    // Coasting decel ~ aero drag (+ a little rolling resistance). Two uses, both short:
    //  - a SMALL drop ahead (a fast kink, <= coastMaxDropMps): coast down to it instead of braking at all;
    //  - a real braking zone: lift liftBeforeBrakeSec before the braking point, then brake.
    const lc = { coastMaxDropMps: 6, liftBeforeBrakeSec: 0.4, coastMinKph: 100, ...cfg.coast };
    const coastA = (v: number) => (phys.aero.dragCoef * stats.drag * v * v) / mass + 0.15;
    const scale = Math.sqrt(Math.max(0.05, tyre)) * st.trust;
    const liftAhead = Math.ceil((speed * lc.liftBeforeBrakeSec) / SPACING_M);
    for (let q = 1, look = Math.ceil((speed * 4) / SPACING_M); q <= look; q++) {
      const target = prof.at(idx(best + q)) * scale;
      if (target >= speed - 0.3) continue;
      if (q <= liftAhead) { coastLimit = 0; break; } // the braking curve starts within ~0.4 s: lift now
      // Only where coasting costs almost nothing: at speed (real drag) and within ~1.5 s of the drop.
      if (speed - target <= lc.coastMaxDropMps && speed * 3.6 > lc.coastMinKph && q * SPACING_M <= speed * 1.5) coastLimit = Math.min(coastLimit, Math.sqrt(target * target + 2 * coastA(target) * q * SPACING_M));
    }
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
    // Done when filled to what the pits give: a full tank, or in qualifying the qualifying load.
    const fillTo = world.quali ? Math.min(phys.fuel.tankKg, ctx.race.qualiFuelKg ?? phys.fuel.tankKg) : phys.fuel.tankKg;
    const full = car.fuelKg >= fillTo - 0.5 && car.wheels.every((wh) => wh.wear > 0.99) && !isDamaged(car.damage);
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
  // In the pit lane, keep to the FAST LANE (away from the box side) so cars parked in their boxes aren't
  // in the way; pull across into its own box only when nearly there (pitLane.boxApproachM).
  const pl = { fastLaneM: 1.5, boxApproachM: 24, laneGapM: 0.3, releaseGapM: 20, latRateMps: 5, creepMps: 1.5, ...cfg.pitLane };
  if (pit && best >= pit.laneFrom - 3 && best <= pit.laneTo && pit.boxStops[0]) {
    const b0 = pit.boxStops[0];
    wantOffset = -Math.sign(lateral(b0.q, b0.x, b0.y) || 1) * pl.fastLaneM;
  }
  if (pit && myBox && !st.serviced && (stopQ - best) * SPACING_M < pl.boxApproachM && best <= stopQ + 2) wantOffset = lateral(stopQ, myBox.x, myBox.y);
  let alongside = 0; // a car next to us: -1 left, +1 right
  let attack = false;
  // Following gap grows with speed (a time headway), so a queue through a slow hairpin can run close
  // instead of everyone braking to a stop to keep a fixed 12 m.
  // ATTACKING (racecraft), until closeUntilBrakeSec before a braking point: follow closer through the corners (aggressive drivers
  // closer still), so it's on the car ahead's gearbox at the exit (AI overtaking card).
  const ov = cfg.overtaking ?? OVERTAKING_OFF;
  const headway = cfg.racecraft?.enabled && st.craft === 'attack' && !pit && brakeInSec > ov.closeUntilBrakeSec ? Math.max(0.1, 0.35 - (preset.aggression ?? 0.5) * ov.attackCloseSec) : 0.35;
  const gap = phys.car.lengthM + 1 + headway * speed;
  // Only start (or keep) a pass where the next ~40 m is fairly straight, not side by side into a braking zone.
  let straightAhead = true;
  for (let q = 0; q < 10; q++) if (Math.abs(path.k[idx(best + q)]!) > 0.03) straightAhead = false;
  // SLIPSTREAM: on a straight, tuck in behind a car within tow range (move toward its lane). Closing on it,
  // the passing below pulls out into the offset lane before the braking zone. Eagerness by difficulty.
  const towCfg = ctx.slipstream;
  const presetName = Object.keys(cfg.presets).find((k) => cfg.presets[k] === preset);
  const eager = towCfg.aiTowEagerness[presetName ?? ''] ?? towCfg.aiTowEagerness.default ?? 0;
  if (!pit && straightAhead && eager > 0 && !st.mistake) {
    let towBest = Infinity, towSide = 0;
    for (const o of others) if (o && o.ahead >= towCfg.tow.minRangeM && o.ahead <= towCfg.tow.maxRangeM && Math.abs(o.side) < 4 && o.ahead < towBest) { towBest = o.ahead; towSide = o.side; }
    if (towBest < Infinity) wantOffset = clamp((crossErr + towSide) * eager, -4, 4);
  }
  // Cars alongside (overlapping lengthwise), tracked on EACH side: 3-wide is fine as long as everyone
  // keeps a car width + sideGapM apart. Nearest lateral distance to a car on the left / right.
  const trafficCfg = cfg.traffic ?? { sideGapM: 0.8 };
  const aggr = preset.aggression ?? 0.5;
  /** How many laps further on in the race car oi is than us (0 outside a race). */
  const lapsAhead = (oi: number) => {
    const me = race?.phase === 'racing' ? race.cars[i] : undefined, them = race?.cars[oi];
    return me && them ? them.progress - me.progress : 0;
  };
  /** The next corner's direction within ~160 m of line point q (+1 right, -1 left, 0 none). */
  const turnFrom = (q0: number) => { for (let q = 0; q < 80; q++) { const k = path.k[idx(q0 + q)]!; if (Math.abs(k) > 0.02) return Math.sign(k); } return 0; };
  /** The next corner from here: its inside is where a pass sticks. */
  const nextTurn = turnFrom(best);
  const needSide = phys.car.widthM + trafficCfg.sideGapM;
  let nearL = Infinity, nearR = Infinity;
  /** Whether the nearest car on that side has the right of way (overlap rule, racecraft.ts otherHasRightOfWay). */
  let theirsL = false, theirsR = false;
  /** Their speed along the path (to yield to: drop just under it, so the pair actually separates). */
  let speedL = 0, speedR = 0;
  // (Not in the pit lane: that's single file, below; cars parked in their boxes beside it aren't "alongside".)
  if (!pit) others.forEach((o, oi) => {
    if (!o || Math.abs(o.ahead) >= phys.car.lengthM + 1) return;
    // A car lapping us always has it (blue flags).
    // The corner both cars judge it by: the next one from the rear car of the two (from each car's own spot,
    // near a corner exit one saw that corner and the other the next, and both gave way, AI overtaking card).
    const turn = o.ahead >= 0 ? nextTurn : turnFrom(best + Math.round(o.ahead / SPACING_M));
    const theirs = otherHasRightOfWay(o.ahead, o.side, turn, oi < i, ov.overlapM) || lapsAhead(oi) >= ov.blueLaps;
    if (o.side < 0) { if (-o.side < nearL) { nearL = -o.side; theirsL = theirs; speedL = o.along; } }
    else if (o.side < nearR) { nearR = o.side; theirsR = theirs; speedR = o.along; }
  });
  if (nearL < 4 || nearR < 4) alongside = nearR <= nearL ? 1 : -1;
  // CONCEDING: a car overlapped on our inside into a braking zone; a low-aggression driver lifts and lets it
  // go rather than turning in on it.
  const conceding = !pit && others.some((o) => !!o && concedes(aggr, brakingSoon, o.ahead, o.side, nextTurn, phys.car.widthM, ov));
  if (conceding) allowed = Math.min(allowed, Math.max(0, speed - 3));
  if (conceding && !st.conceding) st.concessions++;
  st.conceding = conceding;
  // BLUE FLAGS: a car lapping us (blueLaps or more ahead in the race), pulled out and coming alongside on a
  // straight: hold the line and lift a touch so it goes by. (Lifting with it still in line behind, or moving
  // over, got the lapped car run into: it only lifts once the other car is beside it.)
  const blue = !pit && straightAhead && others.some((o, oi) => !!o && blueFlag(lapsAhead(oi), o.ahead, o.side, phys.car.widthM, ov));
  if (blue) allowed = Math.min(allowed, speed * (1 - ov.blueLift));
  if (blue && !st.blueYield) st.blueYields++;
  st.blueYield = blue;
  if (pit) {
    // PIT LANE: single file, no passing. Follow only a car actually in our lane (overlapping sideways);
    // cars in their boxes beside the fast lane, or pulling in/out of a box clear of us, don't count.
    const inLane = phys.car.widthM + pl.laneGapM;
    // A car standing in its box isn't traffic: it'll stay put, and pit-lane cars ghost through each
    // other (contact.json pitLaneGhosting), so cutting across a neighbour's box to reach ours is fine.
    const b0 = pit.boxStops[0];
    const boxLat = b0 ? lateral(b0.q, b0.x, b0.y) : 0;
    const parked = (oi: number) => {
      const c = world.cars[oi]!;
      return !!b0 && Math.hypot(c.vx, c.vy) < 0.5 && (c.servicing || Math.abs(lateral(best, c.x, c.y) - boxLat) < 1);
    };
    for (const [oi, o] of others.entries()) {
      if (!o || o.ahead <= 0 || Math.abs(o.side) >= inLane || parked(oi)) continue;
      // A car stopped short of the lane (on the racing line at the pit entry, itself waiting for us as the car
      // ahead in its frame): creep on rather than wait, or the two wait for each other for good.
      const c = world.cars[oi]!;
      const creepPast = !c.inPitLane && Math.hypot(c.vx, c.vy) < 0.5 && speed < 0.5 ? pl.creepMps : 0;
      allowed = Math.min(allowed, Math.max(creepPast, o.along + (o.ahead - gap) * 0.8));
    }
    // Leaving its box: wait for a gap. Hold while a moving car in the lane is coming up from behind or
    // is level with us (pitLane.releaseGapM behind to a car length ahead).
    if (st.serviced && myBox && Math.abs(best - stopQ) <= 3 && speed < 3) {
      const boxSide = Math.sign(lateral(stopQ, myBox.x, myBox.y) || 1);
      const traffic = world.cars.some((c, oi) => {
        const o = others[oi];
        if (!o || !Number.isFinite(o.ahead) || o.ahead < -pl.releaseGapM || o.ahead > phys.car.lengthM + 1) return false;
        const moving = Math.hypot(c.vx, c.vy) > 2;
        return moving && (lateral(best, c.x, c.y) - lateral(stopQ, myBox.x, myBox.y)) * boxSide < -(phys.car.widthM + 0.2);
      });
      if (traffic) allowed = 0;
    }
  }
  // A COMMITTED MOVE: keep the side we pulled out to (also once we're out of its lane and it drops out of the
  // traffic look below: drifting back in there and pulling out again was why passes never completed). Done
  // once past it; aborted (tuck back in) if it gets away, or if we aren't alongside once into the corner itself
  // (through the braking zone is where a quicker car gains: it brakes later on its own line, out of the other's).
  if (st.passTarget >= 0) {
    const o = others[st.passTarget];
    const past = !!o && Number.isFinite(o.ahead) && o.ahead < -phys.car.lengthM;
    if (pit || !o || !Number.isFinite(o.ahead) || past || o.ahead > ov.commitM || (Math.abs(path.k[best]!) > 0.02 && o.ahead > phys.car.lengthM * 1.5)) {
      if (past) st.passesMade++;
      st.passTarget = -1;
    } else wantOffset = st.passSide * preset.overtakeOffsetM;
  }
  for (const [oi, o] of (pit ? [] : others).entries()) {
    if (!o) continue;
    const { ahead, side, along: otherFwd } = o;
    const committed = st.passTarget === oi;
    const closing = speed - otherFwd;
    // Look far enough to stop for it: a stopped or slow car needs the full braking distance.
    const cone = Math.max(preset.trafficConeM, closing > 0 ? (closing * closing) / (2 * brakeA(speed) * 0.8) + gap + 10 : 0);
    if (ahead <= 0 || ahead > cone || Math.abs(side) > 2.8) continue;
    const ttc = closing > 0.3 ? (ahead - gap) / closing : Infinity;
    if (ttc > 2 && ahead > gap * 1.5 && (closing * closing) / (2 * brakeA(speed) * 0.8) < ahead - gap - 5) continue;
    // Pass on the INSIDE of the next corner if there's room (that's where a pass sticks), else the free side.
    const sides = nextTurn ? [nextTurn, -nextTurn] : side >= 0 ? [-1, 1] : [1, -1];
    let passSide = committed ? st.passSide : pit || !straightAhead ? undefined
      : sides.find((sd) => sd !== alongside && (sd > 0 ? path.right[best]! : path.left[best]!) > preset.overtakeOffsetM + 0.5);
    // In a tow: stay tucked in and let it pull us up; pull out when the braking point is near (before the
    // braking zone), not the moment we're close. More aggressive drivers pull out earlier (AI overtaking card).
    const tucked = !committed && passSide !== undefined && car.tow > 0.05 && brakeInSec > ov.pullOutSec + aggr * ov.pullOutAggrSec && closing < 1.5 && ahead > phys.car.lengthM + 0.8;
    if (tucked) passSide = undefined;
    if (passSide !== undefined) wantOffset = passSide * preset.overtakeOffsetM;
    // Out of the tow and closing within commitM: the move is on.
    if (!committed && passSide !== undefined && st.passTarget < 0 && ahead < ov.commitM && closing > 0) { st.passTarget = oi; st.passSide = passSide; st.passTries++; }
    // Alongside (or nearly) on the inside of the coming corner: attack, braking a little later.
    if (passSide !== undefined && passSide === nextTurn && ahead < phys.car.lengthM * 1.5) attack = true;
    // Following: hold a gap (tucked into a tow: just a safe car length or so). Passing: still never drive
    // into it while we overlap it sideways (a car is ~2 m wide); once out of line, the gap stops mattering.
    // Still in line with it as the braking zone comes: the full gap, since it brakes when we can't see it coming
    // (racing into the back of the car ahead there was most of the AI's car contact in races).
    const hold = tucked ? phys.car.lengthM + 1 : passSide === undefined ? gap : Math.abs(side) < 2.2 ? (brakingSoon ? gap : phys.car.lengthM + 1.5) : -Infinity;
    // Pulling out from behind a slow or stopped car: creep (it can't steer out of line standing still).
    // Still in line with it (not yet a car's width across): creep only as fast as the gap left allows, down to
    // nothing at a hand's width (a fixed 2 m/s creep nudged a stopped car on the grid, Bugs card).
    const inLine = Math.abs(side) < phys.car.widthM * 0.9;
    const creep = passSide === undefined || ahead <= phys.car.lengthM + 0.05 ? 0
      : inLine ? clamp((ahead - phys.car.lengthM - 0.15) * 3, 0, 4) : clamp(2 + (ahead - phys.car.lengthM - 0.5) * 2, 2, 4);
    // Too close: ease off toward the car ahead's speed, but don't stop dead just for being a bit close.
    const floor = ahead > phys.car.lengthM + 0.5 ? Math.max(0, otherFwd) * 0.7 : 0;
    allowed = Math.min(allowed, Math.max(creep, floor, otherFwd + (ahead - hold) * 0.8));
  }
  st.attack = attack;
  // Room for an offset lane over the road AHEAD (the next ~2 s, at least 40 m), not just here: a car
  // carrying a lane offset into a hairpin runs off the outside. (Half a car width + a little margin.)
  let maxR = Math.max(0, path.right[best]! - 1.5), maxL = Math.max(0, path.left[best]! - 1.5);
  for (let q = 1, look = Math.ceil(Math.max(40, speed * 2) / SPACING_M); q <= look; q++) {
    const j = idx(best + q);
    maxR = Math.min(maxR, Math.max(0, path.right[j]! - 1.5));
    maxL = Math.min(maxL, Math.max(0, path.left[j]! - 1.5));
  }
  const needIn = st.offset > maxR + 0.3 ? -1 : st.offset < -maxL - 0.3 ? 1 : 0; // must move back toward the line
  // Never move toward a car that's alongside on that side.
  if (wantOffset > st.offset && nearR < 4) wantOffset = st.offset;
  if (wantOffset < st.offset && nearL < 4) wantOffset = st.offset;
  // Keep the side-by-side gap: ease away from a car that's too close on one side; in the middle of three,
  // centre between them. Lateral room here is relative to our current lane (offset).
  const pushL = Math.max(0, needSide - nearL), pushR = Math.max(0, needSide - nearR);
  if (pushL > 0 || pushR > 0) wantOffset = st.offset + (pushL - pushR) * 0.5 + (pushL > 0 && pushR > 0 ? 0 : (pushL - pushR) * 0.5);
  // No room to keep the gap (the road ahead runs out on the side we must go, or squeezed both sides):
  // yield, drop back and tuck in behind instead of leaning on the other car.
  // Only the car without the right of way yields (both yielding = both stop).
  const squeezed = (pushL > 0 && pushR > 0 && nearL + nearR < 2 * needSide && (theirsL || theirsR))
    || (pushL > 0 && theirsL && st.offset >= maxR - 0.1) || (pushR > 0 && theirsR && st.offset <= -maxL + 0.1)
    || (needIn > 0 && nearR < 4 && theirsR) || (needIn < 0 && nearL < 4 && theirsL);
  // Drop to just under the speed of the car that has the right of way (not just under our own: two cars side
  // by side both doing that slowed together to a stop on lap one, AI overtaking card).
  const rowSpeed = Math.min(theirsL && nearL < 4 ? speedL : Infinity, theirsR && nearR < 4 ? speedR : Infinity);
  // If the car with the right of way has itself (nearly) stopped, crawl on rather than wait: cars giving way
  // round in a ring on lap one otherwise all stopped for good. (Not when it's moving: crawling into a car
  // that's going somewhere caused trouble at the pit entry.)
  const crawl = rowSpeed < 3 ? Math.min(allowed, trafficCfg.crawlMps ?? 0) : 0;
  if (squeezed) allowed = Math.min(allowed, Math.max(crawl, Math.min(speed, Number.isFinite(rowSpeed) ? rowSpeed : speed) - 2));
  // Moving over to pass is quicker than drifting back to the line.
  // (Into / out of a pit box: the quick one too, so the move across happens late, past the boxes before.)
  const latRate = st.attack || Math.abs(wantOffset) >= preset.overtakeOffsetM - 0.01 || pit ? pl.latRateMps : 3;
  st.offset += clamp(clamp(wantOffset, -maxL, maxR) - st.offset, -latRate * TICK_DT, latRate * TICK_DT);

  // 2. STEER: pure pursuit on a target point ahead (further at speed), shifted by the offset.
  const look = preset.lookaheadBaseM + preset.lookaheadPerMps * speed;
  const t = idx(best + Math.max(1, Math.round(look / SPACING_M)));
  const t2 = idx(t + 1) === t ? idx(t - 1) : idx(t + 1);
  const sgn = idx(t + 1) === t ? -1 : 1;
  const tl = Math.hypot(path.x[t2]! - path.x[t]!, path.y[t2]! - path.y[t]!) || 1;
  const nx = (-(path.y[t2]! - path.y[t]!) / tl) * sgn, ny = ((path.x[t2]! - path.x[t]!) / tl) * sgn; // right of travel
  // The racecraft line's offset at the target point stacks under the traffic offset.
  const lineOff = !pit ? craftOffset(st, line, cfg, phys.car.widthM / 2, t) : 0;
  // The two together stay on the road (half a car + margin from the edge at the target point): a passing
  // offset on top of the EXIT line's put attackers on the grass beside the car they were passing.
  const totalOff = pit ? st.offset : clamp(st.offset + lineOff, -Math.max(0, path.left[t]! - 1.5), Math.max(0, path.right[t]! - 1.5));
  const tx = path.x[t]! + nx * totalOff, ty = path.y[t]! + ny * totalOff;
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
  // Slow and pointing well off the line (after a spin or reversing out): full lock toward it.
  if (speed < 8 && Math.abs(err) > 0.8) steer = Math.sign(err);

  // Throttle / brake toward the allowed speed.
  const aids = { tcSlip: 0.9, tcRange: 0.35, trailSteer: 0.25, trailOverspeedMps: 4, trailMaxPedal: 0.6, ...cfg.aids };
  let throttle = 0, brake = 0;
  if (holdInBox) brake = speed > 0.5 ? 1 : 0; // brake held at a standstill means reverse: let go once stopped
  else if (speed > allowed + 0.3) {
    // Firm braking in a straight line; turning in and only a little too fast, a light touch that grows
    // with the overspeed (a fixed 30% minimum locked the unloaded inside front at every turn-in).
    const turning = Math.abs(car.controls.steer) > aids.trailSteer;
    brake = turning ? clamp((speed - allowed) / aids.trailOverspeedMps, 0, 1) * aids.trailMaxPedal : clamp((speed - allowed) / 2, 0.3, 1);
  }
  else if (speed >= coastLimit) throttle = 0; // lift and coast: drag alone will bring it down to what's coming
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
  // Combined slip (ellipse): throttle is what eats the rears' sideways grip on exit, so cut it on either.
  const rearUse = Math.max(car.wheels[2].usage, car.wheels[3].usage);
  // Tyre care (driver stat): a careful driver lets the rears slip less (less wear, a touch slower out).
  const tcSlip = aids.tcSlip * (1 - 0.06 * ((preset.tyreCare ?? 0.5) - 0.5) * 2);
  if (rearUse > tcSlip) throttle *= clamp(1 - (rearUse - tcSlip) / aids.tcRange, 0, 1);
  // Facing well off the line at low speed (e.g. after a spin): don't floor it.
  if (Math.abs(err) > 1 && speed < 8) throttle = Math.min(throttle, 0.4);
  // Brake like a driver who knows the car: never press harder than the front tyres can use at this
  // speed (front grip vs the front share of brake force). Where to brake already budgets for the grip
  // cornering uses (the speed profile above), so the pedal isn't reduced again here.
  if (brake > 0 && !holdInBox) {
    const grip = mu * mass * G * (1 + kAero * speed * speed);
    brake = Math.min(brake, Math.min(1, (grip * wf) / (brakeF * bias)));
    // Turning in: never press past what the lighter (inside) front can take on top of its cornering,
    // from last tick's telemetry (its grip, the slip angle it's using). Both fronts get the same force.
    if (Math.abs(car.controls.steer) > aids.trailSteer) {
      const perWheel = (brakeF * bias) / 2;
      for (const w of [car.wheels[0], car.wheels[1]]) {
        const lat = Math.min(1, Math.abs(w.slipDeg) / phys.tyres.peakSlipDeg);
        if (w.gripN > 0) brake = Math.min(brake, (w.gripN * Math.sqrt(Math.max(0, 1 - lat * lat))) / perWheel);
      }
    }

  }
  // RACECRAFT (racecraft.ts): every evalSec, the mode from the race situation (held at least holdSec), the
  // line it wants just ahead, and the blend moving toward it with distance travelled.
  if (cfg.racecraft?.enabled && !pit) updateCraft(st, world, i, line, cfg.racecraft, others, speed, phys.car.widthM / 2, best);
  // ENGINE MODE + DEPLOY (ers.ts): SAVE when it's saving fuel to reach the flag; PUSH and deploy down a
  // straight while ATTACKING (racecraft) and closing on the car ahead, or DEFENDING with one close behind.
  const racing = !race || race.phase === 'racing';
  // Deploy only where it helps a pass and doesn't just run it into the gearbox: closing from 12 m up to the
  // tow range. (Deploying once alongside too raised ai-run contacts ~20% over 4 seeds; closing-only ~5%.)
  const deployTarget = others.some((o) => !!o && ((o.ahead >= 12 && o.ahead <= towCfg.tow.maxRangeM && Math.abs(o.side) < 3.5)));
  const craftOk = !cfg.racecraft?.enabled || st.craft === 'attack' || st.craft === 'defend';
  const deploy = racing && !pit && craftOk && (deployTarget || st.craft === 'defend') && straightAhead && !brakingSoon && throttle > 0.9; // not into a braking zone
  // PUSH only while going for it (deploying): pushing all the time it's close behind just runs it into
  // the car ahead (ai-run: contacts 42 -> 57).
  const engineMode = st.saving ? 'save' : deploy ? 'push' : 'standard';
  st.modeTicks = { ...st.modeTicks, [engineMode]: st.modeTicks[engineMode] + 1 };
  if (deploy && car.ers.deploying) st.deployTicks++;
  return { input: { throttle, brake, steer, engineMode, deploy }, state: st };
}

/** Wrap aiDrive as an InputSource for car `i` (keyboard-compatible). */
/** The racecraft lines the AI uses on this racing line (EXIT only where it's faster), as offsets per point. */
export function racecraftOffsets(line: RacingLine, cfg: RacecraftConfig, ctx: SimContext): { exit: Float64Array; inside: Float64Array } {
  return racecraftLines(line, cfg, ctx.physics.car.widthM / 2, ctx).offsets;
}

/** This AI's racecraft line offset at line point q: the blend of the three lines' offsets there. */
function craftOffset(st: AiState, line: RacingLine, cfg: AiConfig, halfCarM: number, q: number): number {
  if (!cfg.racecraft?.enabled) return 0;
  const o = craftLines.get(line)?.offsets; // built (and EXITs judged) by the speed plan earlier this tick
  return o ? st.lineW[1] * o.exit[q]! + st.lineW[2] * o.inside[q]! : 0;
}

/** Racecraft for one tick: re-evaluate the mode now and then, pick the line ahead, move the blend. */
function updateCraft(st: AiState, world: WorldState, i: number, line: RacingLine, cfg: RacecraftConfig, others: ReadonlyArray<{ ahead: number; side: number; along: number } | undefined>, speed: number, halfCarM: number, best: number): void {
  const car = world.cars[i]!;
  st.craftTicks = { ...st.craftTicks, [st.craft]: st.craftTicks[st.craft] + 1 };
  if (st.craftHold > 0) st.craftHold--;
  if (--st.craftEval <= 0) {
    st.craftEval = Math.max(1, Math.round(cfg.evalSec / TICK_DT));
    // Ahead: the nearest car in front in our lane band (path frame). Behind: projected on our heading.
    let aheadM = Infinity, aheadClosing = false;
    for (const o of others) if (o && o.ahead > 0 && Math.abs(o.side) < 3.5 && o.ahead < aheadM) { aheadM = o.ahead; aheadClosing = speed - o.along > 0.3; }
    const fx = Math.sin(car.heading), fy = -Math.cos(car.heading);
    let behindM = Infinity, behindClosing = false;
    world.cars.forEach((c, j) => {
      if (j === i) return;
      const dx = c.x - car.x, dy = c.y - car.y, lon = dx * fx + dy * fy, lat = -dx * fy + dy * fx;
      if (lon < 0 && lon > -80 && Math.abs(lat) < 4 && -lon < behindM) { behindM = -lon; behindClosing = c.vx * fx + c.vy * fy > speed + 0.3; }
    });
    const v = Math.max(5, speed);
    const wear = car.wheels.reduce((a, w) => a + w.wear, 0) / 4;
    const dmg = world.settings?.damage === 'realistic' ? Math.max(car.damage.frontWing, car.damage.rearWing, car.damage.left, car.damage.right) : 0;
    const want = chooseMode({ aheadGapSec: aheadM / v, aheadClosing, inTow: car.tow > 0.05, behindGapSec: behindM / v, behindClosing, wear, damage: dmg }, cfg);
    if (want !== st.craft && st.craftHold === 0) { st.craft = want; st.craftHold = Math.round(cfg.holdSec / TICK_DT); }
  }
  // The line the mode wants ~40 m ahead (so a change starts before the corner it's for).
  const o = craftLines.get(line)?.offsets ?? racecraftLines(line, cfg, halfCarM).offsets;
  const target = lineFor(st.craft, (best + 20) % line.n, o);
  if (target !== st.lineTarget) { st.lineTarget = target; st.lineChanges++; }
  const ti = LINE_IDS.indexOf(target), stepW = Math.min(1, cfg.blendPerM * speed * TICK_DT);
  const w = st.lineW.map((x, l) => (l === ti ? Math.min(1, x + stepW) : Math.max(0, x - stepW))) as [number, number, number];
  const sum = w[0] + w[1] + w[2] || 1;
  st.lineW = [w[0] / sum, w[1] / sum, w[2] / sum];
}

/**
 * Reset to track for the AI: crawling or stuck for recovery.resetAfterSec (reversing out hasn't got it
 * going) -> hold reset, same as a player and with the same penalty. troubleTicks < 0 = holding it.
 * After the reset it re-finds its place on the line.
 */
function resetFallback(world: WorldState, i: number, st: AiState, ctx: SimContext, cfg: AiConfig): AiState {
  const car = world.cars[i]!;
  if (car.rejoin.count > st.resets) return { ...st, resets: car.rejoin.count, troubleTicks: 0, near: -1, mode: 'race', recoverTicks: 0, stuckTicks: 0, offset: 0, pitWanted: st.pitWanted };
  const after = cfg.recovery.resetAfterSec;
  const race = world.race, q = world.quali?.cars[i];
  const waiting = !after || st.mode === 'pit' || car.inPitLane || car.servicing || car.rejoin.penaltyTicks > 0
    || (race && (race.phase === 'grid' || race.phase === 'lights' || race.cars[i]?.finished)) || (q && (q.retired || world.tick < q.releaseTick));
  if (waiting) return st.troubleTicks ? { ...st, troubleTicks: 0 } : st;
  const speed = Math.hypot(car.vx, car.vy);
  if (st.troubleTicks < 0) return st; // holding reset until it happens
  const trouble = speed < 3 ? st.troubleTicks + 1 : speed > 6 ? 0 : st.troubleTicks;
  return { ...st, troubleTicks: trouble > after / TICK_DT ? -1 : trouble };
}

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
      src.state = resetFallback(world, i, out.state, ctx, cfg());
      return src.state.troubleTicks < 0 ? { ...out.input, reset: true } : out.input;
    },
  };
  return src;
}
