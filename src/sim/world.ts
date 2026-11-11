import type { CarInput, CarState, PlaceholderKinematics, Pose, TrackData, WorldState } from './types';
import { NEUTRAL_INPUT } from './types';

/** Fixed simulation rate. Physics is never stepped by frame time. */
export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;

export function createCar(pose: Pose): CarState {
  return { x: pose.x, y: pose.y, heading: pose.heading, speed: 0 };
}

export function createWorld(track: TrackData, carCount = 1): WorldState {
  const cars: CarState[] = [];
  for (let i = 0; i < carCount; i++) cars.push(createCar(track.spawn));
  return { tick: 0, cars };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * PLACEHOLDER kinematic car step. Exists only to prove the loop in card 01;
 * card 03 replaces it with real physics. Deliberately crude.
 */
function stepCarPlaceholder(car: CarState, input: CarInput, k: PlaceholderKinematics, dt: number): CarState {
  const throttle = clamp(input.throttle, 0, 1);
  const brake = clamp(input.brake, 0, 1);
  const steer = clamp(input.steer, -1, 1);

  let speed = car.speed;
  if (throttle > 0) {
    speed += k.accel * throttle * dt;
  }
  if (brake > 0) {
    // Brake slows forward motion, then reverses once stopped.
    speed -= (speed > 0 ? k.brakeDecel : k.accel) * brake * dt;
  }
  if (throttle === 0 && brake === 0) {
    const coast = k.coastDecel * dt;
    speed = Math.abs(speed) <= coast ? 0 : speed - Math.sign(speed) * coast;
  }
  speed = clamp(speed, -k.maxReverseSpeed, k.maxSpeed);

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
export function step(world: WorldState, inputs: readonly CarInput[], kinematics: PlaceholderKinematics): WorldState {
  return {
    tick: world.tick + 1,
    cars: world.cars.map((car, i) => stepCarPlaceholder(car, inputs[i] ?? NEUTRAL_INPUT, kinematics, TICK_DT)),
  };
}

/** Put a car back at a pose, stationary (R = reset to pits). */
export function resetCar(world: WorldState, index: number, pose: Pose): WorldState {
  return {
    tick: world.tick,
    cars: world.cars.map((car, i) => (i === index ? createCar(pose) : car)),
  };
}
