// @vitest-environment node
// AI drivers (card 05) on Oxford, with frozen configs (not live tuning) so these don't move while Justin
// tunes. The full 10-car x 20-lap check is `npm run ai-run`; this is the quick regression guard.
import { describe, expect, it } from 'vitest';
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import aiJson from '../../tools/fixtures/ai-baseline.json';
import slipstreamJson from '../../tools/fixtures/slipstream-baseline.json';
import { loadTrackNode, simContextNode } from '../../tools/load-track-node';
import { aiDrive, aiInputSource, buildRacingLine, createWorld, newAiState, step, type AiConfig, type PhysicsConfig, type WorldState } from './index';

const loaded = loadTrackNode('oxford');
const ctx = { ...simContextNode(loaded, structuredClone(physicsJson as unknown as PhysicsConfig)), slipstream: slipstreamJson };
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const hard = cfg.presets.hard!;

describe('AI drivers', () => {
  it('builds the racing line and a pit path that rejoins it', () => {
    expect(line.n).toBeGreaterThan(100);
    const pit = line.pit!;
    expect(pit).toBeDefined();
    expect(pit.box).toBeGreaterThan(pit.laneFrom);
    expect(pit.box).toBeLessThan(pit.laneTo);
    // The pit path starts and ends on the racing line.
    const d = (q: number, r: number) => Math.hypot(pit.x[q]! - line.x[r]!, pit.y[q]! - line.y[r]!);
    expect(d(0, pit.entry)).toBeLessThan(1);
    expect(d(pit.n - 1, pit.exit)).toBeLessThan(1);
  });

  it('is deterministic: same world + state + seed -> same input and state', () => {
    const world = createWorld(ctx, 2);
    const a = aiDrive(world, 1, newAiState(42), line, ctx, hard, cfg);
    const b = aiDrive(world, 1, newAiState(42), line, ctx, hard, cfg);
    expect(a).toEqual(b);
  });

  it('drives clean laps on its own', () => {
    let world: WorldState = createWorld(ctx, 1);
    const ai = aiInputSource(0, () => ({ world, ctx, line }), () => hard, () => cfg, 7);
    for (let t = 0; t < 60 * 150 && world.cars[0]!.timing.laps < 3; t++) world = step(world, [ai.read(world.tick)], ctx);
    expect(world.cars[0]!.timing.laps).toBe(3);
    expect(ai.state.stuckEvents).toBe(0);
  });

  it('pits when low on fuel: stops in the box, comes out full, rejoins', () => {
    let world: WorldState = createWorld(ctx, 1);
    world = { ...world, cars: [{ ...world.cars[0]!, fuelKg: 12 }] };
    const ai = aiInputSource(0, () => ({ world, ctx, line }), () => hard, () => cfg, 7);
    let maxFuel = 0;
    for (let t = 0; t < 60 * 120 && ai.state.pitStops === 0; t++) {
      world = step(world, [ai.read(world.tick)], ctx);
      maxFuel = Math.max(maxFuel, world.cars[0]!.fuelKg);
    }
    expect(ai.state.pitStops).toBe(1);
    expect(maxFuel).toBeGreaterThan(ctx.physics.fuel.tankKg - 1);
    for (let t = 0; t < 60 * 20; t++) world = step(world, [ai.read(world.tick)], ctx);
    expect(ai.state.mode).toBe('race');
    expect(world.cars[0]!.speed).toBeGreaterThan(10);
  });
});
