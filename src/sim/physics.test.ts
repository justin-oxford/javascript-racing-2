// @vitest-environment node
// Car physics on small synthetic arenas (built here, not real tracks), so each behaviour is isolated.
import contactJson from '../../tools/fixtures/contact-baseline.json';
import raceJson from '../../config/race.json';
import { describe, expect, it } from 'vitest';
// Frozen baseline, not live config: these behaviours must not change while Justin tunes.
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import rules from '../../config/rules.json';
import wallTracing from '../../config/wall-tracing.json';
import { catalog, surfaces } from '../../tools/load-track-node';
import {
  buildStats,
  createPhysicsCache,
  createSimTrack,
  createWorld,
  step,
  traceWalls,
  wearGrip,
  type CarBuild,
  type CarInput,
  type PhysicsConfig,
  type Pose,
  type SimContext,
  type TrackJson,
  type WorldState,
} from './index';

const PPM = 10;
const idx = (id: string): number => surfaces.findIndex((s) => s.id === id);

/** An arena W x H metres: asphalt inside a 1 m wall, out of bounds outside. `paint` can override. */
function arena(wM: number, hM: number, spawnM: Pose, paint?: (xM: number, yM: number) => string | undefined): SimContext {
  const w = wM * PPM, h = hM * PPM, wall = PPM;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const edge = x < wall || y < wall || x >= w - wall || y >= h - wall;
      data[y * w + x] = idx(edge ? 'wall' : (paint?.(x / PPM, y / PPM) ?? 'asphalt'));
    }
  const json: TrackJson = {
    id: 'arena', name: 'arena', pxPerMeter: PPM, files: { mask: 'mask.png' }, timingLines: {}, racingLine: [], grid: [],
    spawn: { x: spawnM.x * PPM, y: spawnM.y * PPM, heading: spawnM.heading },
  };
  const track = createSimTrack(json, { width: w, height: h, data }, surfaces);
  return {
    track,
    walls: traceWalls(track.mask, track.index.wall, track.index.tyreBarrier, wallTracing),
    physics: structuredClone(physicsJson) as PhysicsConfig,
    catalog,
    rules,
    contact: contactJson, race: raceJson, cache: createPhysicsCache(),
  };
}

function drive(ctx: SimContext, world: WorldState, ticks: number, input: CarInput | ((w: WorldState) => CarInput), each?: (w: WorldState) => void): WorldState {
  for (let t = 0; t < ticks; t++) {
    world = step(world, [typeof input === 'function' ? input(world) : input], ctx);
    each?.(world);
  }
  return world;
}

const FULL: CarInput = { throttle: 1, brake: 0, steer: 0 };
const kph = (ms: number) => ms * 3.6;

describe('car stats (team x spec x setup)', () => {
  const build = (team: string, spec = 'C1', setup = { downforce: 'Med', gearing: 'Med', brakes: 'Med' }): CarBuild => ({ team, spec, setup });

  it('Foucault C1 Med is the baseline', () => {
    expect(buildStats(build('foucault'), catalog)).toEqual({ engine: 1, topSpeed: 1, brakes: 1, drag: 1, downforce: 1, grip: 1 });
  });

  it('carries v0.16 ratios: Motus is slow, C3 is slower than C1, short gearing trades top speed for accel', () => {
    expect(buildStats(build('motus'), catalog).engine).toBeCloseTo(0.75);
    expect(buildStats(build('foucault', 'C3'), catalog).topSpeed).toBeCloseTo(5 / 7);
    const short = buildStats(build('foucault', 'C1', { downforce: 'High', gearing: 'Short', brakes: 'Med' }), catalog);
    expect([short.engine, short.topSpeed, short.drag, short.downforce]).toEqual([1.2, 0.95, 1.05, 1.05]);
  });
});

describe('physics', () => {
  it('accelerates to a sensible top speed and the throttle ramps (no instant full power)', () => {
    const ctx = arena(30, 2500, { x: 15, y: 2495, heading: 0 });
    let world = createWorld(ctx);
    world = step(world, [FULL], ctx);
    expect(world.cars[0]!.controls.throttle).toBeLessThan(1); // ramped
    let top = 0;
    world = drive(ctx, world, 60 * 25, FULL, (w) => (top = Math.max(top, kph(w.cars[0]!.speed))));
    expect(top).toBeGreaterThan(250);
    expect(top).toBeLessThan(400);
  });

  it('Motus loses a drag race to Cavalli', () => {
    const race = (team: string) => {
      const ctx = arena(30, 1200, { x: 15, y: 1195, heading: 0 });
      ctx.physics.defaultCar = { ...ctx.physics.defaultCar, team };
      return drive(ctx, createWorld(ctx), 60 * 12, FULL).cars[0]!;
    };
    const cavalli = race('cavalli'), motus = race('motus');
    expect(cavalli.y).toBeLessThan(motus.y - 50); // further up the strip by a clear margin
  });

  it('hitting a wall head-on scrubs speed and does not bounce back', () => {
    const ctx = arena(30, 150, { x: 15, y: 140, heading: 0 });
    let impact = 0, after = Infinity, touched = false, minY = Infinity, last = 0;
    drive(ctx, createWorld(ctx), 60 * 8, FULL, (w) => {
      const c = w.cars[0]!;
      if (!touched && c.wallContact) { touched = true; impact = last; }
      last = Math.abs(c.speed);
      if (touched) after = Math.min(after, c.vy * -1); // forward = -y; negative here = bouncing back
      minY = Math.min(minY, c.y);
      expect(w.events).toEqual([]);
    });
    expect(touched).toBe(true);
    expect(impact).toBeGreaterThan(30);
    expect(after).toBeGreaterThan(-0.2 * impact); // a bounce back is at most a fraction of impact speed
    expect(minY).toBeGreaterThan(1); // nose stayed this side of the 1 m wall
  });

  it('a glancing hit deflects along the wall and keeps some speed', () => {
    const ctx = arena(200, 60, { x: 20, y: 25, heading: Math.PI / 2 - 0.35 }); // moving right, 20 deg toward the top wall
    let hitTick = -1, later: { vx: number; vy: number } | undefined;
    drive(ctx, createWorld(ctx), 60 * 6, { throttle: 0.6, brake: 0, steer: 0 }, (w) => {
      const c = w.cars[0]!;
      if (hitTick < 0 && c.wallContact) hitTick = w.tick;
      if (hitTick >= 0 && w.tick === hitTick + 60) later = { vx: c.vx, vy: c.vy };
    });
    const hit = hitTick >= 0 ? true : undefined;
    expect(hit).toBeDefined();
    expect(later!.vx).toBeGreaterThan(5); // still moving along the wall
    expect(Math.abs(later!.vy)).toBeLessThan(later!.vx); // mostly along it, not off it
  });

  it('reversing into a wall for 10 s cannot pass through it', () => {
    const ctx = arena(30, 40, { x: 15, y: 30, heading: 0 }); // rear 6 m from the bottom wall
    let maxY = 0;
    const world = drive(ctx, createWorld(ctx), 60 * 10, { throttle: 0, brake: 1, steer: 0 }, (w) => {
      maxY = Math.max(maxY, w.cars[0]!.y);
      expect(w.events).toEqual([]);
    });
    expect(world.cars[0]!.wallContact).toBe(true);
    expect(maxY).toBeLessThan(40 - 1 - 2.5); // centre stays a half-length clear of the wall face
  });

  it('two wheels on the grass pull the car toward it but do not cap its speed', () => {
    // Grass west of x = 15 m; the car straddles the edge, left wheels on the grass. Measured over the first
    // 2 s, while it still straddles: with no one steering, the 03b tyre curve then lets it get pulled fully
    // onto the grass and spin, which is fair.
    const ctx = arena(30, 600, { x: 15.2, y: 595, heading: 0 }, (x) => (x < 15 ? 'grass' : undefined));
    const c = drive(ctx, createWorld(ctx), 60 * 2, FULL).cars[0]!;
    const clean = arena(30, 600, { x: 15.2, y: 595, heading: 0 });
    const ref = drive(clean, createWorld(clean), 60 * 2, FULL).cars[0]!;
    expect(ref.heading).toBeCloseTo(0, 6);
    expect(c.heading).toBeLessThan(-0.005); // yawed left, toward the grass
    expect(c.speed).toBeGreaterThan(0.6 * ref.speed); // slower, not capped
    const more = drive(ctx, drive(ctx, createWorld(ctx), 60 * 2, FULL), 30, FULL).cars[0]!;
    expect(more.speed).toBeGreaterThan(c.speed); // still accelerating
  });

  it('cornering wears the outside tyres most, in both directions (v0.16 bug: right side always)', () => {
    const lap = (steer: number) => {
      const ctx = arena(140, 140, { x: 70, y: 100, heading: 0 });
      return drive(ctx, createWorld(ctx), 60 * 20, { throttle: 0.45, brake: 0, steer }).cars[0]!.wheels;
    };
    const right = lap(1), left = lap(-1);
    // Right turn: outside = left wheels. Left turn: outside = right wheels.
    expect(right[0].wear).toBeLessThan(right[1].wear);
    expect(right[2].wear).toBeLessThan(right[3].wear);
    expect(left[1].wear).toBeLessThan(left[0].wear);
    expect(left[3].wear).toBeLessThan(left[2].wear);
  });

  it('grip vs wear keeps the v0.16 log10 cliff', () => {
    expect(wearGrip(1)).toBeCloseTo(1);
    expect(wearGrip(0.4)).toBeCloseTo(0.602, 3);
    expect(wearGrip(0.2)).toBeCloseTo(0.301, 3);
    expect(wearGrip(0.1)).toBe(0);
  });

  it('fuel burns on throttle and the car gets lighter', () => {
    const ctx = arena(30, 800, { x: 15, y: 795, heading: 0 });
    const world = drive(ctx, createWorld(ctx), 60 * 5, FULL);
    const burnt = ctx.physics.fuel.startKg - world.cars[0]!.fuelKg;
    expect(burnt).toBeGreaterThan(2);
    expect(burnt).toBeLessThanOrEqual(5 * ctx.physics.fuel.burnKgPerSec + 1e-9);
  });

  it('stopped in the pit box: fresh tyres and gradual refuel', () => {
    const ctx = arena(30, 30, { x: 15, y: 15, heading: 0 }, (x, y) => (Math.abs(x - 15) < 4 && Math.abs(y - 15) < 6 ? 'pitBox' : undefined));
    let world = createWorld(ctx);
    const worn = world.cars[0]!.wheels.map((w) => ({ ...w, wear: 0.3 })) as typeof world.cars[0]['wheels'];
    world = { ...world, cars: [{ ...world.cars[0]!, wheels: worn, fuelKg: 10 }] };
    world = drive(ctx, world, 60, { throttle: 0, brake: 0, steer: 0 });
    const c = world.cars[0]!;
    expect(c.wheels.every((w) => w.wear === 1)).toBe(true);
    expect(c.fuelKg).toBeGreaterThan(10 + 0.9 * ctx.physics.fuel.refuelKgPerSec);
    expect(c.fuelKg).toBeLessThan(10 + 1.1 * ctx.physics.fuel.refuelKgPerSec);
  });

  it('parking speed: a gentle steer + throttle from rest turns the car without sticking', () => {
    const ctx = arena(40, 40, { x: 20, y: 30, heading: 0 });
    const world = drive(ctx, createWorld(ctx), 60 * 2, { throttle: 0.15, brake: 0, steer: 1 });
    const c = world.cars[0]!;
    expect(kph(Math.abs(c.speed))).toBeGreaterThan(5);
    expect(c.heading).toBeGreaterThan(0.2);
  });

  it('live tuning: changing a config value changes the very next tick', () => {
    const ctx = arena(30, 600, { x: 15, y: 595, heading: 0 });
    let a = drive(ctx, createWorld(ctx), 60, FULL);
    const b = structuredClone(a);
    const ctxB = arena(30, 600, { x: 15, y: 595, heading: 0 });
    ctxB.physics.engine.powerKW *= 0.3;
    ctxB.physics.engine.maxDriveForceN *= 0.3;
    a = drive(ctx, a, 60, FULL);
    const slower = drive(ctxB, b, 60, FULL);
    expect(slower.cars[0]!.speed).toBeLessThan(a.cars[0]!.speed - 3);
  });
});
