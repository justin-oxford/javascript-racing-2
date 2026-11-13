// Car damage (POLISH card): hits cost performance by zone, repaired in the pits.
// Hits come from Planck contacts (planck-cache.ts collects them each step in pre-solve) as the speed the two
// surfaces close at along the contact normal, located in the car's frame: nose -> front wing, tail -> rear
// wing, either side -> that side's suspension. Below a threshold closing speed (rubs, kerbs, resting against
// a wall) nothing happens. Closing speed, not impulse: it doesn't depend on friction, bounce or mass, so a
// rub stays a rub whatever the contact tuning. Damage is plain data on the car.
import type { CarState } from './types';

/** Session setting: Off = today's behaviour; Visual = recorded and shown, no effect; Realistic = it costs. */
export type DamageMode = 'off' | 'visual' | 'realistic';

/** Damage per zone, 0 (none) .. 1 (as bad as it gets: the car keeps going, no DNF). */
export interface DamageState {
  frontWing: number;
  rearWing: number;
  left: number;
  right: number;
}

export const NO_DAMAGE: Readonly<DamageState> = Object.freeze({ frontWing: 0, rearWing: 0, left: 0, right: 0 });

/** config/damage.json. */
export interface DamageConfig {
  /** Closing speed (m/s) along the contact normal below which a hit does nothing. */
  thresholdMps: number;
  /** Damage per m/s over the threshold (before strength and the source multipliers). */
  perMps: number;
  /** Overall strength (the setting's slider). */
  strength: number;
  /** By what was hit: walls, tyre barriers, other cars. */
  wallMult: number;
  barrierMult: number;
  carMult: number;
  /** Where on the car: the front/rear this fraction of the half-length counts as nose/tail. */
  endZone: number;
  /** Effects at full damage. */
  effects: {
    /** Front wing: front tyres' grip lost (understeer). */
    frontGripLoss: number;
    /** Rear wing: rear tyres' grip lost, and drag removed with it. */
    rearGripLoss: number;
    rearDragLoss: number;
    /** Suspension: grip lost at that side's two wheels, and a steering pull toward that side (degrees). */
    sideGripLoss: number;
    pullDeg: number;
  };
  /** Pit repair: seconds to fix a wing (any amount), and suspension seconds at full damage. */
  repair: { wingSec: number; suspensionSec: number };
}

export type HitKind = 'wall' | 'barrier' | 'car';
/** One contact this tick on one car, in world metres, with its closing speed (m/s). */
export interface Hit {
  car: number;
  x: number;
  y: number;
  speed: number;
  kind: HitKind;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** This tick's hits on a car -> its new damage. */
export function applyHits(d: DamageState, car: Pick<CarState, 'x' | 'y' | 'heading'>, hits: readonly Hit[], lengthM: number, bodyOffsetM: number, cfg: DamageConfig): DamageState {
  let out = d;
  const fx = Math.sin(car.heading), fy = -Math.cos(car.heading); // forward
  const rx = -fy, ry = fx; // right
  // Zones are measured from the BODY centre (bodyOffsetM ahead of the CG), where the car collides.
  const bx = car.x + fx * bodyOffsetM, by = car.y + fy * bodyOffsetM;
  for (const h of hits) {
    const over = h.speed - cfg.thresholdMps;
    if (over <= 0) continue;
    const amount = over * cfg.perMps * cfg.strength * (h.kind === 'car' ? cfg.carMult : h.kind === 'barrier' ? cfg.barrierMult : cfg.wallMult);
    const lon = (h.x - bx) * fx + (h.y - by) * fy, lat = (h.x - bx) * rx + (h.y - by) * ry;
    const end = (lengthM / 2) * cfg.endZone;
    const zone: keyof DamageState = lon > end ? 'frontWing' : lon < -end ? 'rearWing' : lat >= 0 ? 'right' : 'left';
    out = { ...out, [zone]: clamp01(out[zone] + amount) };
  }
  return out;
}

/** Grip multiplier for wheel w (0 FL, 1 FR, 2 RL, 3 RR) from damage. */
export function damageGrip(d: DamageState, w: number, cfg: DamageConfig): number {
  const e = cfg.effects;
  const axle = w < 2 ? 1 - d.frontWing * e.frontGripLoss : 1 - d.rearWing * e.rearGripLoss;
  const side = 1 - (w % 2 === 0 ? d.left : d.right) * e.sideGripLoss;
  return Math.max(0, axle * side);
}

/** Steering pull in radians (+ = right) from bent suspension. */
export const damagePull = (d: DamageState, cfg: DamageConfig): number => ((d.right - d.left) * cfg.effects.pullDeg * Math.PI) / 180;

/** Drag multiplier: a broken rear wing drags less. */
export const damageDrag = (d: DamageState, cfg: DamageConfig): number => 1 - d.rearWing * cfg.effects.rearDragLoss;

/** Stopped in the box: repair, wings at a fixed rate (any damage takes wingSec), suspension by how bad it is. */
export function repairStep(d: DamageState, dt: number, cfg: DamageConfig): DamageState {
  const wing = dt / Math.max(0.01, cfg.repair.wingSec), susp = dt / Math.max(0.01, cfg.repair.suspensionSec);
  return { frontWing: Math.max(0, d.frontWing - wing), rearWing: Math.max(0, d.rearWing - wing), left: Math.max(0, d.left - susp), right: Math.max(0, d.right - susp) };
}

export const isDamaged = (d: DamageState, over = 0.005): boolean => d.frontWing > over || d.rearWing > over || d.left > over || d.right > over;
