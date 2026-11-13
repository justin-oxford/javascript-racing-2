// @vitest-environment node
import assistsJson from '../../../tools/fixtures/assists-baseline.json';
import slipstreamJson from '../../../tools/fixtures/slipstream-baseline.json';
import contactJson from '../../../tools/fixtures/contact-baseline.json';
import raceJson from '../../../config/race.json';
import { describe, expect, it } from 'vitest';
import audio from '../../../tools/fixtures/audio-baseline.json';
// Frozen baseline, not live config: these behaviours must not change while Justin tunes.
import physicsJson from '../../../tools/fixtures/physics-baseline.json';
import rules from '../../../config/rules.json';
import vfx from '../../../tools/fixtures/vfx-baseline.json';
import wallTracing from '../../../config/wall-tracing.json';
import { catalog, surfaces } from '../../../tools/load-track-node';
import { buildStats, createPhysicsCache, createSimTrack, createWorld, step, traceWalls, type CarInput, type PhysicsConfig, type SimContext, type TrackJson, type WorldState } from '../../sim';
import { soundTargets, topSpeedKph, virtualRpm, type SoundTargets } from './targets';

const PPM = 10;
const idx = (id: string) => surfaces.findIndex((s) => s.id === id);
function arena(wM: number, hM: number, spawn: { x: number; y: number; heading: number }, paint?: (x: number, y: number) => string | undefined): SimContext {
  const w = wM * PPM, h = hM * PPM;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      data[y * w + x] = idx(x < PPM || y < PPM || x >= w - PPM || y >= h - PPM ? 'wall' : (paint?.(x / PPM, y / PPM) ?? 'asphalt'));
  const json: TrackJson = { id: 't', name: 't', pxPerMeter: PPM, files: { mask: 'm' }, timingLines: {}, racingLine: [], grid: [], spawn: { x: spawn.x * PPM, y: spawn.y * PPM, heading: spawn.heading } };
  const track = createSimTrack(json, { width: w, height: h, data }, surfaces);
  return { track, walls: traceWalls(track.mask, track.index.wall, track.index.tyreBarrier, wallTracing), physics: structuredClone(physicsJson) as PhysicsConfig, catalog, rules, contact: contactJson, race: raceJson, slipstream: slipstreamJson, assists: assistsJson, cache: createPhysicsCache() };
}
function run(ctx: SimContext, ticks: number, input: (w: WorldState) => CarInput, start = createWorld(ctx)) {
  let world = start;
  const out: SoundTargets[] = [];
  const worlds: WorldState[] = [];
  const top = topSpeedKph(ctx.physics, buildStats(ctx.physics.defaultCar, catalog).topSpeed);
  for (let t = 0; t < ticks; t++) {
    const prev = world;
    world = step(world, [input(world)], ctx);
    worlds.push(world);
    out.push(soundTargets(prev.cars[0]!, world.cars[0]!, audio, vfx, ctx.physics, rules, surfaces, top));
  }
  return { world, out, worlds };
}

describe('virtual gearbox', () => {
  it('climbs through 8 gears with an RPM drop at each shift', () => {
    const top = 340;
    let drops = 0, last = virtualRpm(0, top, audio.engine);
    expect(last.rpm).toBe(audio.engine.idleRpm);
    for (let v = 1; v <= top; v++) {
      const r = virtualRpm(v, top, audio.engine);
      if (r.gear > last.gear) {
        drops++;
        expect(r.rpm).toBeLessThan(last.rpm);
      } else expect(r.rpm).toBeGreaterThanOrEqual(last.rpm);
      last = r;
    }
    expect(drops).toBe(audio.engine.gears - 1);
    expect(last.rpm).toBeCloseTo(audio.engine.maxRpm);
  });
});

describe('sound targets from the sim', () => {
  it('squeal is silent under the limit and sounds exactly when a wheel goes over it', () => {
    const ctx = arena(300, 300, { x: 150, y: 280, heading: 0 });
    const fast = run(ctx, 60 * 4, () => ({ throttle: 1, brake: 0, steer: 0 }));
    const turn = run(ctx, 90, (w) => ({ throttle: 0.3, brake: 0, steer: w.tick % 60 < 30 ? 1 : 0 }), fast.world);
    // Same threshold as the telemetry's red: no wheel over it -> silent.
    turn.out.forEach((t, i) => {
      const over = turn.worlds[i]!.cars[0]!.wheels.some((w) => w.usage > vfx.triggers.slipThreshold);
      if (!over) expect(t.squeal).toBe(0);
    });
    expect(turn.out.some((t) => t.squeal > 0.2)).toBe(true); // and it does squeal when over
    const cruise = run(ctx, 60, () => ({ throttle: 0.4, brake: 0, steer: 0 }), fast.world);
    // Once the throttle has settled (it ramps), a part-throttle straight is silent.
    expect(Math.max(...cruise.out.slice(20).map((t) => t.squeal))).toBe(0);
  });

  it('full-throttle traction limit on a straight is wheelspin, never squeal, at any speed', () => {
    const ctx = arena(30, 1500, { x: 15, y: 1495, heading: 0 });
    const { out } = run(ctx, 60 * 8, () => ({ throttle: 1, brake: 0, steer: 0 }));
    expect(Math.max(...out.map((t) => t.squeal))).toBe(0);
    expect(Math.max(...out.map((t) => t.wheelspin))).toBeGreaterThan(0.3);
  });

  it('a lockup drives the lockup layer, not the squeal layer', () => {
    const ctx = arena(30, 1500, { x: 15, y: 1495, heading: 0 });
    const fast = run(ctx, 60 * 8, () => ({ throttle: 1, brake: 0, steer: 0 })).world;
    const { out } = run(ctx, 60, () => ({ throttle: 0, brake: 1, steer: 0 }), fast);
    expect(Math.max(...out.map((t) => t.lockup))).toBeGreaterThan(0.4); // 03b: braking loads the fronts, a little less over the limit
    expect(Math.max(...out.map((t) => t.squeal))).toBeLessThan(0.2);
  });

  it('kerb, gravel and grass each drive their own layer', () => {
    const band = (y: number) => (y < 560 && y > 540 ? 'kerb' : y <= 540 && y > 520 ? 'grass' : y <= 520 && y > 500 ? 'gravel' : undefined);
    const { out } = run(arena(30, 600, { x: 15, y: 595, heading: 0 }, (_, y) => band(y)), 60 * 7, () => ({ throttle: 0.8, brake: 0, steer: 0 }));
    for (const k of ['kerb', 'grass', 'gravel'] as const) expect(Math.max(...out.map((t) => t[k]))).toBeGreaterThan(0.5);
    expect(Math.max(...out.map((t) => t.kerbPulseHz))).toBeGreaterThan(10);
  });

  it('wall hits fire once per contact and scale with speed', () => {
    const hit = (dist: number) => {
      const ctx = arena(30, dist + 10, { x: 15, y: dist + 5, heading: 0 });
      return run(ctx, 60 * 6, () => ({ throttle: 1, brake: 0, steer: 0 })).out.flatMap((t) => t.impacts).filter((i) => i.kind === 'wall');
    };
    const slow = hit(15), fast = hit(120);
    expect(slow.length).toBeGreaterThan(0);
    expect(fast[0]!.strength).toBeGreaterThan(slow[0]!.strength);
  });

  it('the pit lane beeps once on entry and pins the engine on the limiter', () => {
    const ctx = arena(30, 400, { x: 15, y: 395, heading: 0 }, (_, y) => (y < 360 ? 'pitLane' : undefined));
    const { out } = run(ctx, 60 * 6, () => ({ throttle: 1, brake: 0, steer: 0 }));
    expect(out.filter((t) => t.pitBeep)).toHaveLength(1);
    expect(out.some((t) => t.engine.limiter && t.engine.rpm === audio.engine.limiterRpm)).toBe(true);
  });

  it('lifting off is flagged (crackle / muffled engine)', () => {
    const open = arena(30, 800, { x: 15, y: 795, heading: 0 });
    const r = run(open, 120, (w) => ({ throttle: w.tick < 90 ? 1 : 0, brake: 0, steer: 0 }));
    expect(r.out.some((t) => t.engine.lift)).toBe(true);
  });
});
