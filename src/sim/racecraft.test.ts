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
  aiInputSource, blueFlag, buildRacingLine, buildStats, chooseMode, computeExitLine, coverChance, limitSlope, speedProfile, offsetPath, offsetsFromPoints, concedes, cornersOf, createRaceWorld, keepGoodExits, lineFor, lineOffsets,
  otherHasRightOfWay, step, type AiConfig, type DefenceConfig, type PhysicsConfig, type RaceConfig, type SimContext, type WorldState,
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
    expect(lineFor('defend', 10, o)).toBe('neutral'); // the racing line: on INSIDE, defenders got run into
    expect(lineFor('attack', 10, o)).toBe('neutral'); // no EXIT there: the racing line (INSIDE is slower)
    o.exit[10] = 1;
    expect(lineFor('attack', 10, o)).toBe('exit');
  });
});

describe('the defender choice (AI overtaking round 3)', () => {
  const dc = (aiJson as unknown as { defence: DefenceConfig }).defence;
  const base = { aggression: 0.5, racecraft: 0.5, gapSec: 0.5, closingMps: 1, tow: false, tyreUsed: 0.2 };

  it('covers more when aggressive or under threat, less on worn tyres; good racecraft reads the threat sharper', () => {
    const p = (o: Partial<typeof base>) => coverChance({ ...base, ...o }, dc);
    expect(p({ aggression: 0.9 })).toBeGreaterThan(p({ aggression: 0.1 }));
    expect(p({ gapSec: 0.1, closingMps: 4, tow: true })).toBeGreaterThan(p({ gapSec: 0.9, closingMps: 0 }));
    expect(p({ tyreUsed: 0.8 })).toBeLessThan(p({ tyreUsed: 0 }));
    const big = { gapSec: 0.1, closingMps: 4, tow: true }, none = { gapSec: 0.95, closingMps: -2 };
    expect(p({ racecraft: 0.9, ...big }) - p({ racecraft: 0.9, ...none })).toBeGreaterThan(p({ racecraft: 0.1, ...big }) - p({ racecraft: 0.1, ...none }));
    for (const o of [{}, { aggression: 1, ...big }, { aggression: 0, ...none, tyreUsed: 1 }]) { expect(p(o)).toBeGreaterThan(0); expect(p(o)).toBeLessThan(1); }
  });

  it('a covering defender takes the INSIDE line where there is one', () => {
    const o = lineOffsets(line, cfg, ctx.physics.car.widthM / 2);
    const q = o.inside.findIndex((v) => v !== 0);
    expect(lineFor('defend', q, o, true)).toBe('inside');
    expect(lineFor('defend', q, o, false)).toBe('neutral');
  });

  it('limitSlope: neighbours differ by at most the step, values only shrink, a side change goes through 0', () => {
    const off = Float64Array.from([0, 0, 3, 3, 3, -3, -3, 0, 0, 0]);
    const was = Float64Array.from(off);
    limitSlope(off, 1);
    for (let q = 0; q < off.length; q++) {
      expect(Math.abs(off[q]! - off[(q + 1) % off.length]!)).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.abs(off[q]!)).toBeLessThanOrEqual(Math.abs(was[q]!) + 1e-9);
      expect(Math.sign(off[q]!) === 0 || Math.sign(off[q]!) === Math.sign(was[q]!)).toBe(true);
    }
  });

  it('the INSIDE line costs time but is a real line (no kinks): a lap on it within 8% of the racing line', () => {
    const st = buildStats(ctx.physics.defaultCar, ctx.catalog), opt = { cornerMargin: 1, brakeMargin: 1, fuelKg: 30 };
    const o = lineOffsets(line, cfg, ctx.physics.car.widthM / 2), p = offsetPath(line, o.inside);
    const lap = (v: ArrayLike<number>) => { let t = 0; for (let q = 0; q < v.length; q++) t += 2 / v[q]!; return t; };
    const tN = lap(speedProfile(line.x, line.y, ctx.physics, st, opt)), tI = lap(speedProfile(p.x, p.y, ctx.physics, st, opt));
    expect(tI).toBeGreaterThan(tN);
    expect(tI).toBeLessThan(tN * 1.08); // unlimited, it was 39 s against 27 s
  });
});

describe('EXIT line, time-weighted (Racing line optimizer card)', () => {
  it('is quicker to the end of the straight after it, stays on the road, and survives the round trip through track.json', () => {
    const halfCar = ctx.physics.car.widthM / 2, ppm = ctx.track.json.pxPerMeter;
    const ex = computeExitLine(line, ctx.physics, buildStats(ctx.physics.defaultCar, ctx.catalog), { exitStraightM: cfg.exitStraightM, exitShiftM: cfg.exitShiftM, edgeM: cfg.edgeM, exitLeadM: 40, exitBumps: 10 }, ppm);
    const corners = cornersOf(line), n = line.n, wrap = (q: number) => ((q % n) + n) % n;
    const p = offsetPath(line, ex.offsets), vN = ex.speed(line.x, line.y), vE = ex.speed(p.x, p.y);
    let faster = 0;
    corners.forEach((c, k) => {
      const next = corners[(k + 1) % corners.length]!;
      if (wrap(next.from - c.to) * 2 < cfg.exitStraightM) return;
      const from = c.from - 20, to = from + wrap(next.from - from);
      if (ex.time(p.x, p.y, vE, from, to) < ex.time(line.x, line.y, vN, from, to) - 0.01) faster++;
    });
    expect(faster).toBeGreaterThan(0);
    for (let q = 0; q < n; q++) {
      const room = (ex.offsets[q]! > 0 ? line.right[q]! : line.left[q]!) - halfCar - cfg.edgeM;
      expect(Math.abs(ex.offsets[q]!)).toBeLessThanOrEqual(Math.max(0, room) + 1e-6);
    }
    const back = offsetsFromPoints(line, ex.points.map((pt) => ({ x: pt.x / ppm, y: pt.y / ppm })));
    for (let q = 0; q < n; q++) expect(Math.abs(back[q]! - ex.offsets[q]!)).toBeLessThan(0.15);
  });
});

describe('overtaking rules (AI overtaking card)', () => {
  const ov = (aiJson as unknown as AiConfig).overtaking!;
  const W = ctx.physics.car.widthM;
  it('overlap rule: side by side into a corner, the car on the inside has the right of way; exactly one of a pair has it', () => {
    // We're on the outside of a right-hander (+1), the other car 2 m behind us and 2.5 m to our right: overlapped, inside.
    expect(otherHasRightOfWay(-2, 2.5, 1, false, ov.overlapM)).toBe(true);
    // ...and from its side: we're 2 m ahead on its left, the outside: it keeps the right of way, we don't.
    expect(otherHasRightOfWay(2, -2.5, 1, true, ov.overlapM)).toBe(false);
    // Not overlapped (a car length+ behind on the inside): the car ahead keeps it.
    expect(otherHasRightOfWay(-(ov.overlapM + 1), 2.5, 1, false, ov.overlapM)).toBe(false);
    expect(otherHasRightOfWay(ov.overlapM + 1, -2.5, 1, false, ov.overlapM)).toBe(true);
    // No corner in sight: the car ahead; level, the lower number.
    expect(otherHasRightOfWay(1, 2.5, 0, false, ov.overlapM)).toBe(true);
    expect(otherHasRightOfWay(0, 2.5, 0, true, ov.overlapM)).toBe(true);
    expect(otherHasRightOfWay(0, -2.5, 0, false, ov.overlapM)).toBe(false);
    // Exactly one of every overlapped pair has it, whichever car is ahead, either corner direction.
    for (const turn of [1, -1]) for (const a of [-3, -1, 0.2, 1, 3]) for (const sd of [-2.5, 2.5]) {
      expect(otherHasRightOfWay(a, sd, turn, true, ov.overlapM)).not.toBe(otherHasRightOfWay(-a, -sd, turn, false, ov.overlapM));
    }
  });

  it('conceding: only a low-aggression driver, into a braking zone, for a car overlapped on its inside', () => {
    const inside = [-1.5, 2.5, 1] as const; // ahead, side, nextTurn
    expect(concedes(ov.concedeBelow - 0.1, true, ...inside, W, ov)).toBe(true);
    expect(concedes(ov.concedeBelow + 0.1, true, ...inside, W, ov)).toBe(false); // aggressive: fights it
    expect(concedes(0, false, ...inside, W, ov)).toBe(false); // not braking yet
    expect(concedes(0, true, -1.5, -2.5, 1, W, ov)).toBe(false); // it's on the outside
    expect(concedes(0, true, -(ov.overlapM + 2), 2.5, 1, W, ov)).toBe(false); // not overlapped
  });

  it('blue flags: a lapping car pulled out alongside gets a lift; not one still in line, nor a car on the same lap', () => {
    expect(blueFlag(1, -2, 2.5, W, ov)).toBe(true);
    expect(blueFlag(1, -2, 0.3, W, ov)).toBe(false); // still in line behind: lifting now just gets us hit
    expect(blueFlag(0.3, -2, 2.5, W, ov)).toBe(false); // racing us, not lapping
    expect(blueFlag(1, -(ov.blueBehindM + 1), 2.5, W, ov)).toBe(false);
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
  it('finishes, deterministic; the winner mostly manages; modes change', () => {
    const a = run(), b = run();
    expect(a.w.race!.phase).toBe('results');
    expect(a.w.race!.order).toEqual(b.w.race!.order);
    expect(a.w.tick).toBe(b.w.tick);
    const lead = a.ai[a.w.race!.order[0]!]!.state.craftTicks;
    expect(lead.manage / (lead.manage + lead.attack + lead.defend + lead.nurse)).toBeGreaterThan(0.7);
    // Modes change (lines now change only onto a kept EXIT line, AI overtaking card: rare in a 3-lap race).
    expect(a.ai.reduce((s, d) => s + d.state.craftTicks.attack + d.state.craftTicks.defend, 0)).toBeGreaterThan(0);
    expect(a.ai.reduce((s, d) => s + d.state.stuckEvents, 0)).toBe(0);
  }, 60_000);
});
