// What each wheel is doing this tick, for the VFX (and later sound). Pure: reads two consecutive sim
// states, touches no DOM, so it's unit-tested against real sim runs in Node.
import type { CarState, SurfaceDef } from '../../sim';
import type vfxJson from '../../../config/vfx.json';

export type VfxConfig = typeof vfxJson;

export interface WheelFx {
  /** 0..~1.5 each; at most one of slide/lockup/spin is non-zero. */
  slide: number;
  lockup: number;
  spin: number;
  /** Strongest of the three: drives skid-mark alpha and smoke rate. */
  mark: number;
  offTrack: 'grass' | 'gravel' | undefined;
  offIntensity: number;
  /** Rubber laid this tick (alpha for one low-opacity stamp), from this tick's tyre wear. */
  rubber: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function wheelFx(prev: CarState, car: CarState, w: 0 | 1 | 2 | 3, cfg: VfxConfig, surfaces: readonly SurfaceDef[]): WheelFx {
  const t = cfg.triggers;
  const wheel = car.wheels[w];
  const kph = Math.abs(car.speed) * 3.6;
  const speedK = clamp(kph / t.intensitySpeedRefKph, 0, 1.5);
  const over = clamp(wheel.usage - t.slipThreshold, 0, 1);
  const longitudinal = Math.abs(wheel.slipDeg) < t.lockupMaxSlipDeg;
  const front = w < 2;

  let slide = 0, lockup = 0, spin = 0;
  if (over > 0 && kph > 2) {
    if (front && car.controls.brake > 0.1 && longitudinal) lockup = over * Math.max(0.4, speedK);
    // Rears over the limit under throttle with little slip angle are wheelspin at ANY speed (a traction-
    // limited car at 150 kph isn't sliding); wheelspinMaxKph only fades its intensity with speed.
    else if (!front && car.controls.throttle > 0.1 && longitudinal) spin = over * Math.max(0.15, 1 - kph / t.wheelspinMaxKph);
    else slide = over * Math.max(0.25, speedK);
  }

  const surf = surfaces[wheel.surface]?.id;
  const offTrack = (surf === 'grass' || surf === 'gravel') && kph > t.offTrackMinKph ? surf : undefined;
  // Rubber only where tyres are worked: wear above a steady-running baseline (straights stay clean).
  // Pit service resets wear upward: that's negative, so it lays nothing.
  const wearDelta = Math.max(0, prev.wheels[w].wear - wheel.wear - cfg.rubber.minWearPerSec / 60);
  return {
    slide,
    lockup,
    spin,
    mark: Math.max(slide, lockup, spin),
    offTrack,
    offIntensity: offTrack ? clamp(kph / t.intensitySpeedRefKph, 0.2, 1.5) : 0,
    rubber: Math.min(cfg.rubber.maxAlpha, wearDelta * cfg.rubber.factor),
  };
}
