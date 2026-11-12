// Shapes of /config/physics.json, teams.json, specs.json, and how a car's stats are built:
// stat = team multiplier x spec ratio x setup multiplier (SYS - Car model).
import type { CarBuild } from './types';

/** How far the body's centre (sprite + collision box) is AHEAD of the CG, metres. */
export function bodyOffsetM(cfg: Pick<PhysicsConfig, 'car'>): number {
  return cfg.car.wheelbaseM * (1 - cfg.car.weightFront) - cfg.car.frontAxleFromCentreM;
}

export interface PhysicsConfig {
  car: {
    dryMassKg: number;
    lengthM: number;
    widthM: number;
    wheelbaseM: number;
    /**
     * How far the front axle sits ahead of the car body's centre (the sprite's centre and the collision
     * box's), metres. With the CG placed between the axles by weightFront, this puts the body (and the drawn
     * car) where the art has its tyres (livery card: front axle 1.535 m ahead of the sprite centre).
     */
    frontAxleFromCentreM: number;
    trackWidthM: number;
    /** Fraction of weight on the front axle. */
    weightFront: number;
    cgHeightM: number;
    inertiaScale: number;
  };
  engine: { powerKW: number; topSpeedKph: number; maxDriveForceN: number; reverseForceN: number; maxReverseKph: number };
  brakes: { maxForceN: number; frontBias: number };
  /** Drag force = dragCoef x v^2. Grip x (1 + downforceCoef x v^2). */
  aero: { dragCoef: number; downforceCoef: number };
  /**
   * peakSlipDeg: slip angle of peak lateral grip; past it force falls toward `falloff` x peak, nearly there by
   * falloffSlip x peak slip. lateralStiffness: at most this fraction of a wheel's sideways velocity is removed
   * per tick (60 Hz stability at low speed). lowSpeedMps: slip angles are measured against at least this speed.
   */
  tyres: { baseGrip: number; lateralGrip: number; lateralStiffness: number; frontGrip: number; rearGrip: number; peakSlipDeg: number; falloff: number; falloffSlip: number; lowSpeedMps: number };
  /**
   * Mechanical lock shrinks with speed (lockFalloffKph). assist: full lock = peak slip (x assistPeakPct)
   * relative to the front axle's travel, blending in between assistFromKph and assistFullKph.
   */
  steering: { lockDeg: number; lockFalloffKph: number; assist: boolean; assistPeakPct: number; assistFromKph: number; assistFullKph: number };
  /** Ramp rates, full scale per second. */
  input: { steerRate: number; steerReturnRate: number; throttleRate: number; brakeRate: number };
  wear: { throttlePerSec: number; throttleLowSpeedKph: number; brakePerSec: number; cornerPerSec: number; refSpeedKph: number };
  fuel: { tankKg: number; startKg: number; burnKgPerSec: number; refuelKgPerSec: number; pitServiceMaxKph: number };
  walls: { restitution: number; friction: number; barrierScrubPerSec: number };
  solver: { velocityIterations: number; positionIterations: number };
  defaultCar: CarBuild;
}

export type StatName = 'engine' | 'topSpeed' | 'brakes' | 'drag' | 'downforce' | 'grip';
export type Stats = Record<StatName, number>;
export const STAT_NAMES: readonly StatName[] = ['engine', 'topSpeed', 'brakes', 'drag', 'downforce', 'grip'];

export interface TeamDef {
  id: string;
  name: string;
  /** Livery colours (hex). primary tints the bodywork; helmet = the AI driver's helmet. */
  colors: { primary: string; secondary: string; helmet: string };
  stats: Stats;
}

export interface SpecsConfig {
  referenceSpec: string;
  specs: Record<string, Stats & { name: string }>;
  setups: Record<string, Record<string, Partial<Stats>>>;
}

export interface CarCatalog {
  teams: readonly TeamDef[];
  specs: SpecsConfig;
}

/** Multipliers on the physics.json baseline for one car. */
export function buildStats(build: CarBuild, catalog: CarCatalog): Stats {
  const team = catalog.teams.find((t) => t.id === build.team);
  const spec = catalog.specs.specs[build.spec];
  const ref = catalog.specs.specs[catalog.specs.referenceSpec];
  if (!team) throw new Error(`unknown team "${build.team}"`);
  if (!spec || !ref) throw new Error(`unknown spec "${build.spec}"`);
  const out = {} as Stats;
  for (const s of STAT_NAMES) {
    let v = team.stats[s] * (spec[s] / ref[s]);
    for (const [slot, choice] of Object.entries(build.setup)) v *= catalog.specs.setups[slot]?.[choice]?.[s] ?? 1;
    out[s] = v;
  }
  return out;
}
