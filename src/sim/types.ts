import type { SurfaceGrid } from './evolution';
import type { EngineMode, ErsState } from './ers';
import type { DamageMode, DamageState } from './damage';
import type { RejoinState } from './rejoin';
// All sim state is plain, JSON-serializable data. No classes, no hidden state.
import type { QualiState } from './quali';
import type { RaceState } from './race';
import type { LapTiming, TimingEvent } from './timing';
// Units: metres, seconds, radians, kg, newtons. Track pixels exist only at the track boundary
// (mask sampling, track.json) and in the client renderer.

/** What every driver (keyboard, AI, network) produces each tick. */
export interface CarInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1 (left) .. 1 (right) */
  steer: number;
  /** Reset to track (POLISH card): held ~1 s puts the car back on the racing line. Absent = not pressed. */
  reset?: boolean | undefined;
  /** Engine mode the driver wants (absent = keep the current one). */
  engineMode?: EngineMode | undefined;
  /** Battery deploy held (push-to-pass). */
  deploy?: boolean | undefined;
}

/**
 * Anything that can drive a car. The sim never knows which kind it is.
 * Called once per sim tick.
 */
export interface InputSource {
  read(tick: number): CarInput;
}

/** A position + heading. Heading 0 points up (-y), increases clockwise. */
export interface Pose {
  x: number;
  y: number;
  heading: number;
}

/** Wheel order everywhere: front-left, front-right, rear-left, rear-right. */
export type Wheels<T> = [T, T, T, T];

/**
 * Car setup (Car setup overhaul card): seven notched sliders, -range..+range (specs.json setup.range),
 * 0 = neutral. What each notch does is in specs.json setup; every one trades something.
 */
export interface CarSetup {
  frontWing: number;
  rearWing: number;
  /** + = longer (top speed), - = shorter (acceleration). */
  gearing: number;
  /** + = more front brake bias. */
  brakeBias: number;
  /** Suspension balance: + = stiffer front (understeer), - = stiffer rear (oversteer). */
  balance: number;
  /** + = higher (less downforce, kerbs and grass hurt less). */
  rideHeight: number;
  /** + = higher pressure (less grip and wear, sharper). */
  tyrePressure: number;
}

/** Which car this is: team x spec x setup (SYS - Car model). */
export interface CarBuild {
  team: string;
  spec: string;
  setup: CarSetup;
  /**
   * Equal performance mode (a session setting from the race setup, carried on each car so whoever builds
   * the cars builds the same ones): 0 / absent = team stats, 1 = every team's multipliers at 1.0.
   * Spec and setup still apply on top.
   */
  equalise?: number;
}

export interface WheelState {
  /** Palette index of the surface under the wheel. */
  surface: number;
  /** Tyre life, 1 = new, 0 = gone. Grip follows log10(10 x wear). */
  wear: number;
  // ---- telemetry from the last tick (derived, but plain data so the HUD/panel can read it) ----
  /** Slip angle, degrees. */
  slipDeg: number;
  /** Force asked of the tyre / force it can give. Over 1 = sliding. */
  usage: number;
  /** Grip cap this tick, newtons. */
  gripN: number;
  /** Vertical load, newtons. */
  loadN: number;
}

export interface CarState extends Pose {
  build: CarBuild;
  /** World-frame velocity, m/s. */
  vx: number;
  vy: number;
  /** rad/s, clockwise positive (same sense as heading). */
  angVel: number;
  /** Signed speed along the heading, m/s (derived from vx/vy). */
  speed: number;
  /** Inputs after ramping toward the driver's request. */
  controls: CarInput;
  /** Front wheel angle used this tick, radians (+ = right). Telemetry, for drawing the wheels. */
  steerAngle: number;
  fuelKg: number;
  wheels: Wheels<WheelState>;
  /** All four wheels off legal surface (track limits). */
  offTrack: boolean;
  /** Any wheel on pit lane or pit box: speed limiter applies. */
  inPitLane: boolean;
  /** Any wheel on the pit box: service (tyres, fuel) when stopped. */
  inPitBox: boolean;
  /** Which pit box (0-based, see SimTrack.boxes) a wheel is in, -1 if none. */
  pitBox: number;
  /** Being serviced this tick: stopped in a box it may use (any box in practice, its own in a race). */
  servicing: boolean;
  /** Touching a wall this tick. */
  wallContact: boolean;
  /** Touching a tyre barrier this tick (invalidates the lap, card 04). */
  barrierContact: boolean;
  /** Touching another car this tick. */
  carContact: boolean;
  /** Slipstream this tick: fraction of aero drag removed (0 = none). Telemetry + HUD. */
  tow: number;
  /** Dirty air this tick: fraction of downforce lost following closely through a corner. */
  dirtyAir: number;
  /** Lap/sector timing (see timing.ts). */
  timing: LapTiming;
  /** Reset to track: last on-track point, hold, cooldown, penalty, ghost (rejoin.ts). */
  rejoin: RejoinState;
  /** Damage by zone (damage.ts); stays zero with the Damage setting off. */
  damage: DamageState;
  /** Engine mode and battery (ers.ts). */
  ers: ErsState;
}

/** Things that happened this tick, for the client to react to (log, sound, HUD). */
export type SimEvent = { type: 'outOfBounds'; car: number; x: number; y: number } | TimingEvent;

export interface WorldState {
  tick: number;
  cars: CarState[];
  /** Events from the most recent tick only. */
  events: SimEvent[];
  /** Race mode (card 06). Absent in practice. */
  race?: RaceState;
  /** Qualifying (race weekend). Absent otherwise; never together with race. */
  quali?: QualiState;
  /** Track evolution: rubber and marbles (evolution.ts). Absent = evolution off. */
  surface?: SurfaceGrid;
  /** Session settings the sim needs every tick (set from the race setup; absent = defaults). */
  settings?: SessionSettings;
}

/** Session settings carried on the world (host-set in multiplayer). */
export interface SessionSettings {
  /** Car damage: off (default), visual only, or realistic. */
  damage?: DamageMode;
}

export interface Rules {
  pitSpeedLimitKph: number;
}

/** config/contact.json: car-to-car contact, and the car body's own material against walls. */
export interface ContactConfig {
  /** Car against car. */
  carFriction: number;
  carRestitution: number;
  /** Car body against walls: mixed with the wall's own friction/restitution (physics.json walls). */
  bodyFriction: number;
  bodyRestitution: number;
  /** Cars both in the pit lane don't collide (absent = true). */
  pitLaneGhosting?: boolean;
}

export const NEUTRAL_INPUT: Readonly<CarInput> = Object.freeze({ throttle: 0, brake: 0, steer: 0 });
