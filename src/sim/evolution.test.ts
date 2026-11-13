// @vitest-environment node
// Track evolution (POLISH card): rubber where the wheels run, marbles thrown to the outside and swept,
// grip from both, carried between sessions, deterministic and rebuildable from a JSON snapshot.
import { describe, expect, it } from 'vitest';
import aiJson from '../../tools/fixtures/ai-baseline.json';
import contactJson from '../../tools/fixtures/contact-baseline.json';
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import slipstreamJson from '../../tools/fixtures/slipstream-baseline.json';
import raceJson from '../../config/race.json';
import { catalog, loadTrackNode, simContextNode } from '../../tools/load-track-node';
import {
  aiInputSource, buildRacingLine, createPhysicsCache, createWorld, evolutionGrip, nextSession, newSurfaceGrid, seedRubber, step, surfaceAtPoint, updateSurface,
  type AiConfig, type PhysicsConfig, type RaceConfig, type SimContext, type SurfaceGrid, type WheelWork, type WorldState,
} from './index';

const loaded = loadTrackNode('oxford');
const ctx: SimContext = { ...simContextNode(loaded, structuredClone(physicsJson as PhysicsConfig)), contact: contactJson, race: raceJson as RaceConfig, slipstream: slipstreamJson };
const cfg = ctx.evolution;
const line = buildRacingLine(ctx.track)!;
const ppm = ctx.track.json.pxPerMeter;
// A point on the racing line (on track), metres.
const onLine = { x: line.x[40]!, y: line.y[40]!, heading: Math.atan2(line.x[41]! - line.x[40]!, -(line.y[41]! - line.y[40]!)) };
const wheel = (over: Partial<WheelWork> = {}): WheelWork => ({ x: onLine.x, y: onLine.y, load: 1, usage: 0.5, wear: 0, outX: 1, outY: 0, corner: 0, moving: true, ...over });

describe('the surface grid', () => {
  it('covers the track; a session starts green', () => {
    const g = newSurfaceGrid(ctx.track, cfg);
    expect(g.w * g.cellM).toBeGreaterThanOrEqual(ctx.track.mask.width / ppm);
    expect(g.rubber.every((r) => r === 0) && g.marbles.every((m) => m === 0)).toBe(true);
    expect(createWorld(ctx, 1).surface).toEqual(g);
    expect(createWorld({ ...ctx, evolution: { ...cfg, enabled: false } }, 1).surface).toBeUndefined();
  });

  it('a running wheel lays rubber (more when loaded and working); a parked one lays none', () => {
    const g = newSurfaceGrid(ctx.track, cfg);
    const after = (w: WheelWork) => surfaceAtPoint(updateSurface(g, ctx.track, [w], 1, cfg), w.x, w.y).rubber;
    expect(after(wheel())).toBeGreaterThan(0);
    expect(after(wheel({ load: 1.8, usage: 1 }))).toBeGreaterThan(after(wheel()));
    expect(after(wheel({ moving: false }))).toBe(0);
  });

  it('worn tyre lands to the outside as marbles; wheels running over them sweep them', () => {
    // Whichever side of the line is still track 6 m out (marbles only collect on the racing surface).
    const shed = (sg: number) => {
      const out = { x: Math.cos(onLine.heading) * sg, y: Math.sin(onLine.heading) * sg };
      return { out, g: updateSurface(newSurfaceGrid(ctx.track, cfg), ctx.track, [wheel({ wear: 0.01, outX: out.x, outY: out.y, corner: 1 })], 1 / 60, cfg) };
    };
    const tries = [shed(1), shed(-1)];
    const hit = tries.find((t) => t.g.marbles.some((m) => m > 0))!;
    expect(hit).toBeDefined();
    let g = hit.g;
    const out = hit.out;
    const landed = { x: onLine.x + out.x * cfg.marbles.throwM, y: onLine.y + out.y * cfg.marbles.throwM };
    const m0 = surfaceAtPoint(g, landed.x, landed.y).marbles;
    expect(m0).toBeGreaterThan(0);
    expect(surfaceAtPoint(g, onLine.x, onLine.y).marbles).toBeLessThan(m0);
    // Grip there is down by up to gripLoss.
    expect(evolutionGrip(g, landed.x, landed.y, cfg)).toBeLessThan(1);
    // Drive over them for a while: swept.
    for (let t = 0; t < 600; t++) g = updateSurface(g, ctx.track, [wheel({ x: landed.x, y: landed.y })], 1 / 60, cfg);
    expect(surfaceAtPoint(g, landed.x, landed.y).marbles).toBeLessThan(m0 * 0.5);
  });

  it('grip: full rubber +gripBonus, full marbles -gripLoss, off by default when disabled', () => {
    const g = newSurfaceGrid(ctx.track, cfg);
    const full = (layer: 'rubber' | 'marbles'): SurfaceGrid => ({ ...g, [layer]: g[layer].map(() => 1) });
    expect(evolutionGrip(full('rubber'), onLine.x, onLine.y, cfg)).toBeCloseTo(1 + cfg.rubber.gripBonus, 6);
    expect(evolutionGrip(full('marbles'), onLine.x, onLine.y, cfg)).toBeCloseTo(1 - cfg.marbles.gripLoss, 6);
    expect(evolutionGrip(full('rubber'), onLine.x, onLine.y, { ...cfg, enabled: false })).toBe(1);
  });

  it('between sessions: marbles swept, rubber kept minus rubberLoss; a rubbered start is rubbered along the line only', () => {
    const g = { ...newSurfaceGrid(ctx.track, cfg) };
    const used: SurfaceGrid = { ...g, rubber: g.rubber.map(() => 0.5), marbles: g.marbles.map(() => 0.4) };
    const next = nextSession(used, cfg);
    expect(next.marbles.every((m) => m === 0)).toBe(true);
    expect(next.rubber[0]).toBeCloseTo(0.5 * (1 - cfg.sessions.rubberLoss), 9);
    const seeded = seedRubber(g, ctx.track, ctx.track.json.racingLine, 'rubbered', cfg);
    expect(surfaceAtPoint(seeded, onLine.x, onLine.y).rubber).toBeGreaterThan(cfg.start.rubbered * 0.6);
    expect(seeded.rubber.filter((r) => r > 0).length).toBeLessThan(g.rubber.length * 0.25); // a line, not the whole map
    expect(seedRubber(g, ctx.track, ctx.track.json.racingLine, 'green', cfg)).toBe(g);
  });

  it('AI laps rubber in the line; deterministic; a run rebuilt from a JSON snapshot carries on identically', () => {
    const builds = [0, 1, 2].map((i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id }));
    const aiCfg = aiJson as unknown as AiConfig;
    const run = (w0: WorldState, ticks: number, c: SimContext) => {
      let w = w0;
      const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx: c, line }), () => ({ ...aiCfg.presets[aiCfg.defaultPreset]!, mistakesPerMin: 0 }), () => aiCfg, 30 + i));
      for (let t = 0; t < ticks; t++) w = step(w, ai.map((d) => d.read(w.tick)), c);
      return w;
    };
    const a = run(createWorld(ctx, builds), 60 * 40, ctx);
    expect(Math.max(...a.surface!.rubber)).toBeGreaterThan(0.05);
    expect(run(createWorld(ctx, builds), 60 * 40, ctx).surface).toEqual(a.surface);
    // Rebuild: JSON-clone the world mid-run into a fresh physics cache; the surface survives and evolves the same.
    const snap = JSON.parse(JSON.stringify(a)) as WorldState;
    const c2 = { ...ctx, cache: createPhysicsCache() };
    const step1 = (w: WorldState, c: SimContext) => step(w, w.cars.map(() => ({ throttle: 0.5, brake: 0, steer: 0 })), c);
    expect(step1(snap, c2).surface).toEqual(step1(a, ctx).surface);
  }, 60_000);
});
