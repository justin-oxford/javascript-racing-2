// AI look-ahead brain (trial card): the planner's choices on simple straights, determinism, and the switch.
import { describe, expect, it } from 'vitest';
import aiJson from '../../config/ai.json';
import contactJson from '../../tools/fixtures/contact-baseline.json';
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import slipstreamJson from '../../tools/fixtures/slipstream-baseline.json';
import raceJson from '../../config/race.json';
import { catalog, loadTrackNode, simContextNode } from '../../tools/load-track-node';
import { aiInputSource, buildRacingLine, createRaceWorld, step, type AiConfig, type PhysicsConfig, type RaceConfig, type SimContext } from './index';
import { planMove, type LookaheadConfig, type PlanCar, type PlanInput } from './lookahead';

/** Slow, whole-race tests get a longer time limit: a busy machine (a dev server running) can push them past 5 s. */
const SLOW_MS = 60_000;
const cfg = (aiJson as unknown as AiConfig).lookahead as LookaheadConfig;

/** A long straight, 6 m of road either side of the line, the profile allowing `vLine` everywhere. */
const straight = (speed: number, others: (PlanCar | undefined)[], vLine = 70): PlanInput => ({
  speed, lat: 0, latRate: 5, profile: () => vLine, k: () => 0, roomR: () => 6, roomL: () => 6, spacingM: 2,
  brakeFollow: 9, brakeFull: 11, accel: 4, safeGapM: 5.6 + 1 + 0.35 * speed, lengthM: 5.6, widthM: 2, aggression: 0.5, others,
});

describe('look-ahead planner', () => {
  it('plans nothing with nobody ahead in range (the rules drive)', () => {
    expect(planMove(straight(50, []), cfg)).toBeUndefined();
    expect(planMove(straight(50, [{ ahead: cfg.rangeM + 5, side: 0, along: 40 }]), cfg)).toBeUndefined();
    expect(planMove(straight(50, [{ ahead: -10, side: 0, along: 40 }]), cfg)).toBeUndefined();
  });

  it('closing fast on a slower car in its lane on a straight, it pulls out of line rather than sit behind', () => {
    const p = planMove(straight(50, [undefined, { ahead: 15, side: 0, along: 40 }]), cfg)!;
    expect(p.target).toBe(1);
    expect(p.lane).not.toBe(0);
  });

  it('never plans a heavy hit: a car stopped across its lane 25 m ahead, no room to the side -> the safe gap, full braking', () => {
    const narrow: PlanInput = { ...straight(30, [{ ahead: 25, side: 0, along: 0 }]), roomR: () => 1, roomL: () => 1 };
    const p = planMove(narrow, cfg)!;
    expect(p.lane).toBe(0);
    expect(p.fullBrake).toBe(true);
  });

  it('is deterministic and keeps its choice when nothing changes (hysteresis)', () => {
    const inp = straight(45, [{ ahead: 12, side: 0.3, along: 44 }]);
    const a = planMove(inp, cfg)!, b = planMove(inp, cfg)!;
    expect(b).toEqual(a);
    expect(planMove(inp, cfg, a)).toMatchObject({ lane: a.lane, gi: a.gi, fullBrake: a.fullBrake });
  });
});

describe('ai.brain switch', () => {
  const loaded = loadTrackNode('oxford');
  const ctx: SimContext = { ...simContextNode(loaded, structuredClone(physicsJson as unknown as PhysicsConfig)), contact: contactJson, race: raceJson as RaceConfig, slipstream: slipstreamJson };
  const line = buildRacingLine(ctx.track)!;
  const race = (brain: 'rules' | 'lookahead') => {
    const ai = { ...(structuredClone(aiJson) as unknown as AiConfig), brain };
    const builds = [0, 1, 2, 3].map((i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id }));
    let w = createRaceWorld(ctx, builds, { laps: 3, seed: 5 });
    const drivers = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => ai.presets[ai.defaultPreset]!, () => ai, 50 + i));
    let planned = 0;
    for (let t = 0; t < 60 * 120 && w.race!.phase !== 'results'; t++) { w = step(w, drivers.map((d) => d.read(w.tick)), ctx); planned += drivers.filter((d) => d.state.plan).length; }
    return { w, planned, states: drivers.map((d) => d.state) };
  };

  it('"rules" never plans; "lookahead" plans behind cars after lap one, finishes, and is deterministic', { timeout: SLOW_MS }, () => {
    const rules = race('rules');
    expect(rules.planned).toBe(0);
    expect(rules.states.every((s) => s.plan === undefined)).toBe(true);
    const a = race('lookahead'), b = race('lookahead');
    expect(a.planned).toBeGreaterThan(0);
    expect(a.w.race!.phase).toBe('results');
    expect(b.w.race!.order).toEqual(a.w.race!.order);
    expect(b.w.tick).toBe(a.w.tick);
    expect(b.w.cars).toEqual(a.w.cars);
  });
});
