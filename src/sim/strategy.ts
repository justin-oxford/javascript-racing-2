// Race strategy card: tyre compounds, the pit board (what the next stop does), timed stops, fuel weight
// and race-length scaling of fuel burn and tyre wear. Pure functions over plain data.

export type Compound = 'soft' | 'medium' | 'hard' | 'inter' | 'wet';
/** The dry-weather slicks (what the AI picks between on a dry track). */
export const COMPOUNDS: readonly Compound[] = ['soft', 'medium', 'hard'];
/** Every compound, wet-weather tyres included (Wet weather card). */
export const ALL_COMPOUNDS: readonly Compound[] = ['soft', 'medium', 'hard', 'inter', 'wet'];

/** config/strategy.json. */
export interface StrategyConfig {
  compounds: Record<Compound, {
    grip: number; wear: number; lifeLaps: number; color: string; letter: string;
    /** Wet weather card: grip x this at water 0 (dry), 0.3 (damp) and 1 (wet), straight lines between. */
    water?: [number, number, number];
    /** Wear x (1 + dryWear x (1 - water)): inters and wets overheat on a dry track. */
    dryWear?: number;
  }>;
  defaultCompound: Compound;
  pitBoard: { fuelStepKg: number };
  service: { tyreChangeSec: number; fuelEndMarginLaps: number };
  raceLength: { refLaps: number };
  ai: { startStintShare: number };
}

/** Race-length scaling (a session setting): off = normal rates; matched = scaled up for short races. */
export type RaceLengthMode = 'off' | 'matched';

/** FUEL_TO_END on the pit board: enough fuel to finish (plus a margin), not a fixed amount. */
export const FUEL_TO_END = -1;

/**
 * The pit board: what the next stop does. Set by the driver (keyboard keys, the AI's strategy) and sent in
 * the input; the box services exactly this when the car stops.
 */
export interface PitPlan {
  /** Compound to fit (if changing tyres). */
  compound: Compound;
  /** Fuel to add, kg; FUEL_TO_END = enough to finish (practice: fill the tank). */
  fuelKg: number;
  /** Change tyres. */
  tyres: boolean;
  /** Repair damage (Car damage card). */
  repair: boolean;
}

/** A stop in progress (set on the first tick stopped in the box from the pit plan; cleared on leaving). */
export interface StopState {
  /** Seconds of tyre change left (0 when done or not changing). */
  tyreLeftSec: number;
  /** Compound being fitted, or null (not changing, or already fitted). */
  fitting: Compound | null;
  /** Fill the tank to this, kg. */
  fuelToKg: number;
  /** Repairing this stop. */
  repair: boolean;
}

export function defaultPitPlan(cfg: StrategyConfig, compound: Compound = cfg.defaultCompound): PitPlan {
  return { compound, fuelKg: FUEL_TO_END, tyres: true, repair: true };
}

export const isCompound = (c: unknown): c is Compound => c === 'soft' || c === 'medium' || c === 'hard' || c === 'inter' || c === 'wet';

/** A plan from an input, checked (anything malformed keeps the car's current plan). */
export function validPitPlan(p: unknown, current: PitPlan, maxFuelKg: number): PitPlan {
  if (!p || typeof p !== 'object') return current;
  const q = p as Partial<PitPlan>;
  if (!isCompound(q.compound) || typeof q.fuelKg !== 'number' || !Number.isFinite(q.fuelKg) || typeof q.tyres !== 'boolean' || typeof q.repair !== 'boolean') return current;
  return { compound: q.compound, fuelKg: q.fuelKg === FUEL_TO_END ? FUEL_TO_END : Math.max(0, Math.min(maxFuelKg, q.fuelKg)), tyres: q.tyres, repair: q.repair };
}

/** Grip multiplier for a compound. */
export const compoundGrip = (c: Compound, cfg: StrategyConfig): number => cfg.compounds[c]?.grip ?? 1;
/** Wear multiplier for a compound (x its overheating on a dry track, for inters and wets). */
export const compoundWear = (c: Compound, cfg: StrategyConfig, water = 0): number => (cfg.compounds[c]?.wear ?? 1) * (1 + (cfg.compounds[c]?.dryWear ?? 0) * (1 - Math.min(1, water)));

/** Wet weather card: a compound's grip on this much standing water (0 dry .. 1 wet), as a multiplier. */
export function compoundWaterGrip(c: Compound, water: number, cfg: StrategyConfig): number {
  const w = cfg.compounds[c]?.water;
  if (!w || water <= 0) return w ? w[0] : 1;
  const x = Math.min(1, water);
  return x < 0.3 ? w[0] + (w[1] - w[0]) * (x / 0.3) : w[1] + (w[2] - w[1]) * ((x - 0.3) / 0.7);
}

/**
 * Fuel weight: tyres lose grip as the car gets heavier (load sensitivity, at the level of the whole car):
 * grip x (dry mass / mass)^k. k = 0 (absent) = no effect beyond the extra mass itself.
 */
export function fuelGrip(dryMassKg: number, fuelKg: number, k: number | undefined): number {
  return k ? (dryMassKg / (dryMassKg + Math.max(0, fuelKg))) ** k : 1;
}

/** Fuel burn and tyre wear multiplier for a race of `laps` laps (1 when off, in practice, or for long races). */
export function consumableScale(mode: RaceLengthMode | undefined, laps: number | undefined, cfg: StrategyConfig): number {
  if (mode !== 'matched' || !laps || laps <= 0) return 1;
  return Math.max(1, cfg.raceLength.refLaps / laps);
}

/**
 * The fuel a stop fills the tank to. FUEL_TO_END: enough for the laps left (+ margin) at the fuel used per lap
 * so far; with no race (or no measure yet) a full tank.
 */
export function stopFuelTarget(plan: PitPlan, fuelKg: number, tankKg: number, lapsToGo: number | undefined, fuelPerLapKg: number | undefined, cfg: StrategyConfig, scale = 1): number {
  if (plan.fuelKg !== FUEL_TO_END) return Math.min(tankKg, fuelKg + plan.fuelKg);
  if (lapsToGo === undefined || !fuelPerLapKg || fuelPerLapKg <= 0) return tankKg;
  // The margin is in the reference race's laps (race length matched: a lap here is `scale` of those).
  return Math.min(tankKg, Math.max(fuelKg, (Math.max(0, lapsToGo) + cfg.service.fuelEndMarginLaps / scale) * fuelPerLapKg));
}

/** A new stop from the plan. */
export function startStop(plan: PitPlan, fuelToKg: number, damaged: boolean, cfg: StrategyConfig): StopState {
  return { tyreLeftSec: plan.tyres ? cfg.service.tyreChangeSec : 0, fitting: plan.tyres ? plan.compound : null, fuelToKg, repair: plan.repair && damaged };
}

/** Everything the plan asked for is done (fuel within 0.5 kg of the target; repair finished if asked). */
export function stopDone(stop: StopState | null, fuelKg: number, damaged: boolean): boolean {
  return !!stop && stop.fitting === null && fuelKg >= stop.fuelToKg - 0.5 && !(stop.repair && damaged);
}

/**
 * AI tyre choice: the grippiest compound whose life (lifeLaps / wear scale) covers `laps`; if none does, the
 * longest-lasting. `pickSecond` (seeded, at the start) takes the next-best instead, for variety on the grid.
 */
export function aiCompound(laps: number, scale: number, cfg: StrategyConfig, pickSecond = false): Compound {
  const ranked = [...COMPOUNDS].sort((a, b) => cfg.compounds[b].grip - cfg.compounds[a].grip);
  const lasting = ranked.filter((c) => cfg.compounds[c].lifeLaps / scale >= laps);
  if (lasting.length) return pickSecond && lasting.length > 1 ? lasting[1]! : lasting[0]!;
  return [...COMPOUNDS].sort((a, b) => cfg.compounds[b].lifeLaps - cfg.compounds[a].lifeLaps)[0]!;
}

/** The AI's starting compound: covers the first stint (startStintShare of the race), seeded variety. */
export function aiStartCompound(raceLaps: number, scale: number, cfg: StrategyConfig, rand01: number): Compound {
  return aiCompound(Math.max(1, raceLaps * cfg.ai.startStintShare), scale, cfg, rand01 < 0.5);
}
