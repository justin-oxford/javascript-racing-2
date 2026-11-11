// @vitest-environment node
// Guard for the "sim is pure" rule: /src/sim must run headless in Node, deterministically,
// with the track mask decoded in Node too. Also: Planck is a rebuildable cache (rebuild-drift test).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultTrackIdNode, loadTrackNode, simContextNode, surfaces } from '../../tools/load-track-node';
import { formatTrackJson } from '../client/editor/format';
import trackDefaults from '../../config/track-defaults.json';
import {
  completeTrackJson,
  createSimTrack,
  createWorld,
  defaultTrackId,
  playerTracks,
  stubTrackJson,
  type TrackDefaults,
  polygonArea,
  resetCar,
  snapToPalette,
  step,
  surfaceAt,
  TICK_HZ,
  traceRegions,
  type CarInput,
  type SimContext,
  type WorldState,
} from './index';

const here = dirname(fileURLToPath(import.meta.url));
const surfaceId = (i: number): string => surfaces[i]!.id;

/** Deterministic scripted driver: launch, a held right turn (into the pit wall on Indiana), then mixed. */
function scriptedInput(tick: number): CarInput {
  if (tick < 90) return { throttle: 1, brake: 0, steer: 0 };
  if (tick < 250) return { throttle: 0.8, brake: 0, steer: 1 };
  if (tick < 400) return { throttle: 0, brake: 1, steer: -0.6 };
  return { throttle: 1, brake: 0, steer: -1 };
}

function run(ctx: SimContext, from: WorldState, ticks: number): WorldState {
  let world = from;
  for (let t = 0; t < ticks; t++) world = step(world, [scriptedInput(world.tick)], ctx);
  return world;
}

describe('sim (headless, Node, default track)', () => {
  const loaded = loadTrackNode(defaultTrackIdNode());
  const spawnM = () => {
    const { spawn, pxPerMeter } = loaded.track.json;
    return { x: spawn.x / pxPerMeter, y: spawn.y / pxPerMeter };
  };

  it('is running in Node with no DOM', () => {
    expect(typeof (globalThis as Record<string, unknown>).window).toBe('undefined');
    expect(typeof (globalThis as Record<string, unknown>).document).toBe('undefined');
  });

  it('steps 600 ticks (10 s at 60 Hz) and the car moves', () => {
    const ctx = simContextNode(loaded);
    const world = run(ctx, createWorld(ctx), 600);
    expect(TICK_HZ).toBe(60);
    expect(world.tick).toBe(600);
    const car = world.cars[0]!;
    for (const v of [car.x, car.y, car.heading, car.vx, car.vy, car.angVel]) expect(Number.isFinite(v)).toBe(true);
    expect(Math.hypot(car.x - spawnM().x, car.y - spawnM().y)).toBeGreaterThan(5);
  });

  it('a car with no input stays put (Indiana: needs a grid so car 2 has a clear slot)', () => {
    const ctx = simContextNode(loadTrackNode('indiana'));
    let world = createWorld(ctx, 2);
    const start = { ...world.cars[1]! };
    for (let t = 0; t < 120; t++) world = step(world, [], ctx);
    expect(Math.hypot(world.cars[1]!.x - start.x, world.cars[1]!.y - start.y)).toBeLessThan(1e-6);
  });

  it('is deterministic', () => {
    const a = simContextNode(loaded), b = simContextNode(loaded);
    expect(run(a, createWorld(a), 600)).toEqual(run(b, createWorld(b), 600));
  });

  it('state is plain serializable data', () => {
    const ctx = simContextNode(loaded);
    const world = run(ctx, createWorld(ctx), 300);
    expect(JSON.parse(JSON.stringify(world))).toEqual(world);
  });

  it('step and resetCar never mutate their input', () => {
    const ctx = simContextNode(loaded);
    const before = createWorld(ctx, 1);
    const snapshot = structuredClone(before);
    step(before, [{ throttle: 1, brake: 0, steer: 1 }], ctx);
    resetCar(before, 0, loaded.track.json.spawn, ctx);
    expect(before).toEqual(snapshot);
  });

  it('rebuilding Planck from the tick-300 plain state stays on the continuous run', () => {
    const cont = simContextNode(loaded);
    let world = createWorld(cont);
    let at300: WorldState | undefined;
    for (let t = 0; t < 600; t++) {
      world = step(world, [scriptedInput(world.tick)], cont);
      if (world.tick === 300) at300 = JSON.parse(JSON.stringify(world)) as WorldState; // plain data only
    }
    const rebuilt = simContextNode(loaded); // brand-new Planck world
    const replay = run(rebuilt, at300!, 300);
    const a = world.cars[0]!, b = replay.cars[0]!;
    const posDrift = Math.hypot(a.x - b.x, a.y - b.y);
    const velDrift = Math.hypot(a.vx - b.vx, a.vy - b.vy);
    const headingDrift = Math.abs(a.heading - b.heading);
    console.log(`[rebuild drift @600 after rebuild @300] position ${posDrift.toExponential(2)} m, velocity ${velDrift.toExponential(2)} m/s, heading ${headingDrift.toExponential(2)} rad`);
    expect(replay.tick).toBe(600);
    expect(posDrift).toBe(0); // cars are rebuilt from plain state every tick, so rebuild = continuous
  });

  it('rewinding a used cache to an older state matches a fresh rebuild exactly', () => {
    const ctx = simContextNode(loaded);
    const start = createWorld(ctx);
    const mid = run(ctx, start, 300);
    run(ctx, mid, 200); // move the cache on...
    const fromUsed = run(ctx, mid, 100); // ...then rewind it to tick 300
    const fresh = simContextNode(loaded);
    expect(fromUsed).toEqual(run(fresh, mid, 100));
  });

  it('source contains no non-deterministic or browser-only calls', () => {
    const banned = /\b(Date\.now|Math\.random|performance\.now|requestAnimationFrame|setTimeout|setInterval|window|document|localStorage|console)\b/;
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const files = walk(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const code = readFileSync(f, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
      expect(code, `${f} breaks the pure-sim rule`).not.toMatch(banned);
    }
  });
});

describe('Indiana fixture (known layout; mask decoded in Node)', () => {
  const indiana = loadTrackNode('indiana');
  const { track, walls } = indiana;
  const spawn = track.json.spawn;

  it('is flagged as a fixture', () => {
    expect(track.json.fixture).toBe(true);
  });

  it('loads mask + track.json at matching size', () => {
    expect(track.mask.width).toBe(1280);
    expect(track.mask.height).toBe(566);
    expect(indiana.offPalette).toBe(0); // the draft is written straight from the palette
  });

  it('spawn is in the pit box, grid slots and timing line ends are on legal track', () => {
    const ctx = simContextNode(indiana);
    expect(surfaceId(surfaceAt(track, spawn.x, spawn.y))).toBe('pitBox');
    expect(createWorld(ctx).cars[0]!.inPitBox).toBe(true);
    expect(track.json.grid).toHaveLength(10);
    for (const g of track.json.grid) expect(surfaces[surfaceAt(track, g.x, g.y)]!.legal).toBe(true);
    for (const line of Object.values(track.json.timingLines))
      for (const p of [line.a, line.b]) expect(surfaceId(surfaceAt(track, p.x, p.y))).not.toBe('outOfBounds');
  });

  it('pit lane limits speed', () => {
    const ctx = simContextNode(indiana);
    let world = createWorld(ctx);
    let top = 0;
    for (let t = 0; t < 150; t++) {
      world = step(world, [{ throttle: 1, brake: 0, steer: 0 }], ctx);
      top = Math.max(top, world.cars[0]!.speed);
    }
    const limit = ctx.rules.pitSpeedLimitKph / 3.6;
    expect(world.cars[0]!.inPitLane).toBe(true);
    expect(top).toBeLessThanOrEqual(limit + 0.3);
    expect(top).toBeGreaterThan(limit - 2);
  });

  it('traces walls', () => {
    expect(walls.length).toBeGreaterThan(5);
    const biggest = walls.reduce((a, b) => (Math.abs(polygonArea(a.points)) > Math.abs(polygonArea(b.points)) ? a : b));
    const xs = biggest.points.filter((_, i) => i % 2 === 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1200);
  });

  it('track.json round-trips through the editor formatter byte for byte', () => {
    const text = readFileSync(join(here, '../../tracks/indiana/track.json'), 'utf8');
    expect(formatTrackJson(JSON.parse(text))).toBe(text);
  });
});

describe('mask helpers', () => {
  it('snaps off-palette and anti-aliased pixels to the nearest colour and counts them', () => {
    const rgba = [128, 128, 128, 255, 10, 240, 12, 255, 40, 40, 40, 255, 0, 0, 0, 0];
    const { mask, offPalette } = snapToPalette(rgba, 4, 1, surfaces);
    expect([...mask.data].map(surfaceId)).toEqual(['asphalt', 'grass', 'wall', 'outOfBounds']);
    expect(offPalette).toBe(3);
  });

  it('traces a filled square into a 4-corner outline and keeps holes', () => {
    const w = 8, h = 8;
    const data = new Uint8Array(w * h);
    for (let y = 1; y < 7; y++) for (let x = 1; x < 7; x++) data[y * w + x] = 4;
    for (let y = 3; y < 5; y++) for (let x = 3; x < 5; x++) data[y * w + x] = 0;
    const json = loadTrackNode('indiana').track.json;
    const track = createSimTrack(json, { width: w, height: h, data }, surfaces);
    const loops = traceRegions(track.mask, new Set([4]), { simplifyTolerancePx: 0.5, minLoopAreaPx: 1 });
    expect(loops.map((l) => l.length / 2)).toEqual([4, 4]);
    expect(loops.map(polygonArea).sort((a, b) => a - b)).toEqual([-4, 36]); // hole winds the other way
  });
});

describe('track list + authored tracks (SYS - Track authoring spec)', () => {
  it('the first authored track is the default; Indiana only when nothing else exists; fixtures never player-facing', () => {
    const indiana = { id: 'indiana', fixture: true };
    expect(defaultTrackId([indiana])).toBe('indiana');
    expect(defaultTrackId([indiana, { id: 'monza-ish', fixture: false }])).toBe('monza-ish');
    expect(playerTracks([indiana, { id: 'a', fixture: false }]).map((t) => t.id)).toEqual(['a']);
  });

  it('a mask-only folder (blockout stage) gets defaults: scale, files, empty lines, spawn in the pit box', () => {
    const w = 100, h = 60;
    const data = new Uint8Array(w * h).fill(surfaces.findIndex((s) => s.id === 'asphalt'));
    const pitBox = surfaces.findIndex((s) => s.id === 'pitBox');
    for (let y = 40; y < 50; y++) for (let x = 70; x < 80; x++) data[y * w + x] = pitBox;
    const json = completeTrackJson(stubTrackJson('blockout', trackDefaults as TrackDefaults), { width: w, height: h, data }, surfaces, trackDefaults as TrackDefaults);
    expect(json).toMatchObject({ id: 'blockout', name: 'blockout', pxPerMeter: trackDefaults.pxPerMeter, timingLines: {}, racingLine: [], grid: [] });
    expect(json.files).toEqual(trackDefaults.files);
    expect(json.spawn).toEqual({ x: 75.5, y: 45.5, heading: 0 }); // middle of the pit box (rounded centroid), not its edge
  });

  it('completing an already-complete track.json changes nothing (lossless editor export)', () => {
    const text = readFileSync(join(here, '../../tracks/indiana/track.json'), 'utf8');
    const { track } = loadTrackNode('indiana');
    expect(formatTrackJson(completeTrackJson(JSON.parse(text), track.mask, surfaces, trackDefaults as TrackDefaults))).toBe(text);
  });
});
