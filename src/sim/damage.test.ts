// @vitest-environment node
// Car damage (POLISH card): hits damage the zone they land on, Realistic costs grip (a nose hit
// understeers), rubs don't damage, the pits repair it (a longer stop), the AI pits for it, Off = today.
import { describe, expect, it } from 'vitest';
import aiJson from '../../tools/fixtures/ai-baseline.json';
import contactJson from '../../tools/fixtures/contact-baseline.json';
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import slipstreamJson from '../../tools/fixtures/slipstream-baseline.json';
import raceJson from '../../config/race.json';
import rules from '../../config/rules.json';
import wallTracing from '../../config/wall-tracing.json';
import { catalog, loadTrackNode, simContextNode, surfaces } from '../../tools/load-track-node';
import {
  aiInputSource, bodyOffsetM, buildRacingLine, createRaceWorld, createSimTrack, createWorld, pitBoxPose, step, traceWalls,
  type AiConfig, type CarInput, type DamageMode, type PhysicsConfig, type RaceConfig, type SimContext, type TrackJson, type WorldState,
} from './index';

const loaded = loadTrackNode('oxford');
const ctx: SimContext = { ...simContextNode(loaded, structuredClone(physicsJson as PhysicsConfig)), contact: contactJson, race: raceJson as RaceConfig, slipstream: slipstreamJson };
const NONE: CarInput = { throttle: 0, brake: 0, steer: 0 };
const run = (c: SimContext, w: WorldState, ticks: number, input: CarInput | CarInput[] = NONE): WorldState => {
  for (let t = 0; t < ticks; t++) w = step(w, Array.isArray(input) ? input : w.cars.map(() => input), c);
  return w;
};

/** A walled box: asphalt inside a 1 m wall, 60 x 400 m. */
const arena: SimContext = (() => {
  const PPM = 10, W = 60, H = 400, idx = (id: string) => surfaces.findIndex((s) => s.id === id);
  const data = new Uint8Array(W * PPM * H * PPM);
  for (let y = 0; y < H * PPM; y++) for (let x = 0; x < W * PPM; x++) data[y * W * PPM + x] = idx(x < PPM || y < PPM || x >= (W - 1) * PPM || y >= (H - 1) * PPM ? 'wall' : 'asphalt');
  const json: TrackJson = { id: 'arena', name: 'arena', pxPerMeter: PPM, files: { mask: 'mask.png' }, timingLines: {}, racingLine: [], grid: [], spawn: { x: 30 * PPM, y: 395 * PPM, heading: 0 } };
  const track = createSimTrack(json, { width: W * PPM, height: H * PPM, data }, surfaces);
  return { ...ctx, track, walls: traceWalls(track.mask, track.index.wall, track.index.tyreBarrier, wallTracing), rules };
})();
/** Nose-first into the top wall at kph, in damage mode `mode`. */
const wallHit = (kph: number, mode: DamageMode) => {
  let w = createWorld(arena, 1, { damage: mode });
  w = { ...w, cars: [{ ...w.cars[0]!, x: 30, y: 12, heading: 0, vx: 0, vy: -kph / 3.6 }] };
  return run(arena, w, 90);
};

describe('car damage', () => {
  it('a hard nose-first wall hit breaks the front wing; Off records nothing and behaves as before', () => {
    const real = wallHit(100, 'realistic').cars[0]!;
    expect(real.damage.frontWing).toBeGreaterThan(0.5);
    expect(real.damage.rearWing + real.damage.left + real.damage.right).toBeLessThan(0.05);
    const off = wallHit(100, 'off');
    expect(off.cars[0]!.damage).toEqual({ frontWing: 0, rearWing: 0, left: 0, right: 0 });
    // Off = today: same run as a world with no settings at all.
    let plain = createWorld(arena, 1);
    plain = { ...plain, cars: [{ ...plain.cars[0]!, x: 30, y: 12, heading: 0, vx: 0, vy: -100 / 3.6 }] };
    expect(run(arena, plain, 90).cars).toEqual(off.cars);
  });

  it('Realistic: a broken front wing understeers (front grip down, less yaw at the same steer); Visual: no effect', () => {
    const circle = (frontWing: number, mode: DamageMode) => {
      let w = createWorld(arena, 1, { damage: mode });
      w = { ...w, cars: [{ ...w.cars[0]!, x: 30, y: 300, damage: { frontWing, rearWing: 0, left: 0, right: 0 } }] };
      w = run(arena, w, 60 * 2, { throttle: 0.5, brake: 0, steer: 0 }); // up to speed
      let yaw = 0, grip = 0;
      for (let t = 0; t < 30; t++) { w = run(arena, w, 1, { throttle: 0.5, brake: 0, steer: 0.6 }); yaw += Math.abs(w.cars[0]!.angVel); grip += w.cars[0]!.wheels[0].gripN + w.cars[0]!.wheels[1].gripN; }
      return { yaw, grip };
    };
    const clean = circle(0, 'realistic'), broken = circle(1, 'realistic'), shown = circle(1, 'visual');
    expect(broken.grip).toBeLessThan(clean.grip * 0.85);
    expect(broken.yaw).toBeLessThan(clean.yaw);
    expect(shown).toEqual(clean);
  });

  it('a rub at speed does no damage; a wall hit at walking pace does none either', () => {
    const { spawn, pxPerMeter: ppm } = ctx.track.json;
    const f = { x: Math.sin(spawn.heading), y: -Math.cos(spawn.heading) }, r = { x: Math.cos(spawn.heading), y: Math.sin(spawn.heading) };
    let w = createWorld(ctx, 2, { damage: 'realistic' });
    const place = (c: WorldState['cars'][number], across: number, dh: number) => ({ ...c, x: spawn.x / ppm + r.x * across - Math.sin(spawn.heading + dh) * bodyOffsetM(ctx.physics), y: spawn.y / ppm + r.y * across + Math.cos(spawn.heading + dh) * bodyOffsetM(ctx.physics), heading: spawn.heading + dh, vx: f.x * 42, vy: f.y * 42 });
    w = { ...w, cars: [place(w.cars[0]!, 0, 0), place(w.cars[1]!, 2.2, -0.04)] };
    // The rub itself (the first half second: after that the pushed car can graze the pit wall).
    let touched = false;
    for (let t = 0; t < 30; t++) { w = run(ctx, w, 1, [{ throttle: 0.6, brake: 0, steer: 0 }, { throttle: 0.6, brake: 0, steer: -0.15 }]); touched ||= w.cars[0]!.carContact; }
    expect(touched).toBe(true);
    for (const c of w.cars) expect(Math.max(c.damage.frontWing, c.damage.rearWing, c.damage.left, c.damage.right)).toBe(0);
    expect(wallHit(20, 'realistic').cars[0]!.damage.frontWing).toBe(0);
  });

  it('the pits repair it, and the stop takes longer for it', () => {
    const box = pitBoxPose(buildRacingLine(ctx.track), 0, ctx.track.json.pxPerMeter)!;
    const stop = (frontWing: number) => {
      let w = createWorld(ctx, 1, { damage: 'realistic' });
      w = { ...w, cars: [{ ...w.cars[0]!, x: box.x / ctx.track.json.pxPerMeter, y: box.y / ctx.track.json.pxPerMeter, heading: box.heading, fuelKg: ctx.physics.fuel.tankKg, damage: { frontWing, rearWing: 0, left: 0.5, right: 0 } }] };
      let t = 0;
      for (; t < 60 * 30; t++) { w = run(ctx, w, 1); const d = w.cars[0]!.damage; if (!w.cars[0]!.servicing) throw new Error('not in the box'); if (d.frontWing + d.left === 0) break; }
      return t / 60;
    };
    const sec = stop(1);
    expect(sec).toBeGreaterThan(ctx.damage.repair.wingSec - 0.1);
    expect(sec).toBeLessThan(ctx.damage.repair.suspensionSec + 0.5);
  });

  it('the AI pits for heavy damage, gets it repaired, and drives on', () => {
    const cfg = aiJson as unknown as AiConfig;
    const line = buildRacingLine(ctx.track)!;
    const builds = [0, 1].map((i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id }));
    let w = createRaceWorld(ctx, builds, { laps: 3, seed: 2, settings: { damage: 'realistic' } });
    w = { ...w, cars: w.cars.map((c, i) => (i === 0 ? { ...c, damage: { frontWing: 0.8, rearWing: 0, left: 0, right: 0 } } : c)) };
    const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => ({ ...cfg.presets[cfg.defaultPreset]!, mistakesPerMin: 0 }), () => cfg, 20 + i));
    for (let t = 0; t < 60 * 150 && !(ai[0]!.state.pitStops >= 1 && ai[0]!.state.mode === 'race'); t++) w = step(w, ai.map((d) => d.read(w.tick)), ctx);
    expect(ai[0]!.state.pitStops).toBe(1);
    expect(w.cars[0]!.damage.frontWing).toBe(0);
    expect(ai[1]!.state.pitStops).toBe(0); // the undamaged car (full tank, 3 laps) stays out
  }, 60_000);

  it('is deterministic', () => {
    expect(wallHit(120, 'realistic')).toEqual(wallHit(120, 'realistic'));
  });
});
