// @vitest-environment node
// Slipstream (tow) + dirty air: the wake rules on their own, then two cars down a long straight.
import evolutionJson from '../../config/evolution.json';
import strategyJson from '../../config/strategy.json';
import ersJson from '../../config/ers.json';
import damageJson from '../../config/damage.json';
import assistsJson from '../../tools/fixtures/assists-baseline.json';
import { describe, expect, it } from 'vitest';
import contactJson from '../../tools/fixtures/contact-baseline.json';
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import slipstreamJson from '../../tools/fixtures/slipstream-baseline.json';
import raceJson from '../../config/race.json';
import rules from '../../config/rules.json';
import wallTracing from '../../config/wall-tracing.json';
import { catalog, surfaces } from '../../tools/load-track-node';
import { createPhysicsCache, createSimTrack, createWorld, step, traceWalls, wakeEffects, type ErsConfig, type StrategyConfig, type PhysicsConfig, type SimContext, type SlipstreamConfig, type TrackJson, type WorldState } from './index';

const cfg = slipstreamJson as SlipstreamConfig;
const car = (x: number, y: number, heading = 0, v = 50) => ({ x, y, heading, vx: Math.sin(heading) * v, vy: -Math.cos(heading) * v, angVel: 0 });

describe('wake rules', () => {
  it('tows a car close behind, fading with distance, none beyond range or out of the wake', () => {
    // Heading 0 = up (-y): "behind" is +y.
    const at = (behind: number, side = 0, heading = 0) => wakeEffects([car(0, 0), car(side, behind, heading)], 2, cfg).tow[1]!;
    expect(at(8)).toBeGreaterThan(at(25));
    expect(at(25)).toBeGreaterThan(0);
    expect(at(8)).toBeLessThanOrEqual(cfg.tow.maxDragReduction);
    expect(at(cfg.tow.maxRangeM + 2)).toBe(0);
    expect(at(2)).toBe(0); // too close: not in range
    expect(at(10, 5)).toBe(0); // well off to the side
    expect(at(10, 0, (40 * Math.PI) / 180)).toBe(0); // pointing a different way
    expect(wakeEffects([car(0, 0), car(0, 10)], 2, cfg).tow[0]).toBe(0); // the leader gets nothing
  });

  it('never stacks: two cars ahead give the strongest single tow', () => {
    const one = wakeEffects([car(0, 0), car(0, 10)], 2, cfg).tow[1]!;
    const two = wakeEffects([car(0, 0), car(0, -10), car(0, 10)], 2, cfg).tow[2]!;
    expect(two).toBeCloseTo(one, 9);
  });

  it('dirty air only following closely while cornering', () => {
    const straight = wakeEffects([car(0, 0), car(0, 8)], 2, cfg).dirtyAir[1]!;
    const turning = wakeEffects([car(0, 0), { ...car(0, 8), angVel: 0.6 }], 2, cfg).dirtyAir[1]!;
    expect(straight).toBe(0);
    expect(turning).toBeGreaterThan(0);
    expect(turning).toBeLessThanOrEqual(cfg.dirtyAir.maxDownforceLoss);
  });
});

describe('two cars down a straight', () => {
  const PPM = 10;
  /** A 30 x 1500 m asphalt strip inside walls. */
  const strip = (slip: SlipstreamConfig): SimContext => {
    const w = 30 * PPM, h = 1500 * PPM, wall = PPM;
    const data = new Uint8Array(w * h);
    const id = (s: string) => surfaces.findIndex((x) => x.id === s);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = id(x < wall || y < wall || x >= w - wall || y >= h - wall ? 'wall' : 'asphalt');
    const json: TrackJson = { id: 'strip', name: 'strip', pxPerMeter: PPM, files: { mask: 'mask.png' }, timingLines: {}, racingLine: [], grid: [], spawn: { x: 150, y: h - 100, heading: 0 } };
    const track = createSimTrack(json, { width: w, height: h, data }, surfaces);
    return { track, walls: traceWalls(track.mask, track.index.wall, track.index.tyreBarrier, wallTracing), physics: structuredClone(physicsJson) as unknown as PhysicsConfig, catalog, rules, contact: contactJson, race: raceJson, slipstream: slip, assists: assistsJson, damage: damageJson, ers: ersJson as ErsConfig, evolution: { ...evolutionJson, enabled: false }, strategy: strategyJson as StrategyConfig, cache: createPhysicsCache() };
  };
  const run = (slip: SlipstreamConfig) => {
    const ctx = strip(slip);
    let w: WorldState = createWorld(ctx, 2);
    const start = (c: WorldState['cars'][number], y: number) => ({ ...c, x: 15, y, heading: 0, vx: 0, vy: -40 });
    w = { ...w, cars: [start(w.cars[0]!, 1400), start(w.cars[1]!, 1412)] };
    for (let t = 0; t < 60 * 4; t++) w = step(w, [{ throttle: 1, brake: 0, steer: 0 }, { throttle: 1, brake: 0, steer: 0 }], ctx);
    return w;
  };

  it('the follower in the tow gains speed and closes the gap; without the tow it does not', () => {
    const on = run(cfg), off = run({ ...cfg, tow: { ...cfg.tow, maxDragReduction: 0 } });
    expect(on.cars[1]!.tow).toBeGreaterThan(0.1);
    expect(on.cars[1]!.speed - on.cars[0]!.speed).toBeGreaterThan(0.5);
    expect(on.cars[1]!.y - on.cars[0]!.y).toBeLessThan(11.5);
    expect(off.cars[1]!.speed).toBeCloseTo(off.cars[0]!.speed, 3);
  });

  it('is deterministic', () => {
    const a = run(cfg), b = run(cfg);
    expect(a.cars).toEqual(b.cars);
  });
});
