// All sim state is plain, JSON-serializable data. No classes, no hidden state.

/** What every driver (keyboard, AI, network) produces each tick. */
export interface CarInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1 (left) .. 1 (right) */
  steer: number;
}

/**
 * Anything that can drive a car. The sim never knows which kind it is.
 * Called once per sim tick.
 */
export interface InputSource {
  read(tick: number): CarInput;
}

/** A position + heading on the track. Heading 0 points up (-y), increases clockwise. */
export interface Pose {
  x: number;
  y: number;
  heading: number;
}

/** Wheel order everywhere: front-left, front-right, rear-left, rear-right. */
export type Wheels<T> = [T, T, T, T];

export interface CarState extends Pose {
  /** Signed speed along the heading, track pixels per second. */
  speed: number;
  /** Palette index of the surface under each wheel this tick. */
  surfaces: Wheels<number>;
  /** All four wheels off legal surface (track limits). */
  offTrack: boolean;
  /** Any wheel on pit lane or pit box: speed limiter applies. */
  inPitLane: boolean;
  /** Any wheel on the pit box: service + setup menu (card 04). */
  inPitBox: boolean;
}

/** Things that happened this tick, for the client to react to (log, sound, HUD). */
export type SimEvent = { type: 'outOfBounds'; car: number; x: number; y: number };

export interface WorldState {
  tick: number;
  cars: CarState[];
  /** Events from the most recent tick only. */
  events: SimEvent[];
}

/**
 * Throwaway kinematic tuning (card 01 only; replaced by real physics in card 03).
 * Units: track pixels and seconds.
 */
export interface PlaceholderKinematics {
  maxSpeed: number;
  maxReverseSpeed: number;
  accel: number;
  brakeDecel: number;
  coastDecel: number;
  /** rad/s at full lock once above fullSteerSpeed */
  turnRate: number;
  fullSteerSpeed: number;
}

export interface CarGeometry {
  wheelbaseM: number;
  trackWidthM: number;
}

export interface Rules {
  pitSpeedLimitKph: number;
}

export const NEUTRAL_INPUT: Readonly<CarInput> = Object.freeze({ throttle: 0, brake: 0, steer: 0 });
