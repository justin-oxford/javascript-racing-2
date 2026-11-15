// Slipstream (tow) + dirty air. Gameplay, so it lives in the sim: computed from car state only, each
// tick, deterministic, and the multiplayer server gets it for free.
//
// Wake model card (round 8): ONE WAKE, a path trail. Every car leaves a trail of its recent path (points with
// the car's speed when laid, plain car state). A follower near a leader's trail gets
//   WAKE = ALONG x SIDEWAYS x SPEED RATIO   (the strongest car ahead wins)
// and both effects come from it: drag x (1 - towMax x WAKE), downforce x (1 - dirtyMax x WAKE). Tyre wear while
// following then comes only from the physics (less downforce, more sliding). `trail` absent or enabled false:
// the old straight-back wake (kept ONLY for comparison).
import type { CarState } from './types';

/** One point of a car's path trail: where its centre was, and its speed then (m/s). */
export interface TrailPoint { x: number; y: number; v: number }

/** config/slipstream.json (the sim's part; wind/wake are client feedback). */
export interface SlipstreamConfig {
  /** tow.maxDragReduction is towMax for both wakes; the rest of `tow` is the old wake's shape only. */
  tow: { maxDragReduction: number; minRangeM: number; maxRangeM: number; wakeWidthCars: number; wakeWiden: number; maxAngleDeg: number };
  /** maxDownforceLoss is dirtyMax for both wakes; dirtyRangeM is the old wake's range only. cornerG: gone from the
   *  config and the wake (round 8); the old comparison wake still honours it if an old config carries one (the
   *  frozen test fixtures do), so it stays exactly the old code. */
  dirtyAir: { maxDownforceLoss: number; dirtyRangeM: number; cornerG?: number };
  /** The path trail (Wake model card); absent or enabled false = the old straight-back wake. */
  trail?: TrailConfig;
  /** AI: how keenly each difficulty preset (by name; "default" otherwise) tucks into a tow, 0..1. */
  aiTowEagerness: Record<string, number>;
}

export interface TrailConfig {
  enabled: boolean;
  /** ALONG: 1 up to fullCars car lengths bumper to bumper behind the leader, fading linearly to 0 at lengthCars. */
  lengthCars: number;
  fullCars: number;
  /** SIDEWAYS: 1 within sideFullWidths car widths of the trail, fading to 0 at sideZeroWidths. */
  sideFullWidths: number;
  sideZeroWidths: number;
  /** A new trail point every stepM of the car's path. */
  stepM: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The trail is on (Wake model card). */
export const trailOn = (cfg: SlipstreamConfig): cfg is SlipstreamConfig & { trail: TrailConfig } => !!cfg.trail?.enabled;

/** Where a tow can be had, as the AI's centre-to-centre distance ahead: the trail from tucked up to its end; the
 *  old wake from minRangeM to maxRangeM. */
export function towRange(cfg: SlipstreamConfig, lengthM: number): { minM: number; maxM: number } {
  return trailOn(cfg) ? { minM: lengthM, maxM: lengthM * (1 + cfg.trail.lengthCars) } : { minM: cfg.tow.minRangeM, maxM: cfg.tow.maxRangeM };
}

/**
 * A car's trail after this tick: a point added every stepM of path (oldest first), kept to the path the wake
 * covers. A jump of more than 4 steps (a reset, a teleport) starts a new trail. Returns the same array when
 * nothing changes (plain state, cheap to copy).
 */
export function updateTrail(trail: readonly TrailPoint[] | undefined, x: number, y: number, v: number, cfg: TrailConfig, lengthM: number): readonly TrailPoint[] {
  const last = trail?.[trail.length - 1];
  if (!trail || !last) return [{ x, y, v }];
  const d = Math.hypot(x - last.x, y - last.y);
  if (d > 4 * cfg.stepM) return [{ x, y, v }];
  if (d < cfg.stepM) return trail;
  // Keep enough points to cover the wake behind the car's centre (a car length + lengthCars + a step).
  const keep = Math.ceil((lengthM * (1 + cfg.lengthCars)) / cfg.stepM) + 2;
  const next = trail.length >= keep ? trail.slice(trail.length - keep + 1) : trail.slice();
  next.push({ x, y, v });
  return next;
}

type WakeCar = Pick<CarState, 'x' | 'y' | 'heading' | 'vx' | 'vy'> & { trail?: readonly TrailPoint[] };

/** One leader's WAKE on one follower (0..1), from the leader's trail: ALONG x SIDEWAYS x SPEED RATIO. */
export function trailWake(me: WakeCar, lead: WakeCar, lengthM: number, widthM: number, cfg: TrailConfig): number {
  const L = lengthM, end = L * (1 + cfg.lengthCars);
  const dx0 = me.x - lead.x, dy0 = me.y - lead.y;
  if (dx0 * dx0 + dy0 * dy0 > (end + 2 * widthM) ** 2) return 0;
  // The trail as a polyline from the leader's centre (now) back through its points (newest first).
  const leadV = Math.hypot(lead.vx, lead.vy);
  const pts = lead.trail ?? [];
  let px = lead.x, py = lead.y, pv = leadV, arc = 0;
  let bestD = Infinity, bestArc = 0, bestV = leadV;
  for (let k = pts.length - 1; k >= -1; k--) {
    // k = -1: nothing older; stop. (The newest point may sit at the car's centre: zero-length segments are skipped.)
    if (k < 0) break;
    const q = pts[k]!;
    const sx = q.x - px, sy = q.y - py, len2 = sx * sx + sy * sy;
    if (len2 > 1e-9) {
      const len = Math.sqrt(len2);
      const t = clamp01(((me.x - px) * sx + (me.y - py) * sy) / len2);
      const cx = px + sx * t, cy = py + sy * t, d = Math.hypot(me.x - cx, me.y - cy);
      if (d < bestD) { bestD = d; bestArc = arc + len * t; bestV = pv + (q.v - pv) * t; }
      arc += len;
    }
    px = q.x; py = q.y; pv = q.v;
    if (arc > end) break;
  }
  if (!Number.isFinite(bestD)) return 0;
  // At the head of the trail: only behind the leader (a car beside or ahead of it is not in its wake).
  if (bestArc < 1e-6) {
    const fx = Math.sin(lead.heading), fy = -Math.cos(lead.heading);
    if (dx0 * fx + dy0 * fy >= 0) return 0;
  }
  // ALONG, on the bumper-to-bumper gap: 1 tucked up (to fullCars), 0 at the trail's end; overlapping (gap < 0, the
  // cars partly alongside) it fades to 0 fully alongside.
  const gap = bestArc - L;
  const along = gap < 0 ? clamp01(1 + gap / L) : gap <= cfg.fullCars * L ? 1 : clamp01(1 - (gap - cfg.fullCars * L) / ((cfg.lengthCars - cfg.fullCars) * L));
  if (along <= 0) return 0;
  const w0 = cfg.sideFullWidths * widthM, w1 = cfg.sideZeroWidths * widthM;
  const sideways = bestD <= w0 ? 1 : clamp01(1 - (bestD - w0) / (w1 - w0));
  if (sideways <= 0) return 0;
  const myV = Math.hypot(me.vx, me.vy);
  const ratio = myV < 1 ? 1 : Math.min(1, Math.max(0, bestV) / myV);
  return along * sideways * ratio;
}

/**
 * For each car: tow = fraction of aero drag removed (0..maxDragReduction), dirtyAir = fraction of
 * downforce lost (0..maxDownforceLoss).
 * Trail on: both from the strongest WAKE among the cars ahead (trailWake), no dead zone close behind, everywhere
 * on track (no cornering gate). Off: the old wake, in each LEADER's frame (how far behind its centre the follower
 * is, how far off its centreline, how aligned the headings), tow from minRangeM, dirty air within dirtyRangeM.
 */
export function wakeEffects(cars: readonly (WakeCar & { angVel?: number })[], carWidthM: number, cfg: SlipstreamConfig, carLengthM = 5.6): { tow: number[]; dirtyAir: number[] } {
  const t = cfg.tow, d = cfg.dirtyAir;
  const tow = cars.map(() => 0), dirtyAir = cars.map(() => 0);
  if (trailOn(cfg)) {
    cars.forEach((me, i) => {
      let wake = 0;
      cars.forEach((lead, j) => { if (i !== j) wake = Math.max(wake, trailWake(me, lead, carLengthM, carWidthM, cfg.trail)); });
      tow[i] = t.maxDragReduction * wake;
      dirtyAir[i] = d.maxDownforceLoss * wake;
    });
    return { tow, dirtyAir };
  }
  const maxAngle = (t.maxAngleDeg * Math.PI) / 180;
  cars.forEach((me, i) => {
    const cornering = d.cornerG === undefined || Math.abs(Math.hypot(me.vx, me.vy) * (me.angVel ?? 0)) > d.cornerG * 9.81;
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
