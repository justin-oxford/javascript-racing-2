// Slipstream (tow) + dirty air. Gameplay, so it lives in the sim: computed from car state only, each
// tick, deterministic, and the multiplayer server gets it for free.
import type { CarState } from './types';

/** config/slipstream.json (the sim's part; wind/wake are client feedback). */
export interface SlipstreamConfig {
  tow: { maxDragReduction: number; minRangeM: number; maxRangeM: number; wakeWidthCars: number; wakeWiden: number; maxAngleDeg: number };
  dirtyAir: { maxDownforceLoss: number; dirtyRangeM: number; cornerG: number };
  /** AI: how keenly each difficulty preset (by name; "default" otherwise) tucks into a tow, 0..1. */
  aiTowEagerness: Record<string, number>;
}

const G = 9.81;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * For each car: tow = fraction of aero drag removed (0..maxDragReduction), dirtyAir = fraction of
 * downforce lost (0..maxDownforceLoss). Measured in each LEADER's frame: how far behind its centre the
 * follower is, how far off its centreline, and how aligned the two headings are.
 */
export function wakeEffects(cars: readonly Pick<CarState, 'x' | 'y' | 'heading' | 'vx' | 'vy' | 'angVel'>[], carWidthM: number, cfg: SlipstreamConfig): { tow: number[]; dirtyAir: number[] } {
  const t = cfg.tow, d = cfg.dirtyAir;
  const maxAngle = (t.maxAngleDeg * Math.PI) / 180;
  const tow = cars.map(() => 0), dirtyAir = cars.map(() => 0);
  cars.forEach((me, i) => {
    const speed = Math.hypot(me.vx, me.vy);
    const cornering = Math.abs(speed * me.angVel) > d.cornerG * G;
    cars.forEach((lead, j) => {
      if (i === j) return;
      const fx = Math.sin(lead.heading), fy = -Math.cos(lead.heading);
      const dx = me.x - lead.x, dy = me.y - lead.y;
      const behind = -(dx * fx + dy * fy);
      if (behind <= 0) return;
      const lateral = Math.abs(dx * -fy + dy * fx);
      const halfWake = (t.wakeWidthCars * carWidthM * (1 + t.wakeWiden * Math.min(1, behind / t.maxRangeM))) / 2;
      if (lateral > halfWake) return;
      const dh = Math.abs(Math.atan2(Math.sin(me.heading - lead.heading), Math.cos(me.heading - lead.heading)));
      if (dh > maxAngle) return;
      const align = 1 - dh / maxAngle;
      if (behind >= t.minRangeM && behind <= t.maxRangeM) {
        // Strongest close, fading to nothing at max range; the strongest tow wins (no stacking).
        const fall = 1 - (behind - t.minRangeM) / (t.maxRangeM - t.minRangeM);
        tow[i] = Math.max(tow[i]!, t.maxDragReduction * fall * align);
      }
      if (cornering && behind <= d.dirtyRangeM) dirtyAir[i] = Math.max(dirtyAir[i]!, d.maxDownforceLoss * clamp01(1 - behind / d.dirtyRangeM) * align);
    });
  });
  return { tow, dirtyAir };
}
