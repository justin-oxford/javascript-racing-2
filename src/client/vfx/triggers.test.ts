// @vitest-environment node
// VFX triggers against real sim runs on synthetic arenas.
import evolutionJson from '../../../config/evolution.json';
import ersJson from '../../../config/ers.json';
import damageJson from '../../../config/damage.json';
import assistsJson from '../../../tools/fixtures/assists-baseline.json';
import slipstreamJson from '../../../tools/fixtures/slipstream-baseline.json';
import contactJson from '../../../tools/fixtures/contact-baseline.json';
import raceJson from '../../../config/race.json';
import { describe, expect, it } from 'vitest';
// Frozen baseline, not live config: these behaviours must not change while Justin tunes.
import physicsJson from '../../../tools/fixtures/physics-baseline.json';
import rules from '../../../config/rules.json';
import vfx from '../../../tools/fixtures/vfx-baseline.json';
import wallTracing from '../../../config/wall-tracing.json';
import { catalog, surfaces } from '../../../tools/load-track-node';
import { createPhysicsCache, createSimTrack, createWorld, step, traceWalls, type CarInput, type ErsConfig, type PhysicsConfig, type SimContext, type TrackJson, type WorldState } from '../../sim';
import { wheelFx, type WheelFx } from './triggers';

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
  return { track, walls: traceWalls(track.mask, track.index.wall, track.index.tyreBarrier, wallTracing), physics: structuredClone(physicsJson) as unknown as PhysicsConfig, catalog, rules, contact: contactJson, race: raceJson, slipstream: slipstreamJson, assists: assistsJson, damage: damageJson, ers: ersJson as ErsConfig, evolution: { ...evolutionJson, enabled: false }, cache: createPhysicsCache() };
}

/** Run inputs, collect each tick's per-wheel FX. */
function run(ctx: SimContext, ticks: number, input: (w: WorldState) => CarInput, start = createWorld(ctx)) {
  let world = start;
  const fx: WheelFx[][] = [];
  for (let t = 0; t < ticks; t++) {
    const prev = world;
    world = step(world, [input(world)], ctx);
    fx.push(([0, 1, 2, 3] as const).map((w) => wheelFx(prev.cars[0]!, world.cars[0]!, w, vfx, surfaces, physicsJson.tyres.peakSlipDeg)));
  }
  return { world, fx };
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('tyre VFX triggers', () => {
  it('full throttle off the line spins the rears, not the fronts', () => {
    const { fx } = run(arena(30, 400, { x: 15, y: 395, heading: 0 }), 60, () => ({ throttle: 1, brake: 0, steer: 0 }));
    expect(sum(fx.map((f) => f[2]!.spin + f[3]!.spin))).toBeGreaterThan(1);
    expect(sum(fx.map((f) => f[0]!.mark + f[1]!.mark))).toBe(0);
  });

  it('a hard stop from speed locks the fronts (lockup, not slide)', () => {
    const ctx = arena(30, 1500, { x: 15, y: 1495, heading: 0 });
    const fast = run(ctx, 60 * 8, () => ({ throttle: 1, brake: 0, steer: 0 })).world;
    const { fx } = run(ctx, 90, () => ({ throttle: 0, brake: 1, steer: 0 }), fast);
    expect(sum(fx.map((f) => f[0]!.lockup + f[1]!.lockup))).toBeGreaterThan(5);
    expect(sum(fx.map((f) => f[0]!.slide + f[1]!.slide))).toBeLessThan(0.5);
  });

  it('a hard turn at speed slides (curved marks), not lockup/wheelspin', () => {
    const ctx = arena(300, 300, { x: 150, y: 280, heading: 0 });
    const fast = run(ctx, 60 * 4, () => ({ throttle: 1, brake: 0, steer: 0 })).world;
    const { fx } = run(ctx, 60, () => ({ throttle: 0.3, brake: 0, steer: 1 }), fast);
    expect(sum(fx.flatMap((f) => f.map((x) => x.slide)))).toBeGreaterThan(5);
    expect(sum(fx.flatMap((f) => f.map((x) => x.lockup)))).toBe(0);
  });

  it('grass and gravel at speed are flagged with the right surface', () => {
    const ctx = arena(30, 600, { x: 15, y: 595, heading: 0 }, (_, y) => (y < 500 && y > 450 ? 'grass' : y <= 450 && y > 400 ? 'gravel' : undefined));
    const { fx } = run(ctx, 60 * 6, () => ({ throttle: 1, brake: 0, steer: 0 }));
    const kinds = new Set(fx.flatMap((f) => f.map((x) => x.offTrack)).filter(Boolean));
    expect(kinds).toEqual(new Set(['grass', 'gravel']));
  });

  it('rubber goes down in braking zones far more than on a steady straight', () => {
    const ctx = arena(30, 3000, { x: 15, y: 2995, heading: 0 });
    // Get up to speed, then compare: 2 s of flat-out straight vs 2 s of hard braking (rubber per metre).
    const fast = run(ctx, 60 * 6, () => ({ throttle: 1, brake: 0, steer: 0 }));
    const straight = run(ctx, 120, () => ({ throttle: 1, brake: 0, steer: 0 }), fast.world);
    const braking = run(ctx, 120, () => ({ throttle: 0, brake: 1, steer: 0 }), straight.world);
    const perMetre = (r: { fx: WheelFx[][] }, from: WorldState, to: WorldState) =>
      sum(r.fx.flatMap((f) => f.map((x) => x.rubber))) / Math.abs(to.cars[0]!.y - from.cars[0]!.y);
    const straightRate = perMetre(straight, fast.world, straight.world);
    const brakingRate = perMetre(braking, straight.world, braking.world);
    expect(brakingRate).toBeGreaterThan(5 * straightRate);
  });

  it('cruising in a straight line leaves no skid marks', () => {
    const ctx = arena(30, 1500, { x: 15, y: 1495, heading: 0 });
    const fast = run(ctx, 60 * 5, () => ({ throttle: 1, brake: 0, steer: 0 })).world;
    const { fx } = run(ctx, 60, () => ({ throttle: 0.5, brake: 0, steer: 0 }), fast);
    expect(sum(fx.flatMap((f) => f.map((x) => x.mark)))).toBe(0);
  });

  it('high grip lifting the inside wheels in a hard corner: no inside-wheel skid marks, rear drive to the loaded wheel', () => {
    // Justin's tuning on 2026-11-11 (baseGrip 3, lateralGrip 1.18) corners near 6 g, past this car's
    // roll-over point, so the inside wheels carry ~no load. They used to read usage 99 and draw full skids.
    const ctx = arena(300, 300, { x: 150, y: 280, heading: 0 });
    ctx.physics.tyres.baseGrip = 3;
    ctx.physics.tyres.lateralGrip = 1.18;
    const fast = run(ctx, 60 * 3, () => ({ throttle: 1, brake: 0, steer: 0 }));
    let world = fast.world;
    const inside: number[] = [], outside: number[] = [], insideRearUsage: number[] = [];
    for (let t = 0; t < 90; t++) {
      const prev = world;
      world = step(world, [{ throttle: 0.5, brake: 0, steer: 0.6 }], ctx); // right turn: inside = right wheels
      const fx = ([0, 1, 2, 3] as const).map((w) => wheelFx(prev.cars[0]!, world.cars[0]!, w, vfx, surfaces, physicsJson.tyres.peakSlipDeg));
      inside.push(fx[1]!.mark + fx[3]!.mark);
      outside.push(fx[0]!.mark + fx[2]!.mark);
      insideRearUsage.push(world.cars[0]!.wheels[3].usage);
    }
    const c = world.cars[0]!;
    expect(c.wheels[1].loadN).toBeLessThan(0.2 * c.wheels[0].loadN); // the inside really is (nearly) lifted
    expect(Math.max(...inside)).toBeLessThan(0.05);
    expect(Math.max(...insideRearUsage)).toBeLessThan(5); // was 99: half the drive sent to a lifted wheel
  });
});
