// @vitest-environment node
// The Planck world is a cache of plain state: the same state must step the same way whatever the cache did
// before (another race in the same process, or a re-simulation from an older tick). Race noise card: a race
// run after another one used to go differently, because the broadphase tree kept its history.
import { describe, expect, it } from 'vitest';
import aiJson from '../../tools/fixtures/ai-baseline.json';
import contactJson from '../../tools/fixtures/contact-baseline.json';
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import slipstreamJson from '../../tools/fixtures/slipstream-baseline.json';
import raceJson from '../../config/race.json';
import { catalog, loadTrackNode, simContextNode } from '../../tools/load-track-node';
import { aiInputSource, buildRacingLine, createRaceWorld, step, type AiConfig, type PhysicsConfig, type RaceConfig, type SimContext, type WorldState } from './index';

const loaded = loadTrackNode('oxford');
const ctx: SimContext = { ...simContextNode(loaded, structuredClone(physicsJson as unknown as PhysicsConfig)), contact: contactJson, race: raceJson as RaceConfig, slipstream: slipstreamJson };
const line = buildRacingLine(ctx.track)!;
const cfg = aiJson as unknown as AiConfig;

/** A 10-car race (a crowded first lap: plenty of contacts) from `w`, `ticks` ticks on. */
function run(w0: WorldState, ticks: number, seed: number): WorldState {
  let w = w0;
  const ai = w.cars.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => cfg.presets[cfg.defaultPreset]!, () => cfg, seed + i));
  for (let t = 0; t < ticks && w.race!.phase !== 'results'; t++) w = step(w, ai.map((d) => d.read(w.tick)), ctx);
  return w;
}
const race = (seed: number) => createRaceWorld(ctx, Array.from({ length: 10 }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id })), { laps: 2, seed });

describe('physics cache', () => {
  it('a race steps the same way after any history: another race in between, or re-simulating from it', () => {
    const start = race(4);
    const a = run(start, 60 * 40, 10); // the start and the first lap
    run(race(3), 60 * 40, 20); // another race on the same cache
    const b = run(start, 60 * 40, 10);
    expect(b.race!.order).toEqual(a.race!.order);
    expect(b.cars.map((c) => [c.x, c.y, c.vx, c.vy])).toEqual(a.cars.map((c) => [c.x, c.y, c.vx, c.vy]));
    expect(b.tick).toBe(a.tick);
  }, 60_000);

  it('rebuilds the Planck world whenever a step does not carry on from the last one (so no history leaks in)', () => {
    const w0 = race(5);
    const w1 = step(w0, [], ctx);
    const world1 = ctx.cache.world;
    step(w1, [], ctx); // carries on from tick 1: same world
    expect(ctx.cache.world).toBe(world1);
    step(w0, [], ctx); // back to tick 0 (a re-simulation): a fresh one
    expect(ctx.cache.world).not.toBe(world1);
  });
});
