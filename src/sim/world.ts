import { evolutionGrip, newSurfaceGrid, updateSurface, type EvolutionConfig, type SurfaceGrid, type WheelWork } from './evolution';
import { deployPowerW, newErs, updateErs, type EngineMode, type ErsConfig } from './ers';
import { applyHits, damageDrag, damageGrip, damagePull, isDamaged, NO_DAMAGE, repairStep, type DamageConfig } from './damage';
import { applyResets, newRejoin, trackRejoin } from './rejoin';
import { bodyOffsetM, buildStats, type CarCatalog, type PhysicsConfig } from './car-config';
import { applyCarForce, prepareCache, readStateFromWorld, setCarMass, stepWorld, type PhysicsCache } from './planck-cache';
import type { SimTrack, WallChain } from './track';
import { boxAt, surfaceAt } from './track';
import { newQualiState, qualiHolds, retireQualiCar, updateQuali } from './quali';
import { gridOrder, newRaceState, raceHolds, updateRace, type RaceConfig } from './race';
import { wakeEffects, type SlipstreamConfig } from './slipstream';
import { newTiming, updateTiming, type TimingEvent } from './timing';
import type { CarBuild, CarInput, CarState, ContactConfig, Pose, Rules, SessionSettings, SimEvent, WheelState, Wheels, WorldState } from './types';
import { NEUTRAL_INPUT } from './types';

/** Fixed simulation rate. Physics is never stepped by frame time. */
export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;
const G = 9.81;
const KPH = 1 / 3.6;

/**
 * Everything static (or live-tuned) that a step needs. Not world state.
 * `cache` is Planck, kept in step with WorldState; see planck-cache.ts.
 */
export interface SimContext {
  track: SimTrack;
  walls: readonly WallChain[];
  physics: PhysicsConfig;
  catalog: CarCatalog;
  rules: Rules;
  /** config/contact.json: car-to-car contact material (live-tunable). */
  contact: ContactConfig;
  /** config/race.json: start lights, finish timeout. */
  race: RaceConfig;
  /** config/slipstream.json: tow + dirty air (live-tunable). */
  slipstream: SlipstreamConfig;
  /** config/assists.json: ABS (live-tunable). */
  assists: AssistsConfig;
  /** config/damage.json: car damage, used when the session's Damage setting is on (live-tunable). */
  damage: DamageConfig;
  /** config/ers.json: engine modes and battery deploy (live-tunable). */
  ers: ErsConfig;
  /** config/evolution.json: rubbering in and marbles (live-tunable). */
  evolution: EvolutionConfig;
  cache: PhysicsCache;
}

/** config/assists.json. */
export interface AssistsConfig {
  /** Anti-lock brakes: brake force held to peakPct of the tyre's grip, allowing for cornerShare of its cornering load. */
  abs: { enabled: boolean; peakPct: number; cornerShare: number };
}

// ---------------------------------------------------------------------------
// Geometry

const forward = (h: number) => ({ x: Math.sin(h), y: -Math.cos(h) });
const right = (h: number) => ({ x: Math.cos(h), y: Math.sin(h) });

/** Wheel offsets from the centre of mass: [along forward, along right], metres. FL, FR, RL, RR. */
function wheelOffsets(cfg: PhysicsConfig): Wheels<[number, number]> {
  const { wheelbaseM: L, trackWidthM: T, weightFront: wf } = cfg.car;
  const a = L * (1 - wf); // CG to front axle: more weight on the front = CG nearer the front
  const b = L * wf;
  return [[a, -T / 2], [a, T / 2], [-b, -T / 2], [-b, T / 2]];
}

/** Wheel positions (FL, FR, RL, RR) for a pose, metres. */
export function wheelPositions(pose: Pose, cfg: PhysicsConfig): Wheels<{ x: number; y: number }> {
  const f = forward(pose.heading), r = right(pose.heading);
  return wheelOffsets(cfg).map(([l, s]) => ({ x: pose.x + f.x * l + r.x * s, y: pose.y + f.y * l + r.y * s })) as Wheels<{ x: number; y: number }>;
}

/**
 * Most the front wheels may turn toward `dir` (+1 right, -1 left), radians, for this car's motion now.
 * Mechanical lock shrinks with speed. STEERING ASSIST (card 03b): at speed, full lock = the wheels
 * pointed at peak slip relative to where the front axle is actually travelling, so a keyboard's
 * all-or-nothing steer can't scrub the fronts far past their peak. Full mechanical lock at low speed,
 * blending to the assist between assistFromKph and assistFullKph.
 */
export function steerLimit(car: Pick<CarState, 'x' | 'y' | 'heading' | 'vx' | 'vy' | 'angVel'>, dir: number, cfg: PhysicsConfig): number {
  const st = cfg.steering;
  const speed = Math.hypot(car.vx, car.vy);
  const mech = ((st.lockDeg * Math.PI) / 180) / (1 + speed / KPH / st.lockFalloffKph);
  const blend = st.assist ? clamp((speed / KPH - st.assistFromKph) / Math.max(1, st.assistFullKph - st.assistFromKph), 0, 1) : 0;
  if (blend <= 0) return mech;
  // Front axle velocity in the car's frame: v + omega x r at the axle (r = a forward of the CG).
  const f = forward(car.heading), r = right(car.heading);
  const a = cfg.car.wheelbaseM * (1 - cfg.car.weightFront);
  const vx = car.vx - car.angVel * f.y * a, vy = car.vy + car.angVel * f.x * a;
  const vLong = vx * f.x + vy * f.y, vLat = vx * r.x + vy * r.y;
  const travel = Math.atan2(vLat, Math.max(Math.abs(vLong), cfg.tyres.lowSpeedMps)); // + = axle moving right
  const peak = ((cfg.tyres.peakSlipDeg * Math.PI) / 180) * st.assistPeakPct;
  const assisted = Math.min(mech, Math.max(peak * 0.5, dir * travel + peak));
  return mech + (assisted - mech) * blend;
}

/** Front wheel angle, radians (+ = right), for a steer input (-1..1) given the car's motion now. */
export function frontWheelAngle(steer: number, car: Pick<CarState, 'x' | 'y' | 'heading' | 'vx' | 'vy' | 'angVel'>, cfg: PhysicsConfig): number {
  return steer * steerLimit(car, steer >= 0 ? 1 : -1, cfg);
}

/**
 * Force available vs combined slip (fraction of peak), as a fraction of peak grip: 2s - s^2 up to the
 * peak (s = 1), then a smooth fall toward `falloff`, nearly there by `falloffSlip` x peak slip.
 */
export function tyreCurve(s: number, falloff: number, falloffSlip: number): number {
  if (s <= 1) return s * (2 - s);
  const k = 3 / Math.max(0.01, (falloffSlip - 1) ** 2);
  return falloff + (1 - falloff) * Math.exp(-k * (s - 1) ** 2);
}

/** Tyre grip vs wear: gentle down to ~40%, then a cliff, nothing left at 10% (v0.16 curve). */
export function wearGrip(wear: number): number {
  return Math.max(0, Math.log10(10 * wear));
}

/** Wear where that curve reaches zero grip: log10(10 x 0.1) = 0. Below it the tyre is done. */
const WEAR_NO_GRIP = 0.1;
/** Tyre life as the player sees it: 100% new, 0% = no grip left (raw wear 10%), not raw wear 0. */
export function tyreLife(wear: number): number {
  return Math.max(0, Math.min(1, (wear - WEAR_NO_GRIP) / (1 - WEAR_NO_GRIP)));
}

// ---------------------------------------------------------------------------
// Cars

const newWheel = (surface: number): WheelState => ({ surface, wear: 1, slipDeg: 0, usage: 0, gripN: 0, loadN: 0 });

function sampleSurfaces(car: Pick<CarState, 'x' | 'y' | 'heading'>, ctx: SimContext): Wheels<number> {
  const ppm = ctx.track.json.pxPerMeter;
  return wheelPositions(car, ctx.physics).map((p) => surfaceAt(ctx.track, p.x * ppm, p.y * ppm)) as Wheels<number>;
}

function surfaceFlags(surfaces: Wheels<number>, ctx: SimContext): Pick<CarState, 'offTrack' | 'inPitLane' | 'inPitBox'> {
  const { pitLane, pitBox } = ctx.track.index;
  return {
    offTrack: surfaces.every((s) => !ctx.track.surfaces[s]!.legal),
    inPitLane: surfaces.some((s) => s === pitLane || s === pitBox),
    inPitBox: surfaces.some((s) => s === pitBox),
  };
}

/** Which pit box a wheel is in (0-based), -1 if none. */
function pitBoxUnder(car: Pick<CarState, 'x' | 'y' | 'heading'>, ctx: SimContext): number {
  if (!ctx.track.boxes.length) return -1;
  const ppm = ctx.track.json.pxPerMeter;
  for (const p of wheelPositions(car, ctx.physics)) {
    const b = boxAt(ctx.track, p.x * ppm, p.y * ppm);
    if (b >= 0) return b;
  }
  return -1;
}

/** A stationary car at a pose given in TRACK PIXELS (track.json coordinates). */
export function createCar(posePx: Pose, build: CarBuild, ctx: SimContext): CarState {
  const ppm = ctx.track.json.pxPerMeter;
  const pose = { x: posePx.x / ppm, y: posePx.y / ppm, heading: posePx.heading };
  const surfaces = sampleSurfaces(pose, ctx);
  return {
    ...pose,
    build,
    vx: 0,
    vy: 0,
    angVel: 0,
    speed: 0,
    controls: { ...NEUTRAL_INPUT },
    steerAngle: 0,
    fuelKg: ctx.physics.fuel.startKg,
    wheels: surfaces.map(newWheel) as Wheels<WheelState>,
    ...surfaceFlags(surfaces, ctx),
    pitBox: pitBoxUnder(pose, ctx),
    servicing: false,
    wallContact: false,
    barrierContact: false,
    carContact: false,
    tow: 0,
    dirtyAir: 0,
    timing: newTiming(),
    rejoin: newRejoin(),
    damage: { ...NO_DAMAGE },
    ers: newErs(ctx.ers),
  };
}

/**
 * Starting pose for car i: grid slot i if the track has one, else a staggered two-wide grid behind the
 * spawn (one row every 8 m, the second column 4 m to the side and 4 m back, on whichever side is legal
 * surface). Nose-to-tail single file piled up at the first corner.
 */
export function startPose(i: number, ctx: SimContext): Pose {
  const { grid, spawn, pxPerMeter: ppm } = ctx.track.json;
  if (i === 0) return spawn;
  const slot = grid[i];
  if (slot) return slot;
  const f = forward(spawn.heading), r = right(spawn.heading);
  const legal = (x: number, y: number) => ctx.track.surfaces[surfaceAt(ctx.track, x, y)]?.legal ?? false;
  const clear = (x: number, y: number) => [-1.5, 0, 1.5].every((o) => legal(x + r.x * o * ppm, y + r.y * o * ppm));
  const back = (Math.floor(i / 2) * 8 + (i % 2) * 4) * ppm;
  const bx = spawn.x - f.x * back, by = spawn.y - f.y * back;
  if (i % 2)
    for (const side of [1, -1]) {
      const x = bx + r.x * side * 4 * ppm, y = by + r.y * side * 4 * ppm;
      if (clear(x, y)) return { x, y, heading: spawn.heading };
    }
  return { x: bx, y: by, heading: spawn.heading };
}

export function createWorld(ctx: SimContext, cars: number | readonly CarBuild[] = 1, settings?: SessionSettings): WorldState {
  const builds = typeof cars === 'number' ? Array.from({ length: cars }, () => ctx.physics.defaultCar) : cars;
  return { tick: 0, cars: builds.map((b, i) => createCar(startPose(i, ctx), b, ctx)), events: [], ...(settings ? { settings } : {}), ...greenTrack(ctx) };
}

/** A new session's surface: green (track evolution on), or none. Carry one over with nextSession(). */
const greenTrack = (ctx: SimContext): { surface?: SurfaceGrid } => (ctx.evolution.enabled ? { surface: newSurfaceGrid(ctx.track, ctx.evolution) } : {});

export interface RaceSetup {
  laps: number;
  /** Seeds the grid shuffle and the start-light hold. */
  seed: number;
  /** Put the player (car 0) in this grid slot; otherwise the grid is shuffled. */
  playerSlot?: number | undefined;
  /** The grid itself (order[slot] = car index), e.g. from qualifying. Overrides the shuffle. */
  grid?: readonly number[] | undefined;
  /** Session settings (damage); absent = defaults. */
  settings?: SessionSettings | undefined;
}

/**
 * A race (card 06): cars on the grid (slot order = shuffled, or the player's choice), held still until
 * lights out, each assigned its own pit box. Car indices stay as given (car 0 = the player).
 */
export function createRaceWorld(ctx: SimContext, builds: readonly CarBuild[], setup: RaceSetup): WorldState {
  const order = setup.grid && setup.grid.length === builds.length ? [...setup.grid] : gridOrder(builds.length, setup.seed, setup.playerSlot);
  const slotOf = new Map(order.map((car, slot) => [car, slot]));
  const cars = builds.map((b, i) => createCar(startPose(slotOf.get(i)!, ctx), b, ctx));
  return { tick: 0, cars, events: [], race: newRaceState(order, setup.laps, setup.seed, ctx.track, ctx.race, TICK_HZ), ...(setup.settings ? { settings: setup.settings } : {}), ...greenTrack(ctx) };
}

/**
 * Qualifying (race weekend): everyone queued at the pit exit (`queuePx[k]` = k-th in the queue, track
 * pixels, from pitQueuePoses), released from the front: the player first and at once, then the others one
 * by one in a seeded order. See quali.ts.
 */
export function createQualiWorld(ctx: SimContext, builds: readonly CarBuild[], seed: number, queuePx: readonly Pose[], settings?: SessionSettings): WorldState {
  const quali = newQualiState(builds.length, seed, ctx.race, TICK_HZ);
  const rank = quali.cars.map((_, i) => i).sort((a, b) => quali.cars[a]!.releaseTick - quali.cars[b]!.releaseTick || a - b);
  const place = new Map(rank.map((car, k) => [car, k]));
  // Qualifying runs light: everyone starts with race.json qualiFuelKg (a pit stop tops back up to it).
  const fuelKg = qualiFuelKg(ctx);
  const cars = builds.map((b, i) => ({ ...createCar(queuePx[place.get(i)!] ?? startPose(i, ctx), b, ctx), fuelKg }));
  return { tick: 0, cars, events: [], quali, ...(settings ? { settings } : {}), ...greenTrack(ctx) };
}

/** Qualifying fuel load, kg (race.json qualiFuelKg, at most a full tank). */
export function qualiFuelKg(ctx: SimContext): number {
  return Math.min(ctx.physics.fuel.tankKg, ctx.race.qualiFuelKg ?? ctx.physics.fuel.startKg);
}

/** End car i's qualifying session: parked at `posePx` (its box) and held; its best lap stands. */
export function retireFromQuali(world: WorldState, i: number, posePx: Pose, ctx: SimContext): WorldState {
  if (!world.quali) return world;
  return { ...resetCar(world, i, posePx, ctx), quali: retireQualiCar(world.quali, i) };
}

/** Put a car back at a pose (track pixels), stationary, same build (R = reset to pits). */
export function resetCar(world: WorldState, index: number, posePx: Pose, ctx: SimContext): WorldState {
  return {
    ...world,
    cars: world.cars.map((car, i) => (i === index ? createCar(posePx, car.build, ctx) : car)),
  };
}

/** Swap a car's team/spec/setup (tuning panel; later the garage). Keeps its position and motion. */
export function setCarBuild(world: WorldState, index: number, build: CarBuild): WorldState {
  return { ...world, cars: world.cars.map((car, i) => (i === index ? { ...car, build } : car)) };
}

// ---------------------------------------------------------------------------
// Step

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const approach = (cur: number, target: number, maxDelta: number): number =>
  cur < target ? Math.min(target, cur + maxDelta) : Math.max(target, cur - maxDelta);

function rampControls(prev: CarInput, req: CarInput, cfg: PhysicsConfig, dt: number): CarInput {
  const target = { throttle: clamp(req.throttle, 0, 1), brake: clamp(req.brake, 0, 1), steer: clamp(req.steer, -1, 1) };
  const returning = Math.abs(target.steer) < Math.abs(prev.steer) || Math.sign(target.steer) !== Math.sign(prev.steer);
  return {
    throttle: approach(prev.throttle, target.throttle, cfg.input.throttleRate * dt),
    brake: approach(prev.brake, target.brake, cfg.input.brakeRate * dt),
    steer: approach(prev.steer, target.steer, (returning ? cfg.input.steerReturnRate : cfg.input.steerRate) * dt),
  };
}

interface WheelForces {
  lat: number;
  usage: number;
  slipDeg: number;
  gripN: number;
  loadN: number;
  /** Driven wheel: drive force delivered as a fraction of its grip (1 = at the limit, more = spinning). */
  driveUse: number;
  /** Brake force asked of this wheel (after ABS) as a fraction of its grip (1 = at the limit, more = locking). */
  brakeUse: number;
}

/** Work out and apply this tick's forces for one car. Returns per-wheel numbers for wear/telemetry. */
function applyCarForces(i: number, car: CarState, controls: CarInput, ctx: SimContext, dt: number, wake: { tow: number; dirtyAir: number }, realisticDamage: boolean, power: { mode: EngineMode; deployW: number }, surface: SurfaceGrid | undefined): Wheels<WheelForces> {
  const cfg = ctx.physics;
  // Damage effects (Realistic only): grip per wheel, steering pull, drag.
  const dmg = realisticDamage ? car.damage : NO_DAMAGE;
  const stats = buildStats(car.build, ctx.catalog);
  const mass = cfg.car.dryMassKg + Math.max(0, car.fuelKg);
  const f = forward(car.heading), r = right(car.heading);
  const vFwd = car.vx * f.x + car.vy * f.y;
  const v2 = car.vx * car.vx + car.vy * car.vy;
  const speed = Math.sqrt(v2);

  // Vertical load per wheel: weight PLUS downforce, split by weight balance, then lateral weight
  // transfer to the outside wheels. (The card's grip x (1 + downforce x v^2) is exactly this extra load;
  // it has to be part of the load, or the weight transfer of a 5 g corner exceeds the inside wheels'
  // static weight and they read as unloaded and "skidding".)
  const wf = cfg.car.weightFront;
  const share: Wheels<number> = [wf / 2, wf / 2, (1 - wf) / 2, (1 - wf) / 2];
  // Dirty air: following closely through a corner costs downforce (slipstream.ts).
  const vertical = mass * G * (1 + cfg.aero.downforceCoef * stats.downforce * (1 - wake.dirtyAir) * v2);
  const aRight = vFwd * car.angVel; // centripetal acceleration, + = toward the car's right
  const transfer = (mass * aRight * cfg.car.cgHeightM) / cfg.car.trackWidthM;
  const side: Wheels<number> = [-1, 1, -1, 1];
  const axle: Wheels<number> = [wf, wf, 1 - wf, 1 - wf];
  const load = share.map((s, w) => Math.max(0, vertical * s - side[w]! * transfer * axle[w]!)) as Wheels<number>;

  // Longitudinal requests.
  const vTop = cfg.engine.topSpeedKph * KPH * stats.topSpeed;
  const vLimit = car.inPitLane ? Math.min(vTop, ctx.rules.pitSpeedLimitKph * KPH) : vTop;
  const reversing = controls.brake > 0 && controls.throttle === 0 && vFwd < 0.5;
  let drive = 0;
  if (car.fuelKg > 0 && controls.throttle > 0) {
    // Engine mode scales the engine's power (ers.ts).
    const mode = ctx.ers.modes[power.mode].power;
    const powerN = (cfg.engine.powerKW * 1000 * stats.engine * mode) / Math.max(Math.abs(vFwd), 1);
    const fade = clamp((vLimit - vFwd) / (0.02 * vLimit + 0.5), 0, 1); // soft limiter at top speed / pit limit
    // Battery deploy is a second motor: its drive adds on top of the engine's, not under the engine's
    // force cap (where it'd be lost at anything below ~190 kph). Wheelspin is still the tyre's problem
    // (traction assist below). Already scaled by throttle (deployPowerW).
    const deployN = power.deployW / Math.max(Math.abs(vFwd), 5);
    drive = (controls.throttle * Math.min(cfg.engine.maxDriveForceN * stats.engine * mode, powerN) + deployN) * fade;
  } else if (reversing && car.fuelKg > 0) {
    const vRev = cfg.engine.maxReverseKph * KPH;
    drive = -controls.brake * cfg.engine.reverseForceN * clamp((vRev + vFwd) / 0.5, 0, 1);
  }
  const brakeTotal = reversing ? 0 : controls.brake * cfg.brakes.maxForceN * stats.brakes;
  const brakeShare: Wheels<number> = [cfg.brakes.frontBias / 2, cfg.brakes.frontBias / 2, (1 - cfg.brakes.frontBias) / 2, (1 - cfg.brakes.frontBias) / 2];

  // LONGITUDINAL LOAD TRANSFER (card 03b): braking loads the fronts (they bite, the car turns in),
  // throttle loads the rears. dFz = m * a_long * cgHeight / wheelbase, with a_long from this tick's
  // drive, brakes and drag, no more than the tyres can deliver.
  const dragF = cfg.aero.dragCoef * stats.drag * damageDrag(dmg, ctx.damage) * (1 - wake.tow) * v2;
  const aLongMax = cfg.tyres.baseGrip * stats.grip * vertical / mass;
  const aLong = clamp((drive - Math.sign(vFwd || 1) * (brakeTotal + dragF)) / mass, -aLongMax, aLongMax);
  const dFz = (mass * aLong * cfg.car.cgHeightM) / cfg.car.wheelbaseM;
  for (let w = 0; w < 4; w++) load[w] = Math.max(0, load[w]! + (w < 2 ? -dFz : dFz) / 2);

  const totalLoad = load[0] + load[1] + load[2] + load[3] || 1;
  const delta = frontWheelAngle(controls.steer, car, cfg) + damagePull(dmg, ctx.damage);

  const gripBase = cfg.tyres.baseGrip * stats.grip; // downforce is already in the load
  const positions = wheelPositions(car, cfg);
  const out = [] as unknown as Wheels<WheelForces>;

  for (let w = 0; w < 4; w++) {
    const p = positions[w]!;
    const rx = p.x - car.x, ry = p.y - car.y;
    const vx = car.vx - car.angVel * ry, vy = car.vy + car.angVel * rx; // v + omega x r
    const h = w < 2 ? car.heading + delta : car.heading;
    const wf_ = forward(h), wr = right(h);
    const vLong = vx * wf_.x + vy * wf_.y;
    const vLat = vx * wr.x + vy * wr.y;
    // Each wheel carries the share of the car's mass its load says it does: a light inside wheel asks
    // its tyre for little sideways force (and doesn't read as sliding), the loaded outside wheel for more.
    const wheelMass = (mass * load[w]!) / totalLoad;
    const surf = ctx.track.surfaces[car.wheels[w]!.surface]!;

    // Balance knobs (03b): front/rear grip multipliers next to weight distribution and yaw inertia.
    const cap = gripBase * (w < 2 ? cfg.tyres.frontGrip : cfg.tyres.rearGrip) * wearGrip(car.wheels[w]!.wear) * damageGrip(dmg, w, ctx.damage) * evolutionGrip(surface, p.x, p.y, ctx.evolution) * surf.grip * load[w]!;
    const capLat = cap * cfg.tyres.lateralGrip;
    const stopCap = (Math.abs(vLong) * wheelMass) / dt; // never push a wheel past standstill

    // Drive goes to the rears by load (limited-slip diff): a lifted inside rear doesn't get half the power.
    const rearLoad = load[2] + load[3];
    let long = w >= 2 ? (rearLoad > 0 ? (drive * load[w]!) / rearLoad : drive / 2) : 0;
    // TYRE CURVE (card 03b). Lateral: slip angle as a fraction of the peak slip angle. Longitudinal:
    // the braking/drive demand as a fraction of grip (no wheel-spin model: a demand past grip IS a
    // locked or spinning wheel). Combined slip s = their hypot (friction ellipse); the force available at
    // s rises to the peak at s = 1, then falls gently toward `falloff` (past the peak: sliding, catchable).
    const t = cfg.tyres;
    const alpha = Math.atan2(Math.abs(vLat), Math.max(Math.abs(vLong), t.lowSpeedMps));
    const sLat = alpha / ((t.peakSlipDeg * Math.PI) / 180);
    // ABS (config/assists.json, keyboard brakes are all or nothing): a wheel gets no more brake than keeps
    // its combined slip at peakPct of the peak, allowing for only cornerShare of how hard it's cornering.
    // Straight-line braking never locks; braking hard while turning hard still can (the inside front).
    let brakeW = brakeTotal * brakeShare[w]!;
    const abs = ctx.assists.abs;
    if (abs.enabled && brakeW > 0 && cap > 0) brakeW = Math.min(brakeW, cap * Math.sqrt(Math.max(0, abs.peakPct ** 2 - (abs.cornerShare * sLat) ** 2)));
    // Rolling resistance on static weight: unchanged by downforce, so tuned surface drag keeps its feel.
    const resist = Math.min(brakeW + surf.rollingDrag * mass * G * share[w]!, stopCap);
    long -= Math.sign(vLong) * resist;
    const brakeUse = brakeW > 0 ? (cap > 0 ? Math.min(Math.min(brakeW, stopCap) / cap, 2) : 2) : 0;
    // TRACTION ASSIST (keyboard throttle is all or nothing): a driven wheel gets no more drive than keeps
    // its combined slip at assistPeakPct of the peak, given how hard it's already cornering. Like the
    // steering assist, it can be switched off (a gamepad later).
    const tr = cfg.traction;
    if (tr.assist && w >= 2 && drive > 0 && long > 0 && cap > 0) long = Math.min(long, cap * Math.sqrt(Math.max(0, tr.assistPeakPct ** 2 - sLat * sLat)));
    const sLong = cap > 0 ? Math.abs(long) / cap : long ? Infinity : 0;
    // A wheel with no grip at all (lifted, worn through, zero-grip surface) gives no force: no 0 x infinity.
    const usage = cap > 0 ? Math.hypot(sLat, sLong) : 0;
    const avail = tyreCurve(usage, t.falloff, t.falloffSlip);
    if (!(cap > 0)) long = 0;
    // Below the peak the tyre gives what's asked longitudinally; past it, only its share of what's left.
    if (usage > 1) long = Math.sign(long) * cap * avail * (sLong / usage);
    let latMag = usage > 0 && cap > 0 ? capLat * (usage <= 1 ? sLat * (2 - usage) : avail * (sLat / usage)) : 0;
    // Stability at 60 Hz: never remove more than a fraction of the wheel's sideways velocity in one tick.
    latMag = Math.min(latMag, (Math.abs(vLat) * wheelMass * t.lateralStiffness) / dt);
    const lat = -Math.sign(vLat) * latMag;
    applyCarForce(ctx.cache, i, wf_.x * long + wr.x * lat, wf_.y * long + wr.y * lat, p.x, p.y);
    out[w] = {
      lat,
      usage: Number.isFinite(usage) ? usage : 99,
      slipDeg: Math.abs(vLong) + Math.abs(vLat) > 0.5 ? (Math.atan2(vLat, Math.abs(vLong)) * 180) / Math.PI : 0,
      gripN: cap,
      loadN: load[w]!,
      driveUse: w >= 2 && long > 0 && cap > 0 ? Math.min(long / cap, 2) : w >= 2 && long > 0 ? 2 : 0,
      brakeUse,
    };
  }

  // Aero drag on the body, and hard scrub while rubbing a tyre barrier.
  // Slipstream: in another car's wake, less drag (the tow).
  const dragK = cfg.aero.dragCoef * stats.drag * damageDrag(dmg, ctx.damage) * (1 - wake.tow) * speed;
  let fx = -dragK * car.vx, fy = -dragK * car.vy;
  if (car.barrierContact) {
    fx -= car.vx * mass * cfg.walls.barrierScrubPerSec;
    fy -= car.vy * mass * cfg.walls.barrierScrubPerSec;
  }
  applyCarForce(ctx.cache, i, fx, fy, car.x, car.y);
  setCarMass(ctx.cache, i, car, cfg);
  return out;
}

/** Tyre wear + fuel for one tick (SYS - Car model rules), and pit service. */
function updateConsumables(car: CarState, forces: Wheels<WheelForces>, ctx: SimContext, dt: number, ownBox: number, fillToKg = ctx.physics.fuel.tankKg, power: { mode: EngineMode; deployW: number } = { mode: car.ers.mode, deployW: 0 }): Pick<CarState, 'fuelKg' | 'wheels' | 'servicing' | 'damage' | 'ers'> {
  const cfg = ctx.physics;
  const kph = Math.abs(car.speed) / KPH;
  const v4 = (kph / cfg.wear.refSpeedKph) ** 4;
  const mass = cfg.car.dryMassKg + Math.max(0, car.fuelKg);
  const quarterWeight = (mass * G) / 4;
  const { throttle } = car.controls;
  // Practice (ownBox -1): any box. Race: only the car's own box; someone else's does nothing.
  const service = car.inPitBox && kph < cfg.fuel.pitServiceMaxKph && (ownBox < 0 || car.pitBox === ownBox);

  const wheels = car.wheels.map((wheel, w) => {
    let dw = cfg.wear.cornerPerSec * v4 * (Math.abs(forces[w]!.lat) / quarterWeight); // by actual lateral load
    // Throttle wears the rears by how hard they're driven against their grip (squared: a smooth squeeze
    // costs little, spinning them up out of a slow corner a lot), more at low speed. Not by pedal alone:
    // cruising flat out down a straight barely loads the rears longitudinally.
    if (w >= 2) dw += (cfg.wear.throttlePerSec * forces[w]!.driveUse ** 2) / (1 + kph / cfg.wear.throttleLowSpeedKph);
    // Braking wears the fronts: up to the grip limit by how hard they're braked (squared, like throttle),
    // more at high speed (v^4); PAST it (a lockup) also by how far past, times speed: lockups happen at low
    // speed, where v^4 alone would make them free. The two match at refSpeedKph.
    else {
      const use = forces[w]!.brakeUse;
      dw += cfg.wear.brakePerSec * (Math.min(use, 1) ** 2 * v4 + Math.max(0, use - 1) * (kph / cfg.wear.refSpeedKph));
    }
    return {
      ...wheel,
      wear: service ? 1 : Math.max(0, wheel.wear - dw * dt),
      slipDeg: forces[w]!.slipDeg,
      usage: forces[w]!.usage,
      gripN: forces[w]!.gripN,
      loadN: forces[w]!.loadN,
    };
  }) as Wheels<WheelState>;

  let fuelKg = Math.max(0, car.fuelKg - throttle * cfg.fuel.burnKgPerSec * ctx.ers.modes[power.mode].fuel * dt);
  // Battery: spend what was deployed, harvest a share of the braking power (each wheel's brake force x speed).
  const brakePowerW = forces.reduce((a, f) => a + Math.min(f.brakeUse, 1) * f.gripN, 0) * Math.abs(car.speed);
  const ers = updateErs(car.ers, power.mode, power.deployW, brakePowerW, car.timing.laps, dt, ctx.ers);
  if (service) fuelKg = Math.max(fuelKg, Math.min(fillToKg, cfg.fuel.tankKg, fuelKg + cfg.fuel.refuelKgPerSec * dt));
  // Repairs while stopped in the box (no pit board yet: always; it makes the stop longer).
  const damage = service && isDamaged(car.damage, 0) ? repairStep(car.damage, dt, ctx.damage) : car.damage;
  return { fuelKg, wheels, servicing: service, damage, ers };
}

/** One car's wheels for track evolution this tick: where, how loaded and slipping, how much tyre it shed, outward. */
function surfaceWork(before: CarState, car: CarState, ctx: SimContext): WheelWork[] {
  if (car.inPitLane) return [];
  const cfg = ctx.physics, speed = Math.hypot(car.vx, car.vy);
  const quarter = ((cfg.car.dryMassKg + Math.max(0, car.fuelKg)) * G) / 4;
  // Outside of the corner: away from the centre of the turn (turning right = centre to the right).
  const turn = Math.sign(car.angVel) || 0, r = right(car.heading);
  const corner = Math.abs(car.angVel * speed) / (cfg.tyres.baseGrip * G);
  return wheelPositions(car, cfg).map((p, w) => ({
    x: p.x, y: p.y,
    load: car.wheels[w]!.loadN / quarter,
    usage: car.wheels[w]!.usage,
    wear: Math.max(0, before.wheels[w]!.wear - car.wheels[w]!.wear),
    outX: -turn * r.x, outY: -turn * r.y,
    corner,
    moving: speed > 2,
  }));
}

/**
 * Advance the world by exactly one fixed tick. Returns a new state; never mutates the old one.
 * inputs[i] drives cars[i]; a missing input is treated as neutral.
 * Uses ctx.cache (Planck) as scratch, rebuilt from `world` every tick (see planck-cache.ts).
 */
export function step(world0: WorldState, inputs: readonly CarInput[], ctx: SimContext): WorldState {
  const dt = TICK_DT;
  // Reset to track first (rejoin.ts): a reset car starts this tick at its new place, so timing never sees
  // the jump as a drive across a line. Cars serving a reset penalty are held still.
  const resets = applyResets(world0.cars, inputs, ctx.track, ctx.race.reset, TICK_HZ, !!world0.race);
  const world: WorldState = resets.cars === world0.cars ? world0 : { ...world0, cars: resets.cars };
  prepareCache(ctx.cache, world, ctx.track, ctx.walls, ctx.physics, ctx.contact);

  // On the grid and under the lights, cars are held: the drivers' inputs are ignored (but read for jump starts).
  // In qualifying, cars waiting to leave the pit lane (and retired ones) are held the same way.
  const raceHeld = raceHolds(world.race);
  const controls = world.cars.map((car, i) => rampControls(car.controls, raceHeld || resets.held[i] || qualiHolds(world.quali, i, world.tick) ? NEUTRAL_INPUT : (inputs[i] ?? NEUTRAL_INPUT), ctx.physics, dt));
  const wake = wakeEffects(world.cars, ctx.physics.car.widthM, ctx.slipstream);
  const damageMode = world.settings?.damage ?? 'off';
  // Engine mode (kept until the driver asks for another) and battery deploy, per car.
  const power = world.cars.map((car, i) => {
    const held = raceHeld || resets.held[i] || qualiHolds(world.quali, i, world.tick);
    const req = held ? undefined : inputs[i];
    const mode = req?.engineMode && ctx.ers.modes[req.engineMode] ? req.engineMode : car.ers.mode;
    return { mode, deployW: car.fuelKg > 0 && !car.inPitLane ? deployPowerW(car.ers, !!req?.deploy, controls[i]!.throttle, ctx.ers) : 0 };
  });
  const forces = world.cars.map((car, i) => applyCarForces(i, car, controls[i]!, ctx, dt, { tow: wake.tow[i]!, dirtyAir: wake.dirtyAir[i]! }, damageMode === 'realistic', power[i]!, world.surface));
  stepWorld(ctx.cache, dt, ctx.physics);
  const bodies = readStateFromWorld(ctx.cache);

  const events: SimEvent[] = [];
  const cars = world.cars.map((car, i): CarState => {
    const b = bodies[i]!;
    const f = forward(b.heading);
    const surfaces = sampleSurfaces(b, ctx);
    const moved: CarState = {
      ...car,
      ...b,
      speed: b.vx * f.x + b.vy * f.y,
      controls: controls[i]!,
      steerAngle: frontWheelAngle(controls[i]!.steer, car, ctx.physics),
      wheels: car.wheels.map((wh, w) => ({ ...wh, surface: surfaces[w]! })) as Wheels<WheelState>,
      ...surfaceFlags(surfaces, ctx),
      pitBox: pitBoxUnder(b, ctx),
      tow: wake.tow[i]!,
      dirtyAir: wake.dirtyAir[i]!,
    };
    const timingEvents: TimingEvent[] = [];
    const timing = updateTiming(
      car.timing,
      { from: car, to: b, t0: world.tick * dt, t1: (world.tick + 1) * dt, offTrack: moved.offTrack, barrierContact: moved.barrierContact },
      ctx.track.json,
      i,
      timingEvents,
      ctx.race.timingLineReachM,
    );
    events.push(...timingEvents);
    // Damage from this tick's hits (Visual and Realistic record it; Off ignores them).
    if (damageMode !== 'off') {
      const hits = ctx.cache.hits.filter((h) => h.car === i);
      if (hits.length) moved.damage = applyHits(car.damage, b, hits, ctx.physics.car.lengthM, bodyOffsetM(ctx.physics), ctx.damage);
    }
    const next = { ...moved, ...updateConsumables(moved, forces[i]!, ctx, dt, world.race?.cars[i]?.box ?? -1, world.quali ? qualiFuelKg(ctx) : undefined, power[i]), timing };
    // Out of bounds should be unreachable behind walls. If a wheel gets there, the mask has a gap.
    if (surfaces.includes(ctx.track.index.outOfBounds)) {
      const ppm = ctx.track.json.pxPerMeter;
      events.push({ type: 'outOfBounds', car: i, x: b.x * ppm, y: b.y * ppm });
      return createCar(ctx.track.json.spawn, car.build, ctx);
    }
    return next;
  });
  // Track evolution: what every wheel did this tick lays rubber, sheds marbles to the outside, sweeps them.
  const surface = world.surface && ctx.evolution.enabled ? updateSurface(world.surface, ctx.track, cars.flatMap((c, i) => surfaceWork(world.cars[i]!, c, ctx)), dt, ctx.evolution) : world.surface;
  // Reset to track bookkeeping, once every car has moved: last on-track point, ghosts clearing.
  const tracked = cars.map((c, i) => {
    const allLegal = c.wheels.every((w) => ctx.track.surfaces[w.surface]!.legal);
    const rejoin = trackRejoin(c, allLegal, cars, i, ctx.track, ctx.race.reset);
    return rejoin === c.rejoin ? c : { ...c, rejoin };
  });
  cars.splice(0, cars.length, ...tracked);

  const tick = world.tick + 1;
  const keep = { ...(world.settings ? { settings: world.settings } : {}), ...(surface ? { surface } : {}) };
  if (world.quali) return { ...keep, tick, cars, events, quali: updateQuali(world.quali, tick, dt, cars, inputs.map((x) => x ?? NEUTRAL_INPUT), events, ctx.race) };
  if (!world.race) return { ...keep, tick, cars, events };
  const race = updateRace(world.race, tick, dt, world0.cars, cars, inputs.map((x) => x ?? NEUTRAL_INPUT), events, ctx.track, ctx.race);
  return { ...keep, tick, cars, events, race };
}
