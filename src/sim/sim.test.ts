// @vitest-environment node
// Guard for the "sim is pure" rule: /src/sim must run headless in Node, deterministically.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import kinematics from '../../config/placeholder-kinematics.json';
import indiana from '../../tracks/indiana.json';
import { createWorld, resetCar, step, TICK_HZ, type CarInput, type TrackData, type WorldState } from './index';

const track: TrackData = indiana;

/** Deterministic scripted driver: throttle, then a held right turn, then brake. */
function scriptedInput(tick: number): CarInput {
  if (tick < 200) return { throttle: 1, brake: 0, steer: 0 };
  if (tick < 450) return { throttle: 0.7, brake: 0, steer: 1 };
  return { throttle: 0, brake: 1, steer: -0.5 };
}

function run(ticks: number): WorldState {
  let world = createWorld(track, 3);
  for (let t = 0; t < ticks; t++) {
    const input = scriptedInput(world.tick);
    world = step(world, [input, { ...input, steer: -input.steer }], kinematics);
  }
  return world;
}

describe('sim (headless, Node)', () => {
  it('is running in Node with no DOM', () => {
    expect(typeof (globalThis as Record<string, unknown>).window).toBe('undefined');
    expect(typeof (globalThis as Record<string, unknown>).document).toBe('undefined');
  });

  it('steps 600 ticks (10 s at 60 Hz) and the car moves', () => {
    const world = run(600);
    expect(TICK_HZ).toBe(60);
    expect(world.tick).toBe(600);
    const car = world.cars[0]!;
    for (const v of [car.x, car.y, car.heading, car.speed]) expect(Number.isFinite(v)).toBe(true);
    const moved = Math.hypot(car.x - track.spawn.x, car.y - track.spawn.y);
    expect(moved).toBeGreaterThan(50);
    // Car 2 had no input: it never moves.
    expect(world.cars[2]).toEqual({ ...track.spawn, speed: 0 });
  });

  it('is deterministic', () => {
    expect(run(600)).toEqual(run(600));
  });

  it('state is plain serializable data', () => {
    const world = run(600);
    expect(JSON.parse(JSON.stringify(world))).toEqual(world);
  });

  it('step and resetCar never mutate their input', () => {
    const before = createWorld(track, 1);
    const snapshot = structuredClone(before);
    step(before, [{ throttle: 1, brake: 0, steer: 1 }], kinematics);
    resetCar(before, 0, track.spawn);
    expect(before).toEqual(snapshot);
  });

  it('source contains no non-deterministic or browser-only calls', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const banned = /\b(Date\.now|Math\.random|performance\.now|requestAnimationFrame|setTimeout|setInterval|window|document|localStorage)\b/;
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const code = readFileSync(join(dir, f), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
      expect(code, `${f} breaks the pure-sim rule`).not.toMatch(banned);
    }
  });
});
