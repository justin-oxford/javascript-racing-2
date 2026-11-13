// Reset to track (POLISH card): hold the reset input ~1 s and the car is put back on the racing line,
// BEHIND the last point where it was fully on track (never ahead: no shortcut, no time gained), clear of
// other cars, ghosted until it's clear of them, lap invalidated. In a race it then waits out a penalty.
// Runs inside step(), before physics, so timing sees the car start the tick at its new place.
import { progressLine, type ProgressLine } from './race';
import type { SimTrack } from './track';
import type { CarInput, CarState } from './types';

/** config/race.json reset. */
export interface ResetConfig {
  /** Seconds the reset input must be held. */
  holdSec: number;
  /** Race penalty: seconds held stationary after a reset (practice and qualifying: none). */
  penaltySec: number;
  /** Seconds between resets. */
  cooldownSec: number;
  /** How far behind the last on-track point it rejoins, metres. */
  backoffM: number;
  /** No other car within this of the rejoin point (else it slides further back); ghosted until this clear. */
  clearM: number;
  /** Ghosted at least this long after a reset (traffic arriving from behind passes through), then until clear. */
  ghostSec: number;
  /** Speed it rejoins at outside a race, kph (a race always starts from rest: the penalty hold). */
  rejoinKph: number;
}

/** Per-car reset state (plain data on CarState). */
export interface RejoinState {
  /** Racing-line index where the car was last fully on track (all wheels legal, not in the pit lane); -1 = never. */
  lastGoodQ: number;
  /** Ticks the reset input has been held. */
  holdTicks: number;
  /** Ticks until another reset is allowed. */
  cooldownTicks: number;
  /** Ticks of race penalty left (held stationary). */
  penaltyTicks: number;
  /** No contact with other cars (drawn translucent) until clear of them. */
  ghost: boolean;
  /** Ticks of the minimum ghost time left. */
  ghostTicks: number;
  /** Resets so far this session. */
  count: number;
}

export const newRejoin = (): RejoinState => ({ lastGoodQ: -1, holdTicks: 0, cooldownTicks: 0, penaltyTicks: 0, ghost: false, ghostTicks: 0, count: 0 });

const wrapQ = (q: number, n: number) => ((q % n) + n) % n;

/** Nearest racing-line index to (x, y), searching around `prev` (whole line if unknown or far). */
function nearestQ(l: ProgressLine, x: number, y: number, prev: number): number {
  const d2 = (q: number) => (l.x[q]! - x) ** 2 + (l.y[q]! - y) ** 2;
  let near = -1, bd = Infinity;
  if (prev >= 0) for (let d = -15; d <= 15; d++) { const q = wrapQ(prev + d, l.n), v = d2(q); if (v < bd) { bd = v; near = q; } }
  if (near < 0 || bd > 25 * 25) for (let q = 0; q < l.n; q++) { const v = d2(q); if (v < bd) { bd = v; near = q; } }
  return near;
}

/** Where a reset would put car i (metres + heading), or undefined if it has never been on track. */
export function rejoinPose(cars: readonly CarState[], i: number, track: SimTrack, cfg: ResetConfig): { x: number; y: number; heading: number; q: number } | undefined {
  const l = progressLine(track);
  const r = cars[i]!.rejoin;
  if (!l || r.lastGoodQ < 0) return undefined;
  const step = Math.hypot(l.x[1]! - l.x[0]!, l.y[1]! - l.y[0]!) || 2;
  let q = wrapQ(r.lastGoodQ - Math.max(1, Math.round(cfg.backoffM / step)), l.n);
  // Slide back until no other car is near (at most half a lap).
  for (let k = 0; k < l.n / 2; k++) {
    const busy = cars.some((c, j) => j !== i && (c.x - l.x[q]!) ** 2 + (c.y - l.y[q]!) ** 2 < cfg.clearM ** 2);
    if (!busy) break;
    q = wrapQ(q - 1, l.n);
  }
  const n = wrapQ(q + 1, l.n);
  return { x: l.x[q]!, y: l.y[q]!, heading: Math.atan2(l.x[n]! - l.x[q]!, -(l.y[n]! - l.y[q]!)), q };
}

/**
 * Before physics: count the reset hold, perform resets, tick cooldowns and penalties. Returns the cars
 * (unchanged objects where nothing happened) and whether each must be held still this tick (penalty).
 */
export function applyResets(cars: readonly CarState[], inputs: readonly (CarInput | undefined)[], track: SimTrack, cfg: ResetConfig, tickRate: number, inRace: boolean): { cars: CarState[]; held: boolean[] } {
  const held = cars.map(() => false);
  let out = cars as CarState[];
  cars.forEach((car, i) => {
    const r = car.rejoin;
    const want = !!inputs[i]?.reset && r.penaltyTicks === 0;
    const holdTicks = want ? r.holdTicks + 1 : 0;
    let next: RejoinState = { ...r, holdTicks, cooldownTicks: Math.max(0, r.cooldownTicks - 1), penaltyTicks: Math.max(0, r.penaltyTicks - 1), ghostTicks: Math.max(0, r.ghostTicks - 1) };
    let c: CarState = car;
    if (holdTicks >= Math.round(cfg.holdSec * tickRate) && r.cooldownTicks === 0 && !car.inPitLane) {
      const pose = rejoinPose(out, i, track, cfg);
      if (pose) {
        const v = inRace ? 0 : cfg.rejoinKph / 3.6;
        const f = { x: Math.sin(pose.heading), y: -Math.cos(pose.heading) };
        c = {
          ...car,
          x: pose.x, y: pose.y, heading: pose.heading,
          vx: f.x * v, vy: f.y * v, angVel: 0, speed: v,
          controls: { throttle: 0, brake: 0, steer: 0 },
          wallContact: false, barrierContact: false, carContact: false,
          timing: { ...car.timing, lapInvalid: car.timing.started ? true : car.timing.lapInvalid, sectorInvalid: car.timing.started ? true : car.timing.sectorInvalid },
        };
        next = { ...next, lastGoodQ: pose.q, holdTicks: 0, cooldownTicks: Math.round(cfg.cooldownSec * tickRate), penaltyTicks: inRace ? Math.round(cfg.penaltySec * tickRate) : 0, ghost: true, ghostTicks: Math.round((cfg.ghostSec + (inRace ? cfg.penaltySec : 0)) * tickRate), count: r.count + 1 };
      }
    }
    held[i] = next.penaltyTicks > 0;
    if (c !== car || next.holdTicks !== r.holdTicks || next.cooldownTicks !== r.cooldownTicks || next.penaltyTicks !== r.penaltyTicks || next.ghostTicks !== r.ghostTicks || next.count !== r.count) {
      if (out === cars) out = [...cars];
      out[i] = { ...c, rejoin: next };
    }
  });
  return { cars: out, held };
}

/** After physics: where each car was last fully on track, and whether a ghost is clear of everyone yet. */
export function trackRejoin(car: CarState, allLegal: boolean, cars: readonly CarState[], i: number, track: SimTrack, cfg: ResetConfig): RejoinState {
  const r = car.rejoin;
  let lastGoodQ = r.lastGoodQ;
  const l = progressLine(track);
  if (l && allLegal && !car.inPitLane) lastGoodQ = nearestQ(l, car.x, car.y, r.lastGoodQ);
  const ghost = r.ghost && (r.ghostTicks > 0 || cars.some((c, j) => j !== i && (c.x - car.x) ** 2 + (c.y - car.y) ** 2 < cfg.clearM ** 2));
  return lastGoodQ === r.lastGoodQ && ghost === r.ghost ? r : { ...r, lastGoodQ, ghost };
}
