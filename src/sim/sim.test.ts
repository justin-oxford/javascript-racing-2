// @vitest-environment node
// Guard for the "sim is pure" rule: /src/sim must run headless in Node, deterministically,
// with the track mask decoded in Node too.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTrackNode, simContextNode, surfaces } from '../../tools/load-track-node';
import { formatTrackJson } from '../client/editor/format';
import {
  createSimTrack,
  createWorld,
  polygonArea,
  resetCar,
  snapToPalette,
  step,
  surfaceAt,
  TICK_HZ,
  traceRegions,
  type CarInput,
  type WorldState,
} from './index';

const indiana = loadTrackNode('indiana');
const ctx = simContextNode(indiana.track);
const spawn = indiana.track.json.spawn;
const surfaceId = (i: number): string => surfaces[i]!.id;

/** Deterministic scripted driver: throttle, then a held turn, then brake. */
function scriptedInput(tick: number): CarInput {
  if (tick < 200) return { throttle: 1, brake: 0, steer: 0 };
  if (tick < 450) return { throttle: 0.7, brake: 0, steer: -1 };
  return { throttle: 0, brake: 1, steer: 0.5 };
}

function run(ticks: number): WorldState {
  let world = createWorld(ctx, 3);
  for (let t = 0; t < ticks; t++) {
    const input = scriptedInput(world.tick);
    world = step(world, [input, { ...input, steer: -input.steer }], ctx);
  }
  return world;
}

describe('sim (headless, Node)', () => {
  it('is running in Node with no DOM', () => {
    expect(typeof (globalThis as Record<string, unknown>).window).toBe('undefined');
    expect(typeof (globalThis as Record<string, unknown>).document).toBe('undefined');
  });

  it('steps 600 ticks (10 s at 60 Hz) on Indiana and the car moves', () => {
    const world = run(600);
    expect(TICK_HZ).toBe(60);
    expect(world.tick).toBe(600);
    const car = world.cars[0]!;
    for (const v of [car.x, car.y, car.heading, car.speed]) expect(Number.isFinite(v)).toBe(true);
    expect(Math.hypot(car.x - spawn.x, car.y - spawn.y)).toBeGreaterThan(50);
    // Car 2 had no input: it never moves.
    expect(world.cars[2]).toMatchObject({ ...spawn, speed: 0 });
  });

  it('is deterministic', () => {
    expect(run(600)).toEqual(run(600));
  });

  it('state is plain serializable data', () => {
    const world = run(600);
    expect(JSON.parse(JSON.stringify(world))).toEqual(world);
  });

  it('step and resetCar never mutate their input', () => {
    const before = createWorld(ctx, 1);
    const snapshot = structuredClone(before);
    step(before, [{ throttle: 1, brake: 0, steer: 1 }], ctx);
    resetCar(before, 0, spawn, ctx);
    expect(before).toEqual(snapshot);
  });

  it('source contains no non-deterministic or browser-only calls', () => {
    const banned = /\b(Date\.now|Math\.random|performance\.now|requestAnimationFrame|setTimeout|setInterval|window|document|localStorage|console)\b/;
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const files = walk(dirname(fileURLToPath(import.meta.url))).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const code = readFileSync(f, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
      expect(code, `${f} breaks the pure-sim rule`).not.toMatch(banned);
    }
  });
});

describe('Indiana track (mask decoded in Node)', () => {
  const { track, walls } = indiana;

  it('loads mask + track.json at matching size', () => {
    expect(track.mask.width).toBe(1280);
    expect(track.mask.height).toBe(566);
    expect(track.mask.data.length).toBe(1280 * 566);
    expect(indiana.offPalette).toBe(0); // the draft is written straight from the palette
  });

  it('spawn is in the pit box, grid slots and timing line ends are on legal track', () => {
    expect(surfaceId(surfaceAt(track, spawn.x, spawn.y))).toBe('pitBox');
    expect(createWorld(ctx).cars[0]!.inPitBox).toBe(true);
    expect(track.json.grid).toHaveLength(10);
    for (const g of track.json.grid) expect(surfaces[surfaceAt(track, g.x, g.y)]!.legal).toBe(true);
    for (const line of Object.values(track.json.timingLines))
      for (const p of [line.a, line.b]) expect(surfaceId(surfaceAt(track, p.x, p.y))).not.toBe('outOfBounds');
  });

  it('pit lane limits speed', () => {
    let world = createWorld(ctx);
    // 1 s of full throttle from the pit box: enough to hit the limiter, not enough to leave the pit lane.
    for (let t = 0; t < 60; t++) world = step(world, [{ throttle: 1, brake: 0, steer: 0 }], ctx);
    const car = world.cars[0]!;
    expect(car.inPitLane).toBe(true);
    const limit = (ctx.rules.pitSpeedLimitKph / 3.6) * track.json.pxPerMeter;
    expect(car.speed).toBeCloseTo(limit, 5);
  });

  it('traces walls', () => {
    expect(walls.length).toBeGreaterThan(5);
    for (const w of walls) expect(w.points.length % 2).toBe(0);
    // The biggest outline is the outer wall: it should span most of the image.
    const biggest = walls.reduce((a, b) => (Math.abs(polygonArea(a.points)) > Math.abs(polygonArea(b.points)) ? a : b));
    const xs = biggest.points.filter((_, i) => i % 2 === 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1200);
  });

  it('track.json round-trips through the editor formatter byte for byte', () => {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../tracks/indiana/track.json'), 'utf8');
    expect(formatTrackJson(JSON.parse(text))).toBe(text);
  });
});

describe('mask helpers', () => {
  it('snaps off-palette and anti-aliased pixels to the nearest colour and counts them', () => {
    // 4 pixels: exact asphalt, near-grass, anti-aliased wall/asphalt edge, transparent.
    const rgba = [128, 128, 128, 255, 10, 240, 12, 255, 40, 40, 40, 255, 0, 0, 0, 0];
    const { mask, offPalette } = snapToPalette(rgba, 4, 1, surfaces);
    expect([...mask.data].map(surfaceId)).toEqual(['asphalt', 'grass', 'wall', 'outOfBounds']);
    expect(offPalette).toBe(3);
  });

  it('traces a filled square into a 4-corner outline and keeps holes', () => {
    // 6x6 wall block with a 2x2 hole in the middle, inside an 8x8 asphalt image.
    const w = 8, h = 8;
    const data = new Uint8Array(w * h);
    for (let y = 1; y < 7; y++) for (let x = 1; x < 7; x++) data[y * w + x] = 4;
    for (let y = 3; y < 5; y++) for (let x = 3; x < 5; x++) data[y * w + x] = 0;
    const track = createSimTrack(indiana.track.json, { width: w, height: h, data }, surfaces);
    const loops = traceRegions(track.mask, new Set([4]), { simplifyTolerancePx: 0.5, minLoopAreaPx: 1 });
    const areas = loops.map(polygonArea).sort((a, b) => a - b);
    expect(loops.map((l) => l.length / 2)).toEqual([4, 4]);
    expect(areas).toEqual([-4, 36]); // hole winds the other way
  });
});
