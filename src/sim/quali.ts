// Qualifying (race weekend card): a timed session, everyone on track at once like F1 qualifying. Plain
// data on the world (WorldState.quali), advanced inside step().
// - Cars start in the pit lane; car 0 (the player) is free at once, the others are released one at a
//   time in a seeded order so they don't all leave together.
// - Best valid lap sets the grid. When the clock hits zero (the chequered flag) a car on a timed lap may
//   finish it; its session ends at its next start/finish crossing (or at once if it isn't on a lap).
// - A car can retire from the session (the player's "end session"): parked and held, its time stands.
import type { RaceConfig } from './race';
import type { CarInput, CarState, SimEvent } from './types';

/** config/race.json, qualifying part. */
export interface QualiConfig {
  /** Session length, seconds. */
  qualiSec: number;
  /** Gap between AI cars being released from the pit lane, seconds. */
  qualiReleaseGapSec: number;
}

export type QualiPhase = 'running' | 'flag' | 'results';

export interface QualiCar {
  /** Tick this car may leave the pit lane (held still before it). */
  releaseTick: number;
  /** Fastest valid lap, seconds; 0 = none. */
  bestLap: number;
  /** Valid timed laps completed. */
  laps: number;
  /** Session over for this car (after the flag, or retired). */
  done: boolean;
  /** Ended its session early (parked in the pits, held). */
  retired: boolean;
}

export interface QualiState {
  durationSec: number;
  phase: QualiPhase;
  phaseTick: number;
  /** Tick the session clock started. */
  startTick: number;
  cars: QualiCar[];
  /** Car indices by best lap (no time: after everyone with one, by car index). */
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

/** A fresh session: car 0 free at once, the rest released every releaseGapSec in a seeded order. */
export function newQualiState(cars: number, seed: number, cfg: QualiConfig, tickRate: number): QualiState {
  const ai = Array.from({ length: Math.max(0, cars - 1) }, (_, k) => k + 1);
  let s = seed >>> 0 || 1, r: number;
  for (let i = ai.length - 1; i > 0; i--) {
    [r, s] = rand(s);
    const j = Math.floor(r * (i + 1));
    [ai[i], ai[j]] = [ai[j]!, ai[i]!];
  }
  const release = new Map(ai.map((car, k) => [car, Math.round((k + 1) * cfg.qualiReleaseGapSec * tickRate)]));
  return {
    durationSec: cfg.qualiSec,
    phase: 'running',
    phaseTick: 0,
    startTick: 0,
    cars: Array.from({ length: cars }, (_, i) => ({ releaseTick: release.get(i) ?? 0, bestLap: 0, laps: 0, done: false, retired: false })),
    order: Array.from({ length: cars }, (_, i) => i),
  };
}

/** Is car i held still this tick (not yet released, or retired)? */
export function qualiHolds(q: QualiState | undefined, i: number, tick: number): boolean {
  const c = q?.cars[i];
  return !!c && (c.retired || tick < c.releaseTick);
}

/** Seconds left on the clock (0 once the flag is out). */
export function qualiTimeLeft(q: QualiState, tick: number, dt: number): number {
  return Math.max(0, q.durationSec - (tick - q.startTick) * dt);
}

/** Order by best lap; cars without a time after, in car order. */
export function qualiOrder(cars: readonly QualiCar[]): number[] {
  return cars.map((_, i) => i).sort((a, b) => {
    const ta = cars[a]!.bestLap || Infinity, tb = cars[b]!.bestLap || Infinity;
    return ta - tb || a - b;
  });
}

/** One tick of qualifying, after the cars have moved and been timed. */
export function updateQuali(q: QualiState, tick: number, dt: number, cars: readonly CarState[], _raw: readonly CarInput[], events: readonly SimEvent[], cfg: RaceConfig): QualiState {
  const r: QualiState = { ...q, cars: q.cars.map((c) => ({ ...c })) };
  // Laps: only counted until the car's session is over. A lap that started before the flag still counts.
  for (const e of events) {
    if (e.type !== 'lap' || r.phase === 'results') continue;
    const c = r.cars[e.car]!;
    if (c.done) continue;
    if (!e.invalid) {
      c.laps++;
      if (c.bestLap === 0 || e.time < c.bestLap) c.bestLap = e.time;
    }
    if (r.phase === 'flag') c.done = true; // took the chequered flag
  }
  if (r.phase === 'running' && qualiTimeLeft(r, tick, dt) <= 0) {
    r.phase = 'flag';
    r.phaseTick = tick;
    // Not on a timed lap (out lap, invalid lap, in the pit lane): that's it for them.
    cars.forEach((car, i) => {
      const c = r.cars[i]!;
      if (!car.timing.started || car.timing.lapInvalid || car.inPitLane) c.done = true;
    });
  }
  if (r.phase === 'flag' && (r.cars.every((c) => c.done) || (tick - r.phaseTick) * dt >= cfg.finishTimeoutSec)) {
    r.phase = 'results';
    r.phaseTick = tick;
    r.cars.forEach((c) => (c.done = true));
  }
  r.order = qualiOrder(r.cars);
  return r;
}

/** End car i's session now: its best time stands. (The caller parks the car; see retireFromQuali.) */
export function retireQualiCar(q: QualiState, i: number): QualiState {
  return { ...q, cars: q.cars.map((c, k) => (k === i ? { ...c, retired: true, done: true } : c)) };
}

export interface QualiResultRow {
  pos: number;
  car: number;
  bestLap: number;
  /** Seconds off pole (0 for pole or no time). */
  gap: number;
  laps: number;
}

export function qualiResults(q: QualiState): QualiResultRow[] {
  const pole = q.cars[q.order[0]!]?.bestLap ?? 0;
  return q.order.map((car, k) => {
    const c = q.cars[car]!;
    return { pos: k + 1, car, bestLap: c.bestLap, gap: c.bestLap && pole ? c.bestLap - pole : 0, laps: c.laps };
  });
}

/** Championship-style points for a finishing position (1-based); 0 outside the table. */
export function pointsFor(pos: number, table: readonly number[]): number {
  return table[pos - 1] ?? 0;
}
