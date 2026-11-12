// @vitest-environment node
// Race mode (card 06) on Oxford, with frozen configs. The full-field check is
// `npm run ai-run -- --race --laps 15` (positions/gaps through pit stops and lapping, own boxes).
import { describe, expect, it } from 'vitest';
import aiJson from '../../tools/fixtures/ai-baseline.json';
import contactJson from '../../tools/fixtures/contact-baseline.json';
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import raceJson from '../../config/race.json';
import slipstreamJson from '../../tools/fixtures/slipstream-baseline.json';
import { loadTrackNode, simContextNode } from '../../tools/load-track-node';
import {
  aiInputSource,
  buildRacingLine,
  createRaceWorld,
  createWorld,
  gridOrder,
  raceResults,
  step,
  type AiConfig,
  type CarInput,
  type PhysicsConfig,
  type RaceConfig,
  type SimContext,
  type WorldState,
} from './index';

const loaded = loadTrackNode('oxford');
const race: RaceConfig = { ...raceJson, gridSec: 1, holdMinSec: 1, holdMaxSec: 1 };
const ctx: SimContext = { ...simContextNode(loaded, structuredClone(physicsJson as PhysicsConfig)), contact: contactJson, race, slipstream: slipstreamJson };
const ppm = ctx.track.json.pxPerMeter;
const idle: CarInput = { throttle: 0, brake: 0, steer: 0 };
const build = ctx.physics.defaultCar;

/** Park car i, stopped, in pit box b. */
const parkIn = (w: WorldState, i: number, b: number): WorldState => {
  const box = ctx.track.boxes[b]!;
  return { ...w, cars: w.cars.map((c, k) => (k === i ? { ...c, x: box.x / ppm, y: box.y / ppm, heading: Math.PI / 2, vx: 0, vy: 0, fuelKg: 10 } : c)) };
};

describe('pit boxes', () => {
  it('finds Oxford\'s 10 boxes, numbered front to back in driving direction', () => {
    const xs = ctx.track.boxes.map((b) => b.x);
    expect(xs).toHaveLength(10);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs); // the main straight runs left to right
  });

  it('race: a car is serviced only in its own box; practice: any box', () => {
    let w = createRaceWorld(ctx, [build, build], { laps: 3, seed: 1 });
    const own = w.race!.cars[0]!.box, other = (own + 1) % ctx.track.boxes.length;
    w = { ...w, race: { ...w.race!, phase: 'racing', phaseTick: 0, startTime: 0 } };
    const inOther = step(parkIn(w, 0, other), [idle, idle], ctx).cars[0]!;
    expect(inOther.pitBox).toBe(other);
    expect(inOther.servicing).toBe(false);
    expect(inOther.fuelKg).toBeLessThanOrEqual(10);
    const inOwn = step(parkIn(w, 0, own), [idle, idle], ctx).cars[0]!;
    expect(inOwn.servicing).toBe(true);
    expect(inOwn.fuelKg).toBeGreaterThan(10);
    const practice = step(parkIn(createWorld(ctx, 1), 0, other), [idle], ctx).cars[0]!;
    expect(practice.servicing).toBe(true);
  });

  it('assigns boxes in grid order, round-robin when there are more cars than boxes', () => {
    const w = createRaceWorld(ctx, Array.from({ length: 12 }, () => build), { laps: 3, seed: 5 });
    expect(w.race!.sharedBoxes).toBe(true);
    for (const c of w.race!.cars) expect(c.box).toBe(c.slot % 10);
  });
});

describe('grid and start', () => {
  it('shuffles the grid from the seed; the player can pick a slot', () => {
    expect(gridOrder(10, 7)).toEqual(gridOrder(10, 7));
    expect(gridOrder(10, 7)).not.toEqual(gridOrder(10, 8));
    expect(gridOrder(10, 7, 0)[0]).toBe(0);
    expect(gridOrder(10, 7, 9)[9]).toBe(0);
  });

  it('holds cars under the lights, flags throttle as a jump start, then goes', () => {
    let w = createRaceWorld(ctx, [build, build], { laps: 3, seed: 1, playerSlot: 0 });
    const x0 = w.cars[0]!.x;
    const lit: number[] = [];
    while (w.race!.phase !== 'racing') {
      w = step(w, [{ throttle: 1, brake: 0, steer: 0 }, idle], ctx);
      lit.push(w.race!.lights);
    }
    expect(w.cars[0]!.x).toBeCloseTo(x0, 6); // held: full throttle didn't move it
    expect(Math.max(...lit)).toBe(5);
    expect(w.race!.cars[0]!.jumpStart).toBe(true);
    expect(w.race!.cars[1]!.jumpStart).toBe(false);
    // grid 1 s + four more lights 4 s + hold 1 s
    expect(w.race!.startTime).toBeCloseTo(6, 1);
    for (let k = 0; k < 60; k++) w = step(w, [{ throttle: 1, brake: 0, steer: 0 }, idle], ctx);
    expect(w.cars[0]!.speed).toBeGreaterThan(5);
  });
});

describe('a short race', () => {
  it('runs grid -> results with AI, classifies everyone, never contradicts itself', () => {
    const line = buildRacingLine(ctx.track)!;
    const cfg = aiJson as unknown as AiConfig;
    let w = createRaceWorld(ctx, [build, { ...build, team: 'motus' }, { ...build, team: 'bluebull' }], { laps: 2, seed: 3 });
    const ai = [0, 1, 2].map((i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => cfg.presets.hard!, () => cfg, 10 + i));
    let last = w.race!.cars.map((c) => c.progress);
    for (let t = 0; t < 60 * 150 && w.race!.phase !== 'results'; t++) {
      w = step(w, ai.map((a) => a.read(w.tick)), ctx);
      w.race!.cars.forEach((c, i) => { if (!c.finished) expect(Math.abs(c.progress - last[i]!)).toBeLessThan(0.05); });
      last = w.race!.cars.map((c) => c.progress);
    }
    expect(w.race!.phase).toBe('results');
    const rows = raceResults(w.race!);
    expect(rows.map((r) => r.pos)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.finished)).toBe(true);
    expect(rows[0]!.gap).toBeUndefined();
    // Motus is slow on purpose: slowest best lap (finishing order in a 2-lap race also depends on traffic).
    expect(rows.find((r) => r.car === 1)!.bestLap).toBeGreaterThan(Math.max(...rows.filter((r) => r.car !== 1).map((r) => r.bestLap)));
    expect(rows.some((r) => r.jumpStart)).toBe(false);
  });
});
