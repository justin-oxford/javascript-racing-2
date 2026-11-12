import { buildStats, type CarCatalog, type PhysicsConfig } from './car-config';
import { applyCarForce, prepareCache, readStateFromWorld, setCarMass, stepWorld, type PhysicsCache } from './planck-cache';
import type { SimTrack, WallChain } from './track';
import { boxAt, surfaceAt } from './track';
import { gridOrder, newRaceState, raceHolds, updateRace, type RaceConfig } from './race';
import { newTiming, updateTiming, type TimingEvent } from './timing';
import type { CarBuild, CarInput, CarState, ContactConfig, Pose, Rules, SimEvent, WheelState, Wheels, WorldState } from './types';
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
  cache: PhysicsCache;
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

/** Tyre grip vs wear: gentle down to ~40%, then a cliff, nothing left at 10% (v0.16 curve). */
export function wearGrip(wear: number): number {
  return Math.max(0, Math.log10(10 * wear));
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
    fuelKg: ctx.physics.fuel.startKg,
    wheels: surfaces.map(newWheel) as Wheels<WheelState>,
    ...surfaceFlags(surfaces, ctx),
    pitBox: pitBoxUnder(pose, ctx),
    servicing: false,
    wallContact: false,
    barrierContact: false,
    carContact: false,
    timing: newTiming(),
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

export function createWorld(ctx: SimContext, cars: number | readonly CarBuild[] = 1): WorldState {
  const builds = typeof cars === 'number' ? Array.from({ length: cars }, () => ctx.physics.defaultCar) : cars;
  return { tick: 0, cars: builds.map((b, i) => createCar(startPose(i, ctx), b, ctx)), events: [] };
}

export interface RaceSetup {
  laps: number;
  /** Seeds the grid shuffle and the start-light hold. */
  seed: number;
  /** Put the player (car 0) in this grid slot; otherwise the grid is shuffled. */
  playerSlot?: number | undefined;
}

/**
 * A race (card 06): cars on the grid (slot order = shuffled, or the player's choice), held still until
 * lights out, each assigned its own pit box. Car indices stay as given (car 0 = the player).
 */
export function createRaceWorld(ctx: SimContext, builds: readonly CarBuild[], setup: RaceSetup): WorldState {
  const order = gridOrder(builds.length, setup.seed, setup.playerSlot);
  const slotOf = new Map(order.map((car, slot) => [car, slot]));
  const cars = builds.map((b, i) => createCar(startPose(slotOf.get(i)!, ctx), b, ctx));
  return { tick: 0, cars, events: [], race: newRaceState(order, setup.laps, setup.seed, ctx.track, ctx.race, TICK_HZ) };
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
}

/** Work out and apply this tick's forces for one car. Returns per-wheel numbers for wear/telemetry. */
function applyCarForces(i: number, car: CarState, controls: CarInput, ctx: SimContext, dt: number): Wheels<WheelForces> {
  const cfg = ctx.physics;
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
  const vertical = mass * G * (1 + cfg.aero.downforceCoef * stats.downforce * v2);
  const aRight = vFwd * car.angVel; // centripetal acceleration, + = toward the car's right
  const transfer = (mass * aRight * cfg.car.cgHeightM) / cfg.car.trackWidthM;
  const side: Wheels<number> = [-1, 1, -1, 1];
  const axle: Wheels<number> = [wf, wf, 1 - wf, 1 - wf];
  const load = share.map((s, w) => Math.max(0, vertical * s - side[w]! * transfer * axle[w]!)) as Wheels<number>;
  const totalLoad = load[0] + load[1] + load[2] + load[3] || 1;

  // Longitudinal requests.
  const vTop = cfg.engine.topSpeedKph * KPH * stats.topSpeed;
  const vLimit = car.inPitLane ? Math.min(vTop, ctx.rules.pitSpeedLimitKph * KPH) : vTop;
  const reversing = controls.brake > 0 && controls.throttle === 0 && vFwd < 0.5;
  let drive = 0;
  if (car.fuelKg > 0 && controls.throttle > 0) {
    const powerN = (cfg.engine.powerKW * 1000 * stats.engine) / Math.max(Math.abs(vFwd), 1);
    const fade = clamp((vLimit - vFwd) / (0.02 * vLimit + 0.5), 0, 1); // soft limiter at top speed / pit limit
    drive = controls.throttle * Math.min(cfg.engine.maxDriveForceN * stats.engine, powerN) * fade;
  } else if (reversing && car.fuelKg > 0) {
    const vRev = cfg.engine.maxReverseKph * KPH;
    drive = -controls.brake * cfg.engine.reverseForceN * clamp((vRev + vFwd) / 0.5, 0, 1);
  }
  const brakeTotal = reversing ? 0 : controls.brake * cfg.brakes.maxForceN * stats.brakes;
  const brakeShare: Wheels<number> = [cfg.brakes.frontBias / 2, cfg.brakes.frontBias / 2, (1 - cfg.brakes.frontBias) / 2, (1 - cfg.brakes.frontBias) / 2];

  // Steering: lock shrinks with speed.
  const lock = (cfg.steering.lockDeg * Math.PI) / 180 / (1 + (speed / KPH) / cfg.steering.lockFalloffKph);
  const delta = controls.steer * lock;

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

    const cap = gripBase * wearGrip(car.wheels[w]!.wear) * surf.grip * load[w]!;
    const capLat = cap * cfg.tyres.lateralGrip;
    const stopCap = (Math.abs(vLong) * wheelMass) / dt; // never push a wheel past standstill

    // Drive goes to the rears by load (limited-slip diff): a lifted inside rear doesn't get half the power.
    const rearLoad = load[2] + load[3];
    let long = w >= 2 ? (rearLoad > 0 ? (drive * load[w]!) / rearLoad : drive / 2) : 0;
    // Rolling resistance on static weight: unchanged by downforce, so tuned surface drag keeps its feel.
    const resist = Math.min(brakeTotal * brakeShare[w]! + surf.rollingDrag * mass * G * share[w]!, stopCap);
    long -= Math.sign(vLong) * resist;
    let lat = (-vLat * wheelMass * cfg.tyres.lateralStiffness) / dt;

    // Friction ellipse: over the cap the tyre slides and only gives what it has.
    const usage = Math.hypot(cap > 0 ? long / cap : long ? Infinity : 0, capLat > 0 ? lat / capLat : lat ? Infinity : 0);
    if (usage > 1) {
      long /= usage;
      lat /= usage;
    }
    applyCarForce(ctx.cache, i, wf_.x * long + wr.x * lat, wf_.y * long + wr.y * lat, p.x, p.y);
    out[w] = {
      lat,
      usage: Number.isFinite(usage) ? usage : 99,
      slipDeg: Math.abs(vLong) + Math.abs(vLat) > 0.5 ? (Math.atan2(vLat, Math.abs(vLong)) * 180) / Math.PI : 0,
      gripN: cap,
      loadN: load[w]!,
    };
  }

  // Aero drag on the body, and hard scrub while rubbing a tyre barrier.
  const dragK = cfg.aero.dragCoef * stats.drag * speed;
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
function updateConsumables(car: CarState, forces: Wheels<WheelForces>, ctx: SimContext, dt: number, ownBox: number): Pick<CarState, 'fuelKg' | 'wheels' | 'servicing'> {
  const cfg = ctx.physics;
  const kph = Math.abs(car.speed) / KPH;
  const v4 = (kph / cfg.wear.refSpeedKph) ** 4;
  const mass = cfg.car.dryMassKg + Math.max(0, car.fuelKg);
  const quarterWeight = (mass * G) / 4;
  const { throttle, brake } = car.controls;
  // Practice (ownBox -1): any box. Race: only the car's own box; someone else's does nothing.
  const service = car.inPitBox && kph < cfg.fuel.pitServiceMaxKph && (ownBox < 0 || car.pitBox === ownBox);

  const wheels = car.wheels.map((wheel, w) => {
    let dw = cfg.wear.cornerPerSec * v4 * (Math.abs(forces[w]!.lat) / quarterWeight); // by actual lateral load
    if (w >= 2) dw += cfg.wear.throttlePerSec * throttle / (1 + kph / cfg.wear.throttleLowSpeedKph); // wheelspin
    else dw += cfg.wear.brakePerSec * brake * v4;
    return {
      ...wheel,
      wear: service ? 1 : Math.max(0, wheel.wear - dw * dt),
      slipDeg: forces[w]!.slipDeg,
      usage: forces[w]!.usage,
      gripN: forces[w]!.gripN,
      loadN: forces[w]!.loadN,
    };
  }) as Wheels<WheelState>;

  let fuelKg = Math.max(0, car.fuelKg - throttle * cfg.fuel.burnKgPerSec * dt);
  if (service) fuelKg = Math.min(cfg.fuel.tankKg, fuelKg + cfg.fuel.refuelKgPerSec * dt);
  return { fuelKg, wheels, servicing: service };
}

/**
 * Advance the world by exactly one fixed tick. Returns a new state; never mutates the old one.
 * inputs[i] drives cars[i]; a missing input is treated as neutral.
 * Uses ctx.cache (Planck) as scratch, rebuilt from `world` every tick (see planck-cache.ts).
 */
export function step(world: WorldState, inputs: readonly CarInput[], ctx: SimContext): WorldState {
  const dt = TICK_DT;
  prepareCache(ctx.cache, world, ctx.track, ctx.walls, ctx.physics, ctx.contact);

  // On the grid and under the lights, cars are held: the drivers' inputs are ignored (but read for jump starts).
  const held = raceHolds(world.race);
  const controls = world.cars.map((car, i) => rampControls(car.controls, held ? NEUTRAL_INPUT : (inputs[i] ?? NEUTRAL_INPUT), ctx.physics, dt));
  const forces = world.cars.map((car, i) => applyCarForces(i, car, controls[i]!, ctx, dt));
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
      wheels: car.wheels.map((wh, w) => ({ ...wh, surface: surfaces[w]! })) as Wheels<WheelState>,
      ...surfaceFlags(surfaces, ctx),
      pitBox: pitBoxUnder(b, ctx),
    };
    const timingEvents: TimingEvent[] = [];
    const timing = updateTiming(
      car.timing,
      { from: car, to: b, t0: world.tick * dt, t1: (world.tick + 1) * dt, offTrack: moved.offTrack, barrierContact: moved.barrierContact },
      ctx.track.json,
      i,
      timingEvents,
    );
    events.push(...timingEvents);
    const next = { ...moved, ...updateConsumables(moved, forces[i]!, ctx, dt, world.race?.cars[i]?.box ?? -1), timing };
    // Out of bounds should be unreachable behind walls. If a wheel gets there, the mask has a gap.
    if (surfaces.includes(ctx.track.index.outOfBounds)) {
      const ppm = ctx.track.json.pxPerMeter;
      events.push({ type: 'outOfBounds', car: i, x: b.x * ppm, y: b.y * ppm });
      return createCar(ctx.track.json.spawn, car.build, ctx);
    }
    return next;
  });

  const tick = world.tick + 1;
  if (!world.race) return { tick, cars, events };
  const race = updateRace(world.race, tick, dt, world.cars, cars, inputs.map((x) => x ?? NEUTRAL_INPUT), events, ctx.track, ctx.race);
  return { tick, cars, events, race };
}
