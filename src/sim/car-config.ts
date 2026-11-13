// Shapes of /config/physics.json, teams.json, specs.json, and how a car's stats are built:
// stat = team multiplier x spec ratio x setup multiplier (SYS - Car model).
import type { CarBuild, CarSetup } from './types';

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
  tyres: { baseGrip: number; lateralGrip: number; lateralStiffness: number; frontGrip: number; rearGrip: number; peakSlipDeg: number; falloff: number; falloffSlip: number; lowSpeedMps: number; /** Fuel weight (Race strategy card): grip x (dry mass / mass)^loadSensitivity. Absent = 0. */ loadSensitivity?: number };
  /**
   * Mechanical lock shrinks with speed (lockFalloffKph). assist: full lock = peak slip (x assistPeakPct)
   * relative to the front axle's travel, blending in between assistFromKph and assistFullKph.
   */
  steering: { lockDeg: number; lockFalloffKph: number; assist: boolean; assistPeakPct: number; assistFromKph: number; assistFullKph: number };
  /** Traction assist: drive limited so a driven tyre's combined slip stays at assistPeakPct of its peak. */
  traction: { assist: boolean; assistPeakPct: number };
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

/** specs.json setup: what one notch of each slider does (linear in the notch). */
export interface SetupEffectsConfig {
  range: number;
  frontWing: { frontDownforce: number; drag: number };
  rearWing: { rearDownforce: number; drag: number };
  gearing: { engine: number; topSpeed: number };
  brakeBias: { frontBias: number };
  balance: { frontTransfer: number };
  rideHeight: { downforce: number; offTrackGrip: number };
  tyrePressure: { grip: number; wear: number; peakSlip: number };
}

export interface SpecsConfig {
  referenceSpec: string;
  specs: Record<string, Stats & { name: string }>;
  setup: SetupEffectsConfig;
}

export const SETUP_SLOTS: ReadonlyArray<keyof CarSetup> = ['frontWing', 'rearWing', 'gearing', 'brakeBias', 'balance', 'rideHeight', 'tyrePressure'];
export const NEUTRAL_SETUP: Readonly<CarSetup> = Object.freeze({ frontWing: 0, rearWing: 0, gearing: 0, brakeBias: 0, balance: 0, rideHeight: 0, tyrePressure: 0 });

/**
 * A valid setup from anything: notches clamped to the range and rounded; a v0.16-style one (Low/Med/High
 * switches, e.g. physics.json's defaultCar) is converted (Med = neutral).
 */
export function normalizeSetup(raw: unknown, range = 5): CarSetup {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const notch = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-range, Math.min(range, Math.round(v))) : 0);
  if (typeof s.downforce === 'string' || typeof s.gearing === 'string' || typeof s.brakes === 'string') {
    const wings = ({ Low: -2, High: 2 } as Record<string, number>)[String(s.downforce)] ?? 0;
    return { ...NEUTRAL_SETUP, frontWing: wings, rearWing: wings, gearing: ({ Long: 2, Short: -3 } as Record<string, number>)[String(s.gearing)] ?? 0 };
  }
  return Object.fromEntries(SETUP_SLOTS.map((k) => [k, notch(s[k])])) as unknown as CarSetup;
}

/** What a setup does beyond the stat multipliers: per-axle downforce, brake bias, load transfer, tyres. */
export interface SetupEffects {
  /** Multipliers on each axle's share of the downforce. */
  frontDownforce: number;
  rearDownforce: number;
  /** Added to physics brakes.frontBias. */
  frontBiasAdd: number;
  /** Added to the front axle's share of the cornering load transfer (its weight share by default). */
  frontTransferAdd: number;
  /** Tyre pressure: grip (applied through the grip stat), wear and peak-slip multipliers. */
  grip: number;
  wear: number;
  peakSlip: number;
  /** Ride height: grip multiplier on anything that isn't asphalt (kerbs, grass, gravel). */
  offTrackGrip: number;
}

export function setupEffects(raw: CarSetup, catalog: CarCatalog): SetupEffects {
  const c = catalog.specs.setup, s = normalizeSetup(raw, c.range);
  const ride = 1 + s.rideHeight * c.rideHeight.downforce;
  return {
    frontDownforce: (1 + s.frontWing * c.frontWing.frontDownforce) * ride,
    rearDownforce: (1 + s.rearWing * c.rearWing.rearDownforce) * ride,
    frontBiasAdd: s.brakeBias * c.brakeBias.frontBias,
    frontTransferAdd: s.balance * c.balance.frontTransfer,
    grip: 1 + s.tyrePressure * c.tyrePressure.grip,
    wear: Math.max(0.1, 1 + s.tyrePressure * c.tyrePressure.wear),
    peakSlip: Math.max(0.3, 1 + s.tyrePressure * c.tyrePressure.peakSlip),
    offTrackGrip: Math.max(0.5, 1 + s.rideHeight * c.rideHeight.offTrackGrip),
  };
}

/** The setup's share of the six stats (team x spec x THIS). Downforce here = the two axles' average. */
function setupStats(raw: CarSetup, catalog: CarCatalog): Partial<Stats> {
  const c = catalog.specs.setup, s = normalizeSetup(raw, c.range), e = setupEffects(s, catalog);
  return {
    engine: 1 + s.gearing * c.gearing.engine,
    topSpeed: 1 + s.gearing * c.gearing.topSpeed,
    drag: 1 + s.frontWing * c.frontWing.drag + s.rearWing * c.rearWing.drag,
    downforce: (e.frontDownforce + e.rearDownforce) / 2,
    grip: e.grip, // tyre pressure: in the stat so the AI's speed plan sees it too
  };
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
    // Equal performance: the team's multiplier blended toward 1.0 (Motus too: Team stats keeps it slow).
    const eq = Math.max(0, Math.min(1, build.equalise ?? 0));
    let v = (team.stats[s] + (1 - team.stats[s]) * eq) * (spec[s] / ref[s]);
    v *= setupStats(build.setup, catalog)[s] ?? 1;
    out[s] = v;
  }
  return out;
}
