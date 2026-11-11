// Planck (Box2D) as a DERIVED CACHE, never the source of truth (SYS - Architecture rules, STATE IS DATA).
// Car state lives in plain WorldState. Each tick the sim writes the plain state into Planck
// (writeStateToWorld), applies forces, steps, and reads the result back (readStateFromWorld).
//
// What is cached: the static wall bodies (rebuilt only when the track/mask changes).
// What is NOT: car bodies. They are recreated from plain state every tick. Box2D carries hidden
// per-body history (contact warm-start impulses, broadphase tree layout, contact order) that plain
// state can't capture; keeping it made a rebuilt world drift 0.35-3 m from a continuous one after
// wall contact. Recreating the cars every tick means a continuous run and a run rebuilt from any
// snapshot do identical work: rewind/replay is exact (drift 0). Resting contact against walls was
// measured identical in both modes, and recreating a few car bodies per tick is cheap.
import { BoxShape, ChainShape, Vec2, World, type Body, type Fixture } from 'planck';
import type { PhysicsConfig } from './car-config';
import type { SimTrack, WallChain } from './track';
import type { CarState, WorldState } from './types';

interface WallTag {
  kind: 'wall' | 'barrier';
}

export interface PhysicsCache {
  world: World;
  cars: Body[];
  walls: Fixture[];
  /** Track (and wall outlines) the world was built for. A new object = hot reload = rebuild. */
  track: SimTrack | undefined;
  walls_: readonly WallChain[] | undefined;
  /** Wall material last applied, so live tuning reaches existing fixtures. */
  wallMaterial: { restitution: number; friction: number };
}

export function createPhysicsCache(): PhysicsCache {
  return {
    world: new World({ gravity: Vec2(0, 0), allowSleep: false }),
    cars: [],
    walls: [],
    track: undefined,
    walls_: undefined,
    wallMaterial: { restitution: NaN, friction: NaN },
  };
}

function buildWalls(cache: PhysicsCache, track: SimTrack, walls: readonly WallChain[], cfg: PhysicsConfig): void {
  const { world } = cache;
  for (let b = world.getBodyList(); b; ) {
    const next = b.getNext();
    if (b.isStatic()) world.destroyBody(b);
    b = next;
  }
  cache.walls = [];
  const ppm = track.json.pxPerMeter;
  const body = world.createBody({ type: 'static' });
  for (const w of walls) {
    const verts = [];
    for (let i = 0; i < w.points.length; i += 2) verts.push(Vec2(w.points[i]! / ppm, w.points[i + 1]! / ppm));
    if (verts.length < 3) continue;
    const tag: WallTag = { kind: w.barrier ? 'barrier' : 'wall' };
    cache.walls.push(
      body.createFixture({ shape: new ChainShape(verts, true), friction: cfg.walls.friction, restitution: cfg.walls.restitution, userData: tag }),
    );
  }
  cache.wallMaterial = { restitution: cfg.walls.restitution, friction: cfg.walls.friction };
  cache.track = track;
  cache.walls_ = walls;
}

function carMassData(car: CarState, cfg: PhysicsConfig): { mass: number; center: Vec2; I: number } {
  const mass = cfg.car.dryMassKg + Math.max(0, car.fuelKg);
  const { lengthM: l, widthM: w } = cfg.car;
  return { mass, center: Vec2(0, 0), I: ((mass * (l * l + w * w)) / 12) * cfg.car.inertiaScale };
}

/**
 * Make the Planck world mirror a plain state exactly (bodies, transforms, velocities, mass).
 * Car bodies are recreated, not moved, so no Box2D history survives from earlier ticks.
 */
export function writeStateToWorld(cache: PhysicsCache, state: WorldState, cfg: PhysicsConfig): void {
  const { world } = cache;
  while (cache.cars.length) world.destroyBody(cache.cars.pop()!);
  while (cache.cars.length < state.cars.length) {
    const body = world.createBody({ type: 'dynamic', allowSleep: false, bullet: true });
    body.createFixture({ shape: new BoxShape(cfg.car.widthM / 2, cfg.car.lengthM / 2), density: 1, friction: 0.3, restitution: 0.1 });
    cache.cars.push(body);
  }
  state.cars.forEach((car, i) => syncBody(cache.cars[i]!, car, cfg));
}

function syncBody(body: Body, car: CarState, cfg: PhysicsConfig): void {
  body.setTransform(Vec2(car.x, car.y), car.heading);
  body.setLinearVelocity(Vec2(car.vx, car.vy));
  body.setAngularVelocity(car.angVel);
  body.setMassData(carMassData(car, cfg));
  body.setAwake(true);
}

export interface BodyReadout {
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  angVel: number;
  wallContact: boolean;
  barrierContact: boolean;
  carContact: boolean;
}

/** Read every car body back out as plain numbers. */
export function readStateFromWorld(cache: PhysicsCache): BodyReadout[] {
  return cache.cars.map((b) => {
    const p = b.getPosition(), v = b.getLinearVelocity();
    let wallContact = false, barrierContact = false, carContact = false;
    for (let ce = b.getContactList(); ce; ce = ce.next ?? null) {
      if (!ce.contact.isTouching()) continue;
      const tag = (ce.contact.getFixtureA().getUserData() ?? ce.contact.getFixtureB().getUserData()) as WallTag | null;
      if (tag?.kind === 'barrier') barrierContact = true;
      else if (tag?.kind === 'wall') wallContact = true;
      else if (ce.other?.isDynamic()) carContact = true;
    }
    return { x: p.x, y: p.y, heading: b.getAngle(), vx: v.x, vy: v.y, angVel: b.getAngularVelocity(), wallContact, barrierContact, carContact };
  });
}

/**
 * Get the cache ready to step `state`: rebuild walls if the track changed (hot reload), write the
 * cars from plain state, and apply live-tuned wall material.
 */
export function prepareCache(cache: PhysicsCache, state: WorldState, track: SimTrack, walls: readonly WallChain[], cfg: PhysicsConfig): void {
  if (cache.track !== track || cache.walls_ !== walls) buildWalls(cache, track, walls, cfg);
  writeStateToWorld(cache, state, cfg);
  const m = cache.wallMaterial;
  if (m.restitution !== cfg.walls.restitution || m.friction !== cfg.walls.friction) {
    for (const f of cache.walls) {
      f.setRestitution(cfg.walls.restitution);
      f.setFriction(cfg.walls.friction);
    }
    cache.wallMaterial = { restitution: cfg.walls.restitution, friction: cfg.walls.friction };
  }
}

/** Apply forces to car i (world frame, newtons, at a world point). */
export function applyCarForce(cache: PhysicsCache, i: number, fx: number, fy: number, px: number, py: number): void {
  cache.cars[i]!.applyForce(Vec2(fx, fy), Vec2(px, py), true);
}

/** Fuel burns off: keep the body's mass in step with plain state. */
export function setCarMass(cache: PhysicsCache, i: number, car: CarState, cfg: PhysicsConfig): void {
  cache.cars[i]!.setMassData(carMassData(car, cfg));
}

export function stepWorld(cache: PhysicsCache, dt: number, cfg: PhysicsConfig): void {
  cache.world.step(dt, cfg.solver.velocityIterations, cfg.solver.positionIterations);
}
