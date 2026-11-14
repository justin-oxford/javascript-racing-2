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
  tyres: { baseGrip: number; lateralGrip: number; lateralStiffness: number; frontGrip: number; rearGrip: number; peakSlipDeg: number; falloff: number; falloffSlip: number; lowSpeedMps: number; /** Fuel weight (Race strategy card): grip x (dry mass / mass)^loadSensitivity. Absent = 0. */ loadSensitivity?: number; /** Across an axle: a tyre's grip x (its load / the axle's mean)^-transferSensitivity, so load transfer costs grip (suspension balance). Absent = 0. */ transferSensitivity?: number };
  /**
   * Mechanical lock shrinks with speed (lockFalloffKph), plus lowSpeedLockDeg more at a standstill, fading
   * linearly to none by lowSpeedLockToKph (low-speed maneuverability card; absent = none). assist: full lock =
   * peak slip (x assistPeakPct) relative to the front axle's travel, blending in between assistFromKph and
   * assistFullKph.
   */
  steering: { lockDeg: number; lockFalloffKph: number; lowSpeedLockDeg?: number; lowSpeedLockToKph?: number; assist: boolean; assistPeakPct: number; assistFromKph: number; assistFullKph: number };
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
  colors: { primary: string; secondary: string; helmet: string; accent?: string };
  /** Livery card phase 2: a livery PNG (template size, 256x512) drawn over the paint, under the shading; site path. */
  livery?: string;
  stats: Stats;
}

/** A setup field in real units: range, step, and where it sits against the physics' per-notch effects. */
export interface SetupFieldDef {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  /** The value that is "notch 0" for the physics effects below (the old neutral car). */
  neutral: number;
  /** Units per physics notch (anti-roll bars: clicks of front-minus-rear difference per notch). */
  perNotch: number;
}

export type SetupFieldId = keyof CarSetup;
export const SETUP_FIELDS: ReadonlyArray<SetupFieldId> = ['frontWingDeg', 'rearWingDeg', 'topSpeedKph', 'brakeBiasPct', 'arbFront', 'arbRear', 'rideFrontMm', 'rideRearMm', 'pressurePsi'];

/** specs.json setup: the fields (real units) and what one physics notch of each setting does (linear). */
export interface SetupEffectsConfig {
  fields: Record<SetupFieldId, SetupFieldDef>;
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

/** The physics' view of a setup: notches (fractional) per setting, 0 = the old neutral car. */
export interface SetupNotches { frontWing: number; rearWing: number; gearing: number; brakeBias: number; balance: number; rideHeight: number; tyrePressure: number }

/** Every field at its neutral value (the old neutral car; a track's base setup is in its track.json). */
export function neutralSetup(cfg: SetupEffectsConfig): CarSetup {
  return Object.fromEntries(SETUP_FIELDS.map((k) => [k, cfg.fields[k].neutral])) as unknown as CarSetup;
}

/** A value clamped to the field's range and snapped to its step. */
export function snapSetupValue(v: number, f: SetupFieldDef): number {
  const snapped = f.min + Math.round((v - f.min) / f.step) * f.step;
  return Math.round(Math.max(f.min, Math.min(f.max, snapped)) * 1000) / 1000;
}

/** From real units to the physics' notches. */
export function setupNotches(s: CarSetup, cfg: SetupEffectsConfig): SetupNotches {
  const f = cfg.fields, n = (k: SetupFieldId, v = s[k]) => (v - f[k].neutral) / f[k].perNotch;
  return {
    frontWing: n('frontWingDeg'),
    rearWing: n('rearWingDeg'),
    gearing: n('topSpeedKph'),
    brakeBias: n('brakeBiasPct'),
    balance: (s.arbFront - s.arbRear - (f.arbFront.neutral - f.arbRear.neutral)) / f.arbFront.perNotch,
    rideHeight: n('rideFrontMm', (s.rideFrontMm + s.rideRearMm) / 2),
    tyrePressure: n('pressurePsi'),
  };
}

/** From the old notch format (-5..+5) to real units. */
function fromNotches(o: Partial<Record<keyof SetupNotches, number>>, cfg: SetupEffectsConfig): CarSetup {
  const f = cfg.fields, at = (k: SetupFieldId, notch = 0) => f[k].neutral + notch * f[k].perNotch;
  const bal = (o.balance ?? 0) * f.arbFront.perNotch;
  return {
    frontWingDeg: at('frontWingDeg', o.frontWing), rearWingDeg: at('rearWingDeg', o.rearWing), topSpeedKph: at('topSpeedKph', o.gearing),
    brakeBiasPct: at('brakeBiasPct', o.brakeBias), arbFront: f.arbFront.neutral + bal / 2, arbRear: f.arbRear.neutral - bal / 2,
    rideFrontMm: at('rideFrontMm', o.rideHeight), rideRearMm: at('rideRearMm', o.rideHeight), pressurePsi: at('pressurePsi', o.tyrePressure),
  };
}

const OLD_SLOTS = ['frontWing', 'rearWing', 'gearing', 'brakeBias', 'balance', 'rideHeight', 'tyrePressure'];

/**
 * A valid setup from anything: real units clamped and snapped; the old notch format (-5..+5, profiles and
 * configs from before real units) and the v0.16 Low/Med/High switches (physics.json defaultCar) converted.
 * Anything missing takes `base` (a track's base setup), else neutral.
 */
export function normalizeSetup(raw: unknown, cfg: SetupEffectsConfig, base?: CarSetup): CarSetup {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  let out: CarSetup;
  if (typeof s.downforce === 'string' || typeof s.gearing === 'string' || typeof s.brakes === 'string') {
    const wings = ({ Low: -2, High: 2 } as Record<string, number>)[String(s.downforce)] ?? 0;
    out = fromNotches({ frontWing: wings, rearWing: wings, gearing: ({ Long: 2, Short: -3 } as Record<string, number>)[String(s.gearing)] ?? 0 }, cfg);
  } else if (SETUP_FIELDS.some((k) => num(s[k]) !== undefined)) {
    const fallback = base ?? neutralSetup(cfg);
    out = Object.fromEntries(SETUP_FIELDS.map((k) => [k, num(s[k]) ?? fallback[k]])) as unknown as CarSetup;
  } else if (OLD_SLOTS.some((k) => num(s[k]) !== undefined)) {
    out = fromNotches(Object.fromEntries(OLD_SLOTS.map((k) => [k, num(s[k]) ?? 0])) as Partial<Record<keyof SetupNotches, number>>, cfg);
  } else out = base ?? neutralSetup(cfg);
  return Object.fromEntries(SETUP_FIELDS.map((k) => [k, snapSetupValue(out[k], cfg.fields[k])])) as unknown as CarSetup;
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
  const c = catalog.specs.setup, s = setupNotches(normalizeSetup(raw, c), c);
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
  const c = catalog.specs.setup, s = setupNotches(normalizeSetup(raw, c), c), e = setupEffects(raw, catalog);
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

/** Mechanical steering lock at a speed (m/s), radians: lockDeg / (1 + kph / lockFalloffKph), plus the extra
 *  low-speed lock (lowSpeedLockDeg at a standstill, fading linearly to nothing by lowSpeedLockToKph). */
export function mechLockRad(speedMps: number, st: PhysicsConfig['steering']): number {
  const kph = Math.abs(speedMps) * 3.6;
  const extra = st.lowSpeedLockDeg && st.lowSpeedLockToKph ? st.lowSpeedLockDeg * Math.max(0, 1 - kph / st.lowSpeedLockToKph) : 0;
  return ((st.lockDeg / (1 + kph / st.lockFalloffKph) + extra) * Math.PI) / 180;
}
