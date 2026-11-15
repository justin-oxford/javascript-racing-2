// @vitest-environment node
// AI drivers (card 05) on Oxford, with frozen configs (not live tuning) so these don't move while Justin
// tunes. The full 10-car x 20-lap check is `npm run ai-run`; this is the quick regression guard.
import { describe, expect, it } from 'vitest';
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import aiJson from '../../tools/fixtures/ai-baseline.json';
import liveAiJson from '../../config/ai.json';
import slipstreamJson from '../../tools/fixtures/slipstream-baseline.json';
import { loadTrackNode, simContextNode } from '../../tools/load-track-node';
import { aiDrive, aiInputSource, buildRacingLine, createWorld, newAiState, oxfordScaled, scaleSec, step, type AiConfig, type PhysicsConfig, type WorldState } from './index';
/** Slow, whole-race tests get a longer time limit: a busy machine (a dev server running) can push them past 5 s. */
const SLOW_MS = 60_000;

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

  it('drives clean laps on its own', { timeout: SLOW_MS }, () => {
    let world: WorldState = createWorld(ctx, 1);
    const ai = aiInputSource(0, () => ({ world, ctx, line }), () => hard, () => cfg, 7);
    for (let t = 0; t < 60 * 150 && world.cars[0]!.timing.laps < 3; t++) world = step(world, [ai.read(world.tick)], ctx);
    expect(world.cars[0]!.timing.laps).toBe(3);
    expect(ai.state.stuckEvents).toBe(0);
  });

  it('pits when low on fuel: stops in the box, comes out full, rejoins', { timeout: SLOW_MS }, () => {
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

describe('tyre wear by axle (AI overtaking round 4)', () => {
  it('wearAxle: with worn rears under fresh fronts it plans from the rears (slower), never faster than the mean', () => {
    let w: WorldState = createWorld(ctx, 1);
    let st = newAiState(7);
    let slower = 0;
    for (let t = 0; t < 900; t++) {
      const worn = { ...w, cars: [{ ...w.cars[0]!, wheels: w.cars[0]!.wheels.map((x, k) => ({ ...x, wear: k < 2 ? 0.9 : 0.45 })) as typeof w.cars[0]['wheels'] }] };
      const mean = aiDrive(worn, 0, st, line, ctx, hard, cfg);
      const axle = aiDrive(worn, 0, st, line, ctx, hard, { ...cfg, wearAxle: true });
      expect(axle.state.lastAllowed).toBeLessThanOrEqual(mean.state.lastAllowed + 1e-9);
      if (axle.state.lastAllowed < mean.state.lastAllowed - 0.5) slower++;
      st = mean.state;
      w = step(worn, [mean.input], ctx);
    }
    expect(slower).toBeGreaterThan(60);
  });
});

describe('Oxford scale switch (round 8: ai.scale.oxford)', () => {
  // The live ai.json (its scale block's windows name the live sections).
  const lcfg = liveAiJson as unknown as AiConfig, live = lcfg.scale!.oxford!, lhard = lcfg.presets.hard!;
  const on: AiConfig = { ...lcfg, scale: { oxford: { ...live, enabled: true } } };
  it('turns a TRACK window in seconds into car lengths + a small speed term', () => {
    const v = 150 / 3.6, L = ctx.physics.car.lengthM;
    const s = oxfordScaled(lcfg, { ...live, enabled: true }, v, L);
    const [a, b] = live.windows['racecraft.attackGapSec']!;
    expect(s.racecraft!.attackGapSec * v).toBeCloseTo(a * L + b * v, 9);
    expect(scaleSec([2, 0.25], L, 0)).toBeCloseTo((2 * L) / 5 + 0.25, 9); // speed floored at 5 m/s
    expect(lcfg.racecraft!.attackGapSec).toBe(1); // the config itself is untouched
  });
  it('switched off (enabled false) drives exactly as without the block, both brains, for a whole duel', { timeout: SLOW_MS }, () => {
    const race = (c: AiConfig) => {
      let w: WorldState = createWorld(ctx, 2);
      const ds = [0, 1].map((i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => lhard, () => c, 5 + i));
      for (let t = 0; t < 60 * 15; t++) w = step(w, ds.map((d) => d.read(w.tick)), ctx);
      return w;
    };
    for (const brain of ['rules', 'lookahead'] as const) {
      const base = { ...lcfg, brain } as AiConfig;
      const { scale: _drop, ...without } = base;
      expect(race({ ...base, scale: { oxford: { ...live, enabled: false } } })).toEqual(race(without as AiConfig));
    }
  });
  it('a car in a train (no pace advantage) keeps about a car length; a clearly quicker one sees its advantage', { timeout: SLOW_MS }, () => {
    const duel = (lead: typeof lhard) => {
      let w: WorldState = createWorld(ctx, 2);
      const ds = [aiInputSource(0, () => ({ world: w, ctx, line }), () => lead, () => on, 1), aiInputSource(1, () => ({ world: w, ctx, line }), () => ({ ...lhard, mistakesPerMin: 0 }), () => on, 2)];
      const gaps: number[] = [];
      for (let t = 0; t < 60 * 40; t++) {
        w = step(w, ds.map((d) => d.read(w.tick)), ctx);
        const a = w.cars[1]!, b = w.cars[0]!, hx = Math.sin(a.heading), hy = -Math.cos(a.heading);
        const lon = (b.x - a.x) * hx + (b.y - a.y) * hy, lat = -(b.x - a.x) * hy + (b.y - a.y) * hx;
        if (t > 600 && lon > 0 && lon < 40 && Math.abs(lat) < 2.2) gaps.push(lon - ctx.physics.car.lengthM);
      }
      gaps.sort((x, y) => x - y);
      return { median: gaps[Math.floor(gaps.length / 2)] ?? Infinity, pace: ds[1]!.state.pace ?? 1 };
    };
    const train = duel({ ...lhard, mistakesPerMin: 0 });
    expect(train.median).toBeGreaterThan(0.8 * ctx.physics.car.lengthM);
    expect(1 - train.pace).toBeLessThan(live.follow.paceAdvMin!);
    const quicker = duel({ ...lhard, cornerMargin: lhard.cornerMargin * 0.9, brakeMargin: lhard.brakeMargin * 0.9, mistakesPerMin: 0 });
    expect(1 - quicker.pace).toBeGreaterThan(live.follow.paceAdvMin!);
  });
});

describe('following at Oxford scale (round 7: ai.follow)', () => {
  const follow = { enabled: true, gapLengths: 0.4, headwaySec: 0.04, brakeGapM: 0.75, brakeZoneSec: 1.5, aggrScale: 0.8, followBrake: 1, predictMargin: 0.97, reactSec: 0.15, sideGapM: 0.3, passOffsetM: 2.5 };
  /** A quicker car (hard) behind a slower one (margins x 0.9) for 40 s: bumper gaps while in line behind it, and contacts. */
  const duel = (c: AiConfig) => {
    let w: WorldState = createWorld(ctx, 2);
    const slow = { ...hard, cornerMargin: hard.cornerMargin * 0.9, brakeMargin: hard.brakeMargin * 0.9, mistakesPerMin: 0 }, fast = { ...hard, mistakesPerMin: 0 };
    const ds = [aiInputSource(0, () => ({ world: w, ctx, line }), () => slow, () => c, 1), aiInputSource(1, () => ({ world: w, ctx, line }), () => fast, () => c, 2)];
    const gaps: number[] = [];
    let hard12 = 0;
    for (let t = 0; t < 60 * 40; t++) {
      w = step(w, ds.map((d) => d.read(w.tick)), ctx);
      const a = w.cars[1]!, b = w.cars[0]!, hx = Math.sin(a.heading), hy = -Math.cos(a.heading);
      const lon = (b.x - a.x) * hx + (b.y - a.y) * hy, lat = -(b.x - a.x) * hy + (b.y - a.y) * hx;
      if (t > 600 && lon > 0 && lon < 40 && Math.abs(lat) < 2.2) gaps.push(lon - ctx.physics.car.lengthM);
      if (a.carContact && Math.hypot(a.vx - b.vx, a.vy - b.vy) >= 12) hard12++;
    }
    gaps.sort((x, y) => x - y);
    return { median: gaps[Math.floor(gaps.length / 2)] ?? Infinity, n: gaps.length, hard12 };
  };
  it('follows closer with the switch on (car lengths, not a 0.35 s headway), without heavy hits', { timeout: SLOW_MS }, () => {
    const off = duel(cfg), on = duel({ ...cfg, follow });
    expect(on.n).toBeGreaterThan(100);
    expect(on.median).toBeLessThan(off.median);
    expect(on.median).toBeLessThan(12);
    expect(on.hard12).toBe(0);
  });
  it('switched off (enabled false) drives exactly as without it', () => {
    const world = createWorld(ctx, 2);
    const a = aiDrive(world, 1, newAiState(42), line, ctx, hard, cfg);
    const b = aiDrive(world, 1, newAiState(42), line, ctx, hard, { ...cfg, follow: { ...follow, enabled: false } });
    expect(b).toEqual(a);
  });
});
