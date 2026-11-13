// @vitest-environment node
// AI racecraft (POLISH card): corners, the INSIDE line, only-faster EXIT lines, the mode rules, and a race
// with racecraft on (deterministic, leaders mostly MANAGE, nobody stuck).
import { describe, expect, it } from 'vitest';
import aiJson from '../../config/ai.json';
import contactJson from '../../tools/fixtures/contact-baseline.json';
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import slipstreamJson from '../../tools/fixtures/slipstream-baseline.json';
import raceJson from '../../config/race.json';
import { catalog, loadTrackNode, simContextNode } from '../../tools/load-track-node';
import {
  aiInputSource, buildRacingLine, chooseMode, cornersOf, createRaceWorld, keepGoodExits, lineFor, lineOffsets, step,
  type AiConfig, type PhysicsConfig, type RaceConfig, type SimContext, type WorldState,
} from './index';

const loaded = loadTrackNode('oxford');
const ctx: SimContext = { ...simContextNode(loaded, structuredClone(physicsJson as unknown as PhysicsConfig)), contact: contactJson, race: raceJson as RaceConfig, slipstream: slipstreamJson };
const line = buildRacingLine(ctx.track)!;
const cfg = (aiJson as unknown as AiConfig).racecraft!;

describe('racecraft lines', () => {
  it('finds the corners; INSIDE goes toward the inside of each, within the track', () => {
    const corners = cornersOf(line);
    expect(corners.length).toBeGreaterThanOrEqual(5);
    const o = lineOffsets(line, cfg, ctx.physics.car.widthM / 2);
    expect(corners.some((c) => o.inside[c.apex] !== 0)).toBe(true);
    for (const c of corners) {
      const v = o.inside[c.apex]!;
      // + = right; 0 where the racing line already clips the apex (no room further in).
      expect([0, c.dir === 'R' ? 1 : -1]).toContain(Math.sign(v));
      expect(Math.abs(v)).toBeLessThanOrEqual(cfg.insideM + 1e-9);
      const room = v > 0 ? line.right[c.apex]! : line.left[c.apex]!;
      expect(Math.abs(v)).toBeLessThanOrEqual(Math.max(0, room - ctx.physics.car.widthM / 2 - cfg.edgeM) + 1e-9);
    }
  });

  it('keeps an EXIT line only where it is faster onto the straight', () => {
    const o = lineOffsets(line, cfg, 1);
    const n = line.n, flat = new Float64Array(n).fill(50);
    const faster = Float64Array.from(flat, (v) => v + 5), slower = Float64Array.from(flat, (v) => v - 5);
    expect(keepGoodExits(line, o, flat, slower, cfg).exit.every((v) => v === 0)).toBe(true);
    const kept = keepGoodExits(line, o, flat, faster, cfg).exit;
    expect(kept.some((v) => v !== 0)).toBe(o.exit.some((v) => v !== 0));
  });

  it('modes: nurse on worn tyres, defend a closing car behind, attack a close car ahead or a tow, else manage', () => {
    const base = { aheadGapSec: Infinity, aheadClosing: false, inTow: false, behindGapSec: Infinity, behindClosing: false, wear: 1, damage: 0 };
    expect(chooseMode(base, cfg)).toBe('manage');
    expect(chooseMode({ ...base, aheadGapSec: 0.5, aheadClosing: true }, cfg)).toBe('attack');
    expect(chooseMode({ ...base, aheadGapSec: 0.5, aheadClosing: false }, cfg)).toBe('manage');
    expect(chooseMode({ ...base, inTow: true }, cfg)).toBe('attack');
    expect(chooseMode({ ...base, behindGapSec: 0.3, behindClosing: true }, cfg)).toBe('defend');
    expect(chooseMode({ ...base, behindGapSec: 0.3, behindClosing: true, wear: 0.3 }, cfg)).toBe('nurse');
    const o = { exit: new Float64Array(line.n), inside: new Float64Array(line.n) };
    expect(lineFor('manage', 10, o)).toBe('neutral');
    expect(lineFor('defend', 10, o)).toBe('inside');
    expect(lineFor('attack', 10, o)).toBe('inside'); // no EXIT there
    o.exit[10] = 1;
    expect(lineFor('attack', 10, o)).toBe('exit');
  });
});

describe('a race with racecraft', () => {
  const run = () => {
    const ai0 = aiJson as unknown as AiConfig;
    const builds = [0, 1, 2, 3].map((i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id }));
    let w: WorldState = createRaceWorld(ctx, builds, { laps: 3, seed: 5 });
    const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => ({ ...ai0.presets[ai0.defaultPreset]!, mistakesPerMin: 0 }), () => ai0, 40 + i));
    for (let t = 0; t < 60 * 200 && w.race!.phase !== 'results'; t++) w = step(w, ai.map((d) => d.read(w.tick)), ctx);
    return { w, ai };
  };
  it('finishes, deterministic; the winner mostly manages; modes and lines change', () => {
    const a = run(), b = run();
    expect(a.w.race!.phase).toBe('results');
    expect(a.w.race!.order).toEqual(b.w.race!.order);
    expect(a.w.tick).toBe(b.w.tick);
    const lead = a.ai[a.w.race!.order[0]!]!.state.craftTicks;
    expect(lead.manage / (lead.manage + lead.attack + lead.defend + lead.nurse)).toBeGreaterThan(0.7);
    expect(a.ai.reduce((s, d) => s + d.state.lineChanges, 0)).toBeGreaterThan(0);
    expect(a.ai.reduce((s, d) => s + d.state.stuckEvents, 0)).toBe(0);
  }, 60_000);
});
