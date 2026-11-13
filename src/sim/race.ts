// Race mode (card 06): grid -> start lights -> racing -> finishing -> results, as plain data on the
// world (WorldState.race), advanced inside step(). Pure: the light hold is drawn from a seeded PRNG
// kept in the state, so the server (card 07) and replays get the same start.
// Practice has no race state: any box services any car, and nothing is held or classified.
import type { SimTrack } from './track';
import { timingSequence } from './timing';
import type { CarInput, CarState, SimEvent } from './types';

/** config/race.json */
export interface RaceConfig {
  defaultLaps: number;
  gridSec: number;
  lightIntervalSec: number;
  holdMinSec: number;
  holdMaxSec: number;
  jumpStartThrottle: number;
  finishTimeoutSec: number;
  /** Timing lines also count crossings this far past their ends (metres): run-off, practice and race. */
  timingLineReachM: number;
  /** Race weekend (quali.ts): qualifying length and pit-lane release gap, seconds. */
  qualiSec: number;
  qualiReleaseGapSec: number;
  /** Fuel everyone starts qualifying with (and is topped back up to in the pits), kg. */
  qualiFuelKg: number;
  /** Sim speed-up once the player's qualifying session is over (client only). */
  qualiFastForward: number;
  /** Equal performance mode: how far team multipliers move toward 1.0 (0-1). */
  equalise: number;
  /** Points for P1, P2, ... in a race. */
  points: number[];
}

export type RacePhase = 'grid' | 'lights' | 'racing' | 'finishing' | 'results';

export interface RaceCar {
  /** Grid slot (0 = pole). */
  slot: number;
  /** Assigned pit box (0-based), -1 = the track has no boxes. Only this box services the car. */
  box: number;
  /** Racing-line index, tracked continuously (for progress). */
  near: number;
  /** Laps since the start, fractional (laps completed + distance round the current lap). */
  progress: number;
  /** Sim seconds at every timing line crossed since lights out, in order (the start line first). */
  crossings: number[];
  pitStops: number;
  /** Serviced during the current pit-lane visit (a car creeping in its box counts as one stop). */
  inStop: boolean;
  /** Throttle while the lights were on. Flagged on the results; no penalty yet. */
  jumpStart: boolean;
  /** Fastest valid lap, seconds; 0 = none yet. */
  bestLap: number;
  finished: boolean;
  /** Laps completed when it took the flag (a lapped car finishes a lap down). */
  finishLaps: number;
  /** Race time (from lights out) when it took the flag, seconds. */
  finishTime: number;
}

export interface RaceState {
  laps: number;
  phase: RacePhase;
  /** Tick the current phase began. */
  phaseTick: number;
  /** Red lights lit, 0..5 (0 again after lights out). */
  lights: number;
  /** Ticks between the fifth light and lights out (seeded random). */
  holdTicks: number;
  /** Sim seconds at lights out, -1 before. */
  startTime: number;
  /** Sim seconds when the winner took the flag, -1 before. */
  leaderFinishTime: number;
  /** More cars than boxes: boxes are shared round-robin (warned at the start). */
  sharedBoxes: boolean;
  cars: RaceCar[];
  /** Car indices in running order (P1 first). */
  order: number[];
}

/** mulberry32: [0,1) and the next state. */
function rand(s: number): [number, number] {
  const n = (s + 0x6d2b79f5) >>> 0;
  let t = n;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, n];
}

/** Grid order for a race: order[slot] = car index. Seeded shuffle, or the player (car 0) in `playerSlot`. */
export function gridOrder(cars: number, seed: number, playerSlot?: number): number[] {
  const order = Array.from({ length: cars }, (_, i) => i);
  let s = seed >>> 0 || 1, r: number;
  for (let i = cars - 1; i > 0; i--) {
    [r, s] = rand(s);
    const j = Math.floor(r * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  if (playerSlot !== undefined && playerSlot >= 0 && playerSlot < cars) {
    const at = order.indexOf(0);
    [order[at], order[playerSlot]] = [order[playerSlot]!, order[at]!];
  }
  return order;
}

/** A fresh race: everyone on the grid, boxes assigned in grid order (round-robin if there are too few). */
export function newRaceState(order: readonly number[], laps: number, seed: number, track: SimTrack, cfg: RaceConfig, tickRate: number): RaceState {
  const nBoxes = track.boxes.length;
  const slotOf = new Map(order.map((car, slot) => [car, slot]));
  const [r] = rand(seed ^ 0x9e3779b9);
  return {
    laps,
    phase: 'grid',
    phaseTick: 0,
    lights: 0,
    holdTicks: Math.round((cfg.holdMinSec + r * (cfg.holdMaxSec - cfg.holdMinSec)) * tickRate),
    startTime: -1,
    leaderFinishTime: -1,
    sharedBoxes: nBoxes > 0 && nBoxes < order.length,
    cars: order.map((_, car) => {
      const slot = slotOf.get(car)!;
      return { slot, box: nBoxes ? slot % nBoxes : -1, near: -1, progress: 0, crossings: [], pitStops: 0, inStop: false, jumpStart: false, bestLap: 0, finished: false, finishLaps: 0, finishTime: 0 };
    }),
    order: [...order],
  };
}

/** Cars are held still (inputs ignored) until lights out. */
export function raceHolds(race: RaceState | undefined): boolean {
  return !!race && (race.phase === 'grid' || race.phase === 'lights');
}

// The racing line in metres plus the start/finish index, memoised per track (static data, not state).
interface ProgressLine { x: Float64Array; y: Float64Array; n: number; sf: number }
const lines = new WeakMap<SimTrack, ProgressLine | null>();
function progressLine(track: SimTrack): ProgressLine | null {
  let l = lines.get(track);
  if (l !== undefined) return l;
  const ppm = track.json.pxPerMeter, pts = track.json.racingLine, sf = track.json.timingLines.startFinish;
  if (pts.length < 3 || !sf) l = null;
  else {
    const x = Float64Array.from(pts, (p) => p.x / ppm), y = Float64Array.from(pts, (p) => p.y / ppm);
    const mx = (sf.a.x + sf.b.x) / 2 / ppm, my = (sf.a.y + sf.b.y) / 2 / ppm;
    let best = 0, bd = Infinity;
    for (let q = 0; q < x.length; q++) { const d = (x[q]! - mx) ** 2 + (y[q]! - my) ** 2; if (d < bd) { bd = d; best = q; } }
    l = { x, y, n: x.length, sf: best };
  }
  lines.set(track, l);
  return l;
}

/** Laps since the start as a float, from timing (laps, which line is next) and the nearest line point. */
function trackProgress(car: CarState, prevNear: number, track: SimTrack): { near: number; progress: number } {
  const l = progressLine(track);
  if (!l) return { near: -1, progress: car.timing.laps };
  const d2 = (q: number) => (l.x[q]! - car.x) ** 2 + (l.y[q]! - car.y) ** 2;
  let near = -1, bd = Infinity;
  if (prevNear >= 0) for (let d = -10; d <= 30; d++) { const q = (((prevNear + d) % l.n) + l.n) % l.n, v = d2(q); if (v < bd) { bd = v; near = q; } }
  if (near < 0 || bd > 30 * 30) for (let q = 0; q < l.n; q++) { const v = d2(q); if (v < bd) { bd = v; near = q; } }
  // Between line points: project onto the segment either side of the nearest point (cars side by side
  // on the same 2 m point still get an order).
  const nx = (near + 1) % l.n, px = (near - 1 + l.n) % l.n;
  const along = (a: number, b: number) => {
    const sx = l.x[b]! - l.x[a]!, sy = l.y[b]! - l.y[a]!, len2 = sx * sx + sy * sy || 1;
    return ((car.x - l.x[a]!) * sx + (car.y - l.y[a]!) * sy) / len2;
  };
  const fwd = along(near, nx), sub = fwd >= 0 ? Math.min(1, fwd) : -Math.min(1, along(near, px));
  let frac = ((((near - l.sf) % l.n) + l.n) % l.n + sub) / l.n;
  if (frac < 0) frac += 1;
  const seqLen = timingSequence(track.json).length;
  const t = car.timing;
  if (!t.started) { if (frac > 0.5) frac -= 1; }
  else if (t.next === seqLen - 1) { if (frac < 0.5) frac += 1; } // in the last sector: S/F is next
  else if (t.next === 0 && frac > 0.5) frac -= 1; // just crossed S/F, line point not past it yet
  return { near, progress: (t.started ? t.laps : 0) + frac };
}

/**
 * One tick of race logic, after the cars have moved. `prev` are the cars before this tick, `cars` after;
 * `raw` are the drivers' requested inputs (for jump starts); `events` this tick's timing events.
 */
export function updateRace(race: RaceState, tick: number, dt: number, prev: readonly CarState[], cars: readonly CarState[], raw: readonly CarInput[], events: readonly SimEvent[], track: SimTrack, cfg: RaceConfig): RaceState {
  const r: RaceState = { ...race, cars: race.cars.map((c) => ({ ...c })) };
  const now = tick * dt;
  const since = (tick - r.phaseTick) * dt;
  const enter = (phase: RacePhase) => { r.phase = phase; r.phaseTick = tick; };

  // Phases.
  if (r.phase === 'grid' && since >= cfg.gridSec) { enter('lights'); r.lights = 1; }
  else if (r.phase === 'lights') {
    r.lights = Math.min(5, 1 + Math.floor(since / cfg.lightIntervalSec + 1e-9));
    if (tick - r.phaseTick >= Math.round((4 * cfg.lightIntervalSec) / dt) + r.holdTicks) { enter('racing'); r.lights = 0; r.startTime = now; }
  }
  if (r.phase === 'lights') raw.forEach((inp, i) => { if (inp.throttle > cfg.jumpStartThrottle) r.cars[i]!.jumpStart = true; });

  // Per car: progress, line crossings, best lap, pit stops.
  const racing = r.phase === 'racing' || r.phase === 'finishing';
  cars.forEach((car, i) => {
    const rc = r.cars[i]!, was = prev[i]!;
    const p = trackProgress(car, rc.near, track);
    rc.near = p.near;
    if (!rc.finished) rc.progress = p.progress;
    if (racing && !rc.finished && car.timing.sectorStart !== was.timing.sectorStart) rc.crossings = [...rc.crossings, car.timing.sectorStart];
    if (car.servicing && !rc.inStop) { rc.pitStops++; rc.inStop = true; }
    if (!car.inPitLane) rc.inStop = false;
  });
  for (const e of events) {
    if (e.type !== 'lap' || !racing) continue;
    const rc = r.cars[e.car]!;
    if (!e.invalid && (rc.bestLap === 0 || e.time < rc.bestLap)) rc.bestLap = e.time;
  }

  // Chequered flag: the winner at `laps`; after that everyone finishes at their next crossing.
  if (racing) {
    const crossed = events.filter((e): e is Extract<SimEvent, { type: 'lap' }> => e.type === 'lap')
      .map((e) => ({ car: e.car, at: cars[e.car]!.timing.sectorStart, laps: cars[e.car]!.timing.laps }))
      .sort((a, b) => a.at - b.at);
    for (const c of crossed) {
      const rc = r.cars[c.car]!;
      if (rc.finished) continue;
      if (r.leaderFinishTime < 0 && c.laps >= r.laps) { r.leaderFinishTime = c.at; enter('finishing'); }
      if (r.leaderFinishTime >= 0) { rc.finished = true; rc.finishLaps = c.laps; rc.finishTime = c.at - r.startTime; rc.progress = c.laps; }
    }
    if (r.phase === 'finishing' && (r.cars.every((c) => c.finished) || now - r.leaderFinishTime >= cfg.finishTimeoutSec)) enter('results');
  }

  // Running order: by laps (finishers frozen at their finishing lap count), then who got there first.
  r.order = r.cars.map((_, i) => i).sort((a, b) => {
    const ca = r.cars[a]!, cb = r.cars[b]!;
    if (r.phase === 'grid' || r.phase === 'lights') return ca.slot - cb.slot;
    const pa = ca.finished ? ca.finishLaps : ca.progress, pb = cb.finished ? cb.finishLaps : cb.progress;
    if (ca.finished && cb.finished) return pb - pa || ca.finishTime - cb.finishTime;
    if (ca.finished !== cb.finished) return pb - pa || (ca.finished ? -1 : 1);
    // Dead level: whoever crossed the last timing line first.
    const k = Math.min(ca.crossings.length, cb.crossings.length) - 1;
    return pb - pa || cb.crossings.length - ca.crossings.length || (k >= 0 ? ca.crossings[k]! - cb.crossings[k]! : ca.slot - cb.slot);
  });
  return r;
}

export interface Gap {
  /** Seconds behind (leader / car ahead), from the times they crossed the same timing line. */
  seconds: number;
  /** Whole laps behind instead (shown as "+1 LAP"). */
  laps: number;
}

/** Gap from car `i` to car `ahead` (both in race order), from their crossings of the same line. */
export function raceGap(race: RaceState, i: number, ahead: number): Gap | undefined {
  const me = race.cars[i]!, them = race.cars[ahead]!;
  const lapsDown = Math.floor((them.finished ? them.finishLaps : them.progress) - (me.finished ? me.finishLaps : me.progress));
  if (lapsDown >= 1) return { seconds: 0, laps: lapsDown };
  const k = me.crossings.length - 1;
  if (k < 0 || them.crossings.length <= k) return undefined;
  // Positions move every tick, gaps at timing lines (like real timing loops): a car that's just been
  // passed between two lines shows 0.0 until the next line gives a real number.
  return { seconds: Math.max(0, me.crossings[k]! - them.crossings[k]!), laps: 0 };
}

export interface ResultRow {
  pos: number;
  car: number;
  laps: number;
  /** Race time for finishers, seconds. */
  time: number;
  finished: boolean;
  /** Behind the winner: seconds, or whole laps. */
  gap: Gap | undefined;
  bestLap: number;
  pitStops: number;
  jumpStart: boolean;
}

export function raceResults(race: RaceState): ResultRow[] {
  const winner = race.order[0]!;
  return race.order.map((car, k) => {
    const c = race.cars[car]!, w = race.cars[winner]!;
    const laps = c.finished ? c.finishLaps : Math.max(0, Math.floor(c.progress));
    const gap = k === 0 ? undefined
      : c.finished && laps === w.finishLaps ? { seconds: c.finishTime - w.finishTime, laps: 0 }
      : { seconds: 0, laps: Math.max(1, w.finishLaps - laps) };
    return { pos: k + 1, car, laps, time: c.finishTime, finished: c.finished, gap, bestLap: c.bestLap, pitStops: c.pitStops, jumpStart: c.jumpStart };
  });
}
