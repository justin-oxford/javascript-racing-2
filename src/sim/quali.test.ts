// @vitest-environment node
// Qualifying (race weekend): the session rules on their own, then a short session on Oxford with AI,
// and a race started on the grid it produced. Full field: `npm run quali-probe`.
import { describe, expect, it } from 'vitest';
import aiJson from '../../tools/fixtures/ai-baseline.json';
import contactJson from '../../tools/fixtures/contact-baseline.json';
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import slipstreamJson from '../../tools/fixtures/slipstream-baseline.json';
import raceJson from '../../config/race.json';
import { catalog, loadTrackNode, simContextNode } from '../../tools/load-track-node';
import {
  aiInputSource,
  buildRacingLine,
  createQualiWorld,
  createRaceWorld,
  newQualiState,
  pitQueuePoses,
  pointsFor,
  qualiHolds,
  retireFromQuali,
  step,
  updateQuali,
  type AiConfig,
  type CarState,
  type PhysicsConfig,
  type QualiState,
  type RaceConfig,
  type SimContext,
  type SimEvent,
  type WorldState,
} from './index';

const race: RaceConfig = { ...raceJson, qualiSec: 90, qualiReleaseGapSec: 3, finishTimeoutSec: 40 };

describe('session rules', () => {
  const dt = 1 / 60;
  const car = (over: Partial<CarState['timing']> = {}, inPitLane = false) => ({ inPitLane, timing: { started: true, lapInvalid: false, ...over } }) as unknown as CarState;
  const lap = (c: number, time: number, invalid = false): SimEvent => ({ type: 'lap', car: c, time, invalid }) as SimEvent;

  it('player free at once, the others released one by one, seeded', () => {
    const q = newQualiState(5, 42, race, 60);
    expect(q.cars[0]!.releaseTick).toBe(0);
    const ticks = q.cars.slice(1).map((c) => c.releaseTick).sort((a, b) => a - b);
    expect(ticks).toEqual([180, 360, 540, 720]);
    expect(newQualiState(5, 42, race, 60)).toEqual(q);
    expect(qualiHolds(q, 1, q.cars[1]!.releaseTick - 1)).toBe(true);
    expect(qualiHolds(q, 1, q.cars[1]!.releaseTick)).toBe(false);
  });

  it('best valid lap sets the order; no time goes last', () => {
    let q: QualiState = newQualiState(3, 1, race, 60);
    const cars = [car(), car(), car()];
    q = updateQuali(q, 10, dt, cars, [], [lap(0, 31), lap(2, 30.5), lap(1, 29, true)], race);
    q = updateQuali(q, 11, dt, cars, [], [lap(0, 30.2)], race);
    expect(q.order).toEqual([0, 2, 1]);
    expect(q.cars[0]).toMatchObject({ bestLap: 30.2, laps: 2 });
    expect(q.cars[1]!.bestLap).toBe(0);
  });

  it('at the flag a car on a timed lap may finish it; the rest are done; then results', () => {
    let q: QualiState = newQualiState(3, 1, race, 60);
    const cars = [car(), car({ lapInvalid: true }), car({}, true)];
    q = updateQuali(q, 60 * 90, dt, cars, [], [], race);
    expect(q.phase).toBe('flag');
    expect(q.cars.map((c) => c.done)).toEqual([false, true, true]);
    q = updateQuali(q, 60 * 90 + 100, dt, cars, [], [lap(0, 29.9), lap(1, 20)], race); // car 1 was already done
    expect(q.cars[0]).toMatchObject({ bestLap: 29.9, done: true });
    expect(q.cars[1]!.bestLap).toBe(0);
    q = updateQuali(q, 60 * 90 + 101, dt, cars, [], [], race);
    expect(q.phase).toBe('results');
  });

  it('points table', () => {
    expect([1, 2, 10, 11].map((p) => pointsFor(p, race.points))).toEqual([25, 18, 1, 0]);
  });
});

describe('a session on Oxford', () => {
  const loaded = loadTrackNode('oxford');
  const ctx: SimContext = { ...simContextNode(loaded, structuredClone(physicsJson as unknown as PhysicsConfig)), contact: contactJson, race, slipstream: slipstreamJson };
  const line = buildRacingLine(loaded.track)!;
  // Frozen AI config, plus what it predates: the qualifying pit threshold (config/ai.json pits.qualiFuelLaps)
  // and the reset-to-track fallback (recovery.resetAfterSec: a car beached on the frozen physics resets).
  const frozen = aiJson as unknown as AiConfig;
  const cfg: AiConfig = { ...frozen, pits: { ...frozen.pits!, qualiFuelLaps: 1.3 }, recovery: { ...frozen.recovery, resetAfterSec: 8 } };
  const builds = [0, 1, 2, 3].map((i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id }));
  const run = () => {
    let w: WorldState = createQualiWorld(ctx, builds, 3, pitQueuePoses(line, builds.length, ctx.track.json.pxPerMeter)!);
    const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => ({ ...cfg.presets[cfg.defaultPreset]!, mistakesPerMin: 0 }), () => cfg, 50 + i));
    let contact = 0;
    for (let t = 0; t < 60 * 200 && w.quali!.phase !== 'results'; t++) {
      w = step(w, ai.map((d) => d.read(w.tick)), ctx);
      if (w.cars.some((c) => c.carContact && c.inPitLane)) contact++;
    }
    return { w, contact };
  };

  it('everyone leaves the queue cleanly, sets a time, and the session ends', () => {
    const { w, contact } = run();
    expect(w.quali!.phase).toBe('results');
    expect(contact).toBe(0);
    // Everyone gets out of the queue and round; most set a valid time (frozen physics is loose: a car
    // can lose its only flying lap to an off).
    expect(w.cars.every((c) => c.timing.laps >= 1)).toBe(true);
    const timed = w.quali!.cars.filter((c) => c.bestLap > 20 && c.bestLap < 60);
    // At least half the field: on the frozen physics the 4-car session is chaotic enough that a rounding-level
    // change (e.g. the setup overhaul's per-axle aero, identical at neutral to 1e-8 m) costs a car its flying lap.
    expect(timed.length).toBeGreaterThanOrEqual(2);
    const times = w.quali!.order.map((i) => w.quali!.cars[i]!.bestLap).filter((t) => t > 0);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  }, 60_000);

  it('is deterministic', () => {
    expect(run().w.quali).toEqual(run().w.quali);
  }, 60_000);

  it('retiring parks the car and holds it; its time stands', () => {
    let w: WorldState = createQualiWorld(ctx, builds, 3, pitQueuePoses(line, builds.length, ctx.track.json.pxPerMeter)!);
    w = { ...w, quali: { ...w.quali!, cars: w.quali!.cars.map((c, i) => (i === 0 ? { ...c, bestLap: 29.5, laps: 1 } : c)) } };
    w = retireFromQuali(w, 0, ctx.track.json.spawn, ctx);
    for (let t = 0; t < 60; t++) w = step(w, [{ throttle: 1, brake: 0, steer: 0 }], ctx);
    expect(Math.hypot(w.cars[0]!.vx, w.cars[0]!.vy)).toBeLessThan(0.01);
    expect(w.quali!.cars[0]).toMatchObject({ retired: true, done: true, bestLap: 29.5 });
  });

  it('runs light: everyone starts on the qualifying fuel load, and the pits only top back up to it', () => {
    let w: WorldState = createQualiWorld(ctx, builds, 3, pitQueuePoses(line, builds.length, ctx.track.json.pxPerMeter)!);
    expect(w.cars.every((c) => c.fuelKg === race.qualiFuelKg)).toBe(true);
    const box = ctx.track.boxes[0]!, ppm = ctx.track.json.pxPerMeter;
    w = { ...w, cars: w.cars.map((c, i) => (i === 0 ? { ...c, x: box.x / ppm, y: box.y / ppm, vx: 0, vy: 0, fuelKg: 5 } : c)) };
    for (let t = 0; t < 60 * 5; t++) w = step(w, [], ctx);
    expect(w.cars[0]!.fuelKg).toBeCloseTo(race.qualiFuelKg, 5);
  });

  it('the race starts on the qualifying grid', () => {
    const grid = [2, 0, 3, 1];
    const r = createRaceWorld(ctx, builds, { laps: 3, seed: 9, grid }).race!;
    expect(r.order).toEqual(grid);
    expect(grid.map((car) => r.cars[car]!.slot)).toEqual([0, 1, 2, 3]);
  });
});
