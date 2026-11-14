// What each wheel is doing this tick, for the VFX (and later sound). Pure: reads two consecutive sim
// states, touches no DOM, so it's unit-tested against real sim runs in Node.
import type { CarState, SurfaceDef } from '../../sim';
import type vfxJson from '../../../config/vfx.json';

/** (spray is optional: the frozen test baseline predates it; without it there's no spray.) */
export type VfxConfig = Omit<typeof vfxJson, 'spray'> & { spray?: (typeof vfxJson)['spray'] };

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

/**
 * peakSlipDeg: the tyres' peak slip angle (physics tyres.peakSlipDeg). wheel.usage = combined slip as a
 * fraction of peak (03b), so: locked / spinning = the LONGITUDINAL part alone past the peak; sliding =
 * combined slip past slipThreshold x peak (default 1.2). Cornering AT the limit leaves nothing.
 */
export function wheelFx(prev: CarState, car: CarState, w: 0 | 1 | 2 | 3, cfg: VfxConfig, surfaces: readonly SurfaceDef[], peakSlipDeg: number): WheelFx {
  const t = cfg.triggers;
  const wheel = car.wheels[w];
  const kph = Math.abs(car.speed) * 3.6;
  const speedK = clamp(kph / t.intensitySpeedRefKph, 0, 1.5);
  const latPart = Math.abs(wheel.slipDeg) / peakSlipDeg;
  const longPart = Math.sqrt(Math.max(0, wheel.usage * wheel.usage - latPart * latPart));
  const slideOver = clamp(wheel.usage - t.slipThreshold, 0, 1);
  const longOver = clamp(longPart - 1, 0, 1);
  const front = w < 2;
  // Marks and smoke come from the tyre scrubbing under load: a lightly loaded (lifted) wheel over its
  // limit leaves little behind. 1 = an average wheel's share of the car's load.
  const avgLoad = (car.wheels[0].loadN + car.wheels[1].loadN + car.wheels[2].loadN + car.wheels[3].loadN) / 4;
  const loadK = avgLoad > 0 ? clamp(wheel.loadN / avgLoad, 0, 1.5) : 1;

  let slide = 0, lockup = 0, spin = 0;
  if (kph > 2) {
    // Locked under braking, any wheel (03b: braking unloads the rears, so they can lock too).
    if (car.controls.brake > 0.1 && longOver > 0) lockup = longOver * loadK * Math.max(0.4, speedK);
    // Rears spinning under throttle at ANY speed (a traction-limited car at 150 kph isn't sliding);
    // wheelspinMaxKph only fades its intensity with speed.
    else if (!front && car.controls.throttle > 0.1 && longOver > 0) spin = longOver * loadK * Math.max(0.15, 1 - kph / t.wheelspinMaxKph);
    else if (slideOver > 0) slide = slideOver * loadK * Math.max(0.25, speedK);
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
