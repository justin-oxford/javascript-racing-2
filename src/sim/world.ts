import type { SimTrack } from './track';
import { surfaceAt } from './track';
import type {
  CarGeometry,
  CarInput,
  CarState,
  PlaceholderKinematics,
  Pose,
  Rules,
  SimEvent,
  Wheels,
  WorldState,
} from './types';
import { NEUTRAL_INPUT } from './types';

/** Fixed simulation rate. Physics is never stepped by frame time. */
export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;

/** Static inputs to every step: the track and tuning. Not world state. */
export interface SimContext {
  track: SimTrack;
  kinematics: PlaceholderKinematics;
  carGeometry: CarGeometry;
  rules: Rules;
}

/** Wheel sample points (FL, FR, RL, RR) for a pose, in track pixels. */
export function wheelPositions(pose: Pose, geometry: CarGeometry, pxPerMeter: number): Wheels<{ x: number; y: number }> {
  const fx = Math.sin(pose.heading), fy = -Math.cos(pose.heading); // forward
  const rx = Math.cos(pose.heading), ry = Math.sin(pose.heading); // right
  const hl = (geometry.wheelbaseM / 2) * pxPerMeter;
  const hw = (geometry.trackWidthM / 2) * pxPerMeter;
  const at = (l: number, s: number) => ({ x: pose.x + fx * l + rx * s, y: pose.y + fy * l + ry * s });
  return [at(hl, -hw), at(hl, hw), at(-hl, -hw), at(-hl, hw)];
}

function sampleSurfaces(pose: Pose, ctx: SimContext): Pick<CarState, 'surfaces' | 'offTrack' | 'inPitLane' | 'inPitBox'> {
  const { track } = ctx;
  const surfaces = wheelPositions(pose, ctx.carGeometry, track.json.pxPerMeter).map((p) => surfaceAt(track, p.x, p.y)) as Wheels<number>;
  const { pitLane, pitBox } = track.index;
  return {
    surfaces,
    offTrack: surfaces.every((s) => !track.surfaces[s]!.legal),
    inPitLane: surfaces.some((s) => s === pitLane || s === pitBox),
    inPitBox: surfaces.some((s) => s === pitBox),
  };
}

export function createCar(pose: Pose, ctx: SimContext): CarState {
  return { x: pose.x, y: pose.y, heading: pose.heading, speed: 0, ...sampleSurfaces(pose, ctx) };
}

export function createWorld(ctx: SimContext, carCount = 1): WorldState {
  const cars: CarState[] = [];
  for (let i = 0; i < carCount; i++) cars.push(createCar(ctx.track.json.spawn, ctx));
  return { tick: 0, cars, events: [] };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * PLACEHOLDER kinematic car step. Exists only to prove the loop and the mask;
 * card 03 replaces it with real physics. Deliberately crude: no walls, no grip.
 */
function stepCarPlaceholder(car: CarState, input: CarInput, ctx: SimContext, dt: number): Pose & { speed: number } {
  const k = ctx.kinematics;
  const throttle = clamp(input.throttle, 0, 1);
  const brake = clamp(input.brake, 0, 1);
  const steer = clamp(input.steer, -1, 1);

  let speed = car.speed;
  if (throttle > 0) speed += k.accel * throttle * dt;
  if (brake > 0) speed -= (speed > 0 ? k.brakeDecel : k.accel) * brake * dt; // brake, then reverse
  if (throttle === 0 && brake === 0) {
    const coast = k.coastDecel * dt;
    speed = Math.abs(speed) <= coast ? 0 : speed - Math.sign(speed) * coast;
  }
  let maxSpeed = k.maxSpeed;
  if (car.inPitLane) maxSpeed = Math.min(maxSpeed, (ctx.rules.pitSpeedLimitKph / 3.6) * ctx.track.json.pxPerMeter);
  speed = clamp(speed, -k.maxReverseSpeed, maxSpeed);

  const steerAuthority = clamp(Math.abs(speed) / k.fullSteerSpeed, 0, 1);
  const heading = car.heading + steer * k.turnRate * steerAuthority * Math.sign(speed) * dt;
  return {
    x: car.x + Math.sin(heading) * speed * dt,
    y: car.y - Math.cos(heading) * speed * dt,
    heading,
    speed,
  };
}

/**
 * Advance the world by exactly one fixed tick. Pure: returns a new state, never mutates.
 * inputs[i] drives cars[i]; a missing input is treated as neutral.
 */
export function step(world: WorldState, inputs: readonly CarInput[], ctx: SimContext): WorldState {
  const events: SimEvent[] = [];
  const cars = world.cars.map((car, i) => {
    const moved = stepCarPlaceholder(car, inputs[i] ?? NEUTRAL_INPUT, ctx, TICK_DT);
    const next: CarState = { ...moved, ...sampleSurfaces(moved, ctx) };
    // Out of bounds should be unreachable behind walls. If a wheel gets there, the mask has a gap.
    if (next.surfaces.includes(ctx.track.index.outOfBounds)) {
      events.push({ type: 'outOfBounds', car: i, x: next.x, y: next.y });
      return createCar(ctx.track.json.spawn, ctx);
    }
    return next;
  });
  return { tick: world.tick + 1, cars, events };
}

/** Put a car back at a pose, stationary (R = reset to pits). */
export function resetCar(world: WorldState, index: number, pose: Pose, ctx: SimContext): WorldState {
  return {
    tick: world.tick,
    cars: world.cars.map((car, i) => (i === index ? createCar(pose, ctx) : car)),
    events: world.events,
  };
}
