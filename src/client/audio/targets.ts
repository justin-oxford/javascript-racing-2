// What every sound layer should be doing this tick, from two consecutive sim states. Pure (no Web Audio),
// so it's tested in Node. Tyre layers read the same wheelFx() as the VFX, so squeal starts exactly
// when the smoke does and the telemetry goes red.
import type { CarState, PhysicsConfig, Rules, SurfaceDef } from '../../sim';
import type audioJson from '../../../config/audio.json';
import { wheelFx, type VfxConfig } from '../vfx/triggers';

export type AudioConfig = typeof audioJson;

/**
 * Virtual gearbox for audio only (the physics has none). Gear top speeds spread up to the car's top
 * speed with closer ratios at the top; RPM climbs through each gear and drops on the "shift".
 */
export function virtualRpm(speedKph: number, topKph: number, e: AudioConfig['engine']): { gear: number; rpm: number } {
  const v = Math.max(0, speedKph);
  const tops = Array.from({ length: e.gears }, (_, g) => topKph * ((g + 1) / e.gears) ** e.gearSpread);
  let gear = tops.findIndex((t) => v <= t);
  if (gear < 0) gear = e.gears - 1;
  const lo = gear === 0 ? 0 : tops[gear - 1]!;
  const hi = tops[gear]!;
  const f = Math.min(1, (v - lo) / (hi - lo));
  const from = gear === 0 ? e.idleRpm : e.shiftRpm;
  return { gear: gear + 1, rpm: from + (e.maxRpm - from) * f };
}

export interface SoundTargets {
  engine: { rpm: number; gear: number; throttle: number; limiter: boolean; lift: boolean };
  /** 0..1 levels; 0 = silent. */
  squeal: number;
  squealPitch: number;
  lockup: number;
  wheelspin: number;
  kerb: number;
  kerbPulseHz: number;
  gravel: number;
  grass: number;
  /** One-shots that start this tick. strength 0..1. */
  impacts: Array<{ kind: 'wall' | 'barrier' | 'car'; strength: number }>;
  pitBeep: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function soundTargets(
  prev: CarState,
  car: CarState,
  cfg: AudioConfig,
  vfx: VfxConfig,
  physics: PhysicsConfig,
  rules: Rules,
  surfaces: readonly SurfaceDef[],
  topKph: number,
): SoundTargets {
  const kph = Math.abs(car.speed) * 3.6;
  const fx = ([0, 1, 2, 3] as const).map((w) => wheelFx(prev, car, w, vfx, surfaces, physics.tyres.peakSlipDeg));
  const peak = (k: 'slide' | 'lockup' | 'spin') => Math.max(...fx.map((f) => f[k]));

  // Engine: virtual gears; the pit limiter pins RPM and stutters.
  const limiter = car.inPitLane && kph > rules.pitSpeedLimitKph - 3 && car.controls.throttle > 0.1;
  const { gear, rpm } = limiter ? { gear: 2, rpm: cfg.engine.limiterRpm } : virtualRpm(kph, topKph, cfg.engine);

  // Surfaces: share of wheels on each, only while moving.
  const on = (id: string) => car.wheels.filter((w) => surfaces[w.surface]?.id === id).length / 4;
  const moving = clamp01(kph / 40);

  // Impacts: the tick a contact starts, scaled by the speed just before it.
  const impacts: SoundTargets['impacts'] = [];
  const hitStrength = () => clamp01((Math.abs(prev.speed) * 3.6 - cfg.impacts.minKph) / (cfg.impacts.fullKph - cfg.impacts.minKph));
  if (car.wallContact && !prev.wallContact) impacts.push({ kind: 'wall', strength: hitStrength() });
  if (car.barrierContact && !prev.barrierContact) impacts.push({ kind: 'barrier', strength: hitStrength() });
  if (car.carContact && !prev.carContact) impacts.push({ kind: 'car', strength: Math.max(0.15, hitStrength()) });

  const slide = peak('slide');
  return {
    engine: { rpm, gear, throttle: car.controls.throttle, limiter, lift: prev.controls.throttle >= 0.2 && car.controls.throttle < 0.2 },
    squeal: slide > 0 ? clamp01(slide) ** cfg.tyres.squealCurve : 0,
    squealPitch: 1 + cfg.tyres.squealPitchSpread * clamp01(slide),
    lockup: clamp01(peak('lockup')),
    wheelspin: clamp01(peak('spin')),
    kerb: on('kerb') * moving,
    kerbPulseHz: Math.abs(car.speed) / cfg.surfaces.kerbStripeM,
    gravel: on('gravel') * moving,
    grass: on('grass') * moving,
    impacts: impacts.filter((i) => i.strength > 0),
    pitBeep: car.inPitLane && !prev.inPitLane,
  };
}

/** The car's top speed (kph) for this build, for the virtual gearbox. */
export function topSpeedKph(physics: PhysicsConfig, topSpeedStat: number): number {
  return physics.engine.topSpeedKph * topSpeedStat;
}
