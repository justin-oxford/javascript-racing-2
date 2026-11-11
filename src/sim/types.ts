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

export interface CarState extends Pose {
  /** Signed speed along the heading, track units per second. */
  speed: number;
}

export interface WorldState {
  tick: number;
  cars: CarState[];
}

/** The subset of a track file the sim needs. Format owned by card 02. */
export interface TrackData {
  id: string;
  name: string;
  width: number;
  height: number;
  spawn: Pose;
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

export const NEUTRAL_INPUT: Readonly<CarInput> = Object.freeze({ throttle: 0, brake: 0, steer: 0 });
