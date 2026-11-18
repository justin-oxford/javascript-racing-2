// Multiplayer wire protocol (card 07): message shapes shared by the server and the browser client.
// Plain data and pure helpers only (no Node, no DOM): the client imports this file too.
import type { CarInput, CarState, RaceState, SimEvent, WorldState } from '../sim';

/** Server sim rate is the sim's own TICK_HZ (60). Snapshots go out every SNAP_EVERY ticks (60 / 3 = 20 Hz). */
export const SNAP_EVERY = 3;
/** Default dev port for the server (ws://localhost:2567). */
export const DEFAULT_PORT = 2567;
/** Colyseus room name. */
export const ROOM_NAME = 'race';
/** Most cars in a room (Indiana's grid has 10 boxes). */
export const MAX_CARS = 10;
/** A dropped player's car is driven by AI this long; rejoining in the window takes it back. */
export const DROP_GRACE_SEC = 30;

/** What the host sets in the lobby. */
export interface RoomSettings {
  track: string;
  laps: number;
  spec: string;
  aiCount: number;
  aiPreset: string;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  team: string;
  /** Car index in the running race (-1 = not in it). */
  car: number;
  connected: boolean;
}

export type RoomPhase = 'lobby' | 'race';

/** server -> client 'lobby': the whole room, sent whenever it changes. */
export interface LobbyMsg {
  code: string;
  hostId: string;
  you: string;
  phase: RoomPhase;
  /** The host pressed Start and the race is being built (a new track/spec can take a few seconds). */
  starting?: boolean;
  settings: RoomSettings;
  players: LobbyPlayer[];
  /** Tracks a host can pick, and the specs / AI levels / teams this server knows. */
  tracks: Array<{ id: string; name: string }>;
  specs: string[];
  presets: string[];
  teams: Array<{ id: string; name: string }>;
}

/** Who drives a car, for labels and the running order. */
export interface CarDriver {
  code: string;
  name: string;
  /** Session id of the player driving it; absent = AI. */
  player?: string;
}

/** server -> client 'start': the race's first world (cars on the grid), and who's who. */
export interface StartMsg {
  /** Bumps on every race, so a stale snapshot from the last race is ignored. */
  raceId: number;
  track: string;
  world: WorldState;
  drivers: CarDriver[];
  /** Your car index (-1: spectating). */
  you: number;
}

/** client -> server 'input', every client tick. */
export interface InputMsg extends CarInput {
  seq: number;
}

/**
 * One car in a snapshot, flattened and quantised (msgpack sends small integers in 1-5 bytes):
 * x, y (cm), heading (mrad), vx, vy (cm/s), angVel (mrad/s), steerAngle (mrad), speed (cm/s),
 * throttle, brake (0..1000), flags, then per wheel: surface, usage (x1000), slipDeg (x100), loadN, wear (x10000),
 * then steer (x1000: the driver's ramped steer, so a client can carry the car on in its prediction).
 */
export type CarKin = number[];

const F_WALL = 1, F_BARRIER = 2, F_CAR = 4, F_PIT = 8, F_OFF = 16, F_GHOST = 32, F_BOX = 64;

export function encodeCar(c: CarState): CarKin {
  const r = Math.round;
  const flags = (c.wallContact ? F_WALL : 0) | (c.barrierContact ? F_BARRIER : 0) | (c.carContact ? F_CAR : 0) | (c.inPitLane ? F_PIT : 0) | (c.offTrack ? F_OFF : 0) | (c.rejoin.ghost ? F_GHOST : 0) | (c.inPitBox ? F_BOX : 0);
  const out = [r(c.x * 100), r(c.y * 100), r(c.heading * 1000), r(c.vx * 100), r(c.vy * 100), r(c.angVel * 1000), r(c.steerAngle * 1000), r(c.speed * 100), r(c.controls.throttle * 1000), r(c.controls.brake * 1000), flags];
  for (const w of c.wheels) out.push(w.surface, r(w.usage * 1000), r(w.slipDeg * 100), r(w.loadN), r(w.wear * 10000));
  out.push(r(c.controls.steer * 1000));
  return out;
}

/** A car from a snapshot on top of the last full state we have for it (`base`: build, timing, ...). */
export function decodeCar(k: CarKin, base: CarState): CarState {
  const g = (i: number) => k[i] ?? 0;
  const flags = g(10);
  const wheels = base.wheels.map((w, j) => {
    const o = 11 + j * 5;
    return { ...w, surface: g(o), usage: g(o + 1) / 1000, slipDeg: g(o + 2) / 100, loadN: g(o + 3), wear: g(o + 4) / 10000 };
  }) as CarState['wheels'];
  return {
    ...base,
    x: g(0) / 100, y: g(1) / 100, heading: g(2) / 1000,
    vx: g(3) / 100, vy: g(4) / 100, angVel: g(5) / 1000,
    steerAngle: g(6) / 1000, speed: g(7) / 100,
    controls: { ...base.controls, throttle: g(8) / 1000, brake: g(9) / 1000, steer: g(31) / 1000 },
    wallContact: !!(flags & F_WALL), barrierContact: !!(flags & F_BARRIER), carContact: !!(flags & F_CAR),
    inPitLane: !!(flags & F_PIT), offTrack: !!(flags & F_OFF), inPitBox: !!(flags & F_BOX),
    rejoin: { ...base.rejoin, ghost: !!(flags & F_GHOST) },
    wheels,
  };
}

/** A car's full state without its wake trail (the trail is rebuilt every tick and only feeds other cars' wake). */
export function fullCar(c: CarState): CarState {
  const { trail: _trail, ...rest } = c;
  return rest;
}

/** server -> client 'snap', SNAP_EVERY ticks. Tailored per client (its own car in full, its own ack). */
export interface SnapMsg {
  raceId: number;
  /** Server world tick this snapshot is the state after. */
  tick: number;
  /** Last input seq the server applied for this client (-1 = none yet). */
  ack: number;
  cars: CarKin[];
  /** The receiving client's own car in full (HUD now, prediction later). */
  me?: CarState;
  race?: RaceState;
  /** Sim events since the previous snapshot (laps, sectors), in tick order. */
  events: Array<SimEvent & { tick: number }>;
}

/** The world as the server ran it at a snapshot, rebuilt from the last full cars (`base`) and the snapshot. */
export function worldFromSnap(s: SnapMsg, base: readonly CarState[], you: number): WorldState {
  const cars = s.cars.map((k, i) => (i === you && s.me ? s.me : decodeCar(k, base[i]!)));
  return { tick: s.tick, cars, events: s.events, ...(s.race ? { race: s.race } : {}) };
}
