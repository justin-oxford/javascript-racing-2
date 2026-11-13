// @vitest-environment node
// Reset to track (POLISH card): hold reset ~1 s, rejoin the racing line behind where the car left the
// track (never ahead), clear of other cars, ghosted until clear, lap invalidated, race penalty hold.
import { describe, expect, it } from 'vitest';
import contactJson from '../../tools/fixtures/contact-baseline.json';
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import slipstreamJson from '../../tools/fixtures/slipstream-baseline.json';
import raceJson from '../../config/race.json';
import { loadTrackNode, simContextNode } from '../../tools/load-track-node';
import aiJson from '../../tools/fixtures/ai-baseline.json';
import { aiInputSource, buildRacingLine, createRaceWorld, createWorld, progressLine, type AiConfig, raceResults, step, type CarInput, type CarState, type PhysicsConfig, type RaceConfig, type SimContext, type WorldState } from './index';

const loaded = loadTrackNode('oxford');
const ctx: SimContext = { ...simContextNode(loaded, structuredClone(physicsJson as PhysicsConfig)), contact: contactJson, race: raceJson as RaceConfig, slipstream: slipstreamJson };
const line = progressLine(ctx.track)!;
const cfg = ctx.race.reset;
const HOLD: CarInput = { throttle: 0, brake: 0, steer: 0, reset: true };
const IDLE: CarInput = { throttle: 0, brake: 0, steer: 0 };
const wrap = (q: number) => ((q % line.n) + line.n) % line.n;
/** Line points from a to b going forward (0 = same point). */
const ahead = (a: number, b: number) => wrap(b - a);
const nearest = (c: Pick<CarState, 'x' | 'y'>) => { let b = 0, bd = Infinity; for (let q = 0; q < line.n; q++) { const d = (line.x[q]! - c.x) ** 2 + (line.y[q]! - c.y) ** 2; if (d < bd) { bd = d; b = q; } } return b; };
const heading = (q: number) => Math.atan2(line.x[wrap(q + 1)]! - line.x[q]!, -(line.y[wrap(q + 1)]! - line.y[q]!));
const place = (w: WorldState, i: number, x: number, y: number, h: number): WorldState => ({ ...w, cars: w.cars.map((c, k) => (k === i ? { ...c, x, y, heading: h, vx: 0, vy: 0, angVel: 0 } : c)) });
/** A spot near line point q with the car's wheels on grass or gravel (not legal, not wall, not pit lane), metres. */
const offTrackNear = (q: number): { x: number; y: number } | undefined => {
  const ppm = ctx.track.json.pxPerMeter, h = heading(q), bad = new Set(['grass', 'gravel']);
  for (let side = 6; side < 40; side += 0.5)
    for (const sg of [1, -1]) {
      const x = line.x[q]! + Math.cos(h) * side * sg, y = line.y[q]! + Math.sin(h) * side * sg;
      const ok = [-3, 0, 3].every((dx) => [-3, 0, 3].every((dy) => { const id = ctx.track.surfaces[ctx.track.mask.data[Math.round((y + dy) * ppm) * ctx.track.mask.width + Math.round((x + dx) * ppm)]!]?.id; return !!id && bad.has(id); }));
      if (ok) return { x, y };
    }
  return undefined;
};
/** Car i on the line at q for a tick (it becomes its last on-track point), then dropped on the grass `fwd` points further on, facing the wrong way. */
const leaveTrackAt = (w: WorldState, i: number, q: number, fwd: number): WorldState => {
  w = step(place(w, i, line.x[q]!, line.y[q]!, heading(q)), [], ctx);
  // The nearest stretch with grass beside it at or past q + fwd (some edges are straight to a wall).
  for (let k = 0; k < line.n; k++) {
    const q2 = wrap(q + fwd + k), p = offTrackNear(q2);
    if (p) return place(w, i, p.x, p.y, heading(q2) + 2);
  }
  throw new Error('no grass anywhere');
};
const hold = (w: WorldState, ticks: number, input = HOLD, i = 0): WorldState => {
  for (let t = 0; t < ticks; t++) w = step(w, w.cars.map((_, k) => (k === i ? input : IDLE)), ctx);
  return w;
};

describe('reset to track', () => {
  it('needs the full hold: a tap does nothing', () => {
    const w0 = leaveTrackAt(createWorld(ctx, 1), 0, 100, 15);
    const before = { x: w0.cars[0]!.x, y: w0.cars[0]!.y };
    const w = hold(w0, Math.round(cfg.holdSec * 60) - 10);
    expect(Math.hypot(w.cars[0]!.x - before.x, w.cars[0]!.y - before.y)).toBeLessThan(2);
    expect(w.cars[0]!.rejoin.count).toBe(0);
  });

  it('never puts the car ahead of where it left the track, all the way round the lap', () => {
    const backoff = Math.round(cfg.backoffM / 2);
    for (let q = 0; q < line.n; q += 23) {
      if (!offTrackNear(wrap(q + 20))) continue; // wall right at the edge here: nowhere to cut across
      let w = leaveTrackAt(createWorld(ctx, 1), 0, q, 20); // cut 40 m on across the grass
      const left = w.cars[0]!.rejoin.lastGoodQ;
      w = hold(w, Math.round(cfg.holdSec * 60) + 1);
      const c = w.cars[0]!;
      expect(c.rejoin.count).toBe(1);
      const at = nearest(c);
      // Behind (or at) where it left, by about the back-off: never forward of it.
      expect(ahead(at, left)).toBeGreaterThanOrEqual(backoff - 2);
      expect(ahead(at, left)).toBeLessThanOrEqual(backoff + 2);
      expect(c.timing.lapInvalid || !c.timing.started).toBe(true);
    }
  });

  it('lands clear of other cars, further back if it has to, and is ghosted until clear', () => {
    let w = createWorld(ctx, 2);
    w = leaveTrackAt(w, 0, 200, 10);
    const left = w.cars[0]!.rejoin.lastGoodQ;
    // Park car 1 right where the reset would land.
    const spot = wrap(left - Math.round(cfg.backoffM / 2));
    w = place(w, 1, line.x[spot]!, line.y[spot]!, heading(spot));
    w = hold(w, Math.round(cfg.holdSec * 60) + 1);
    const me = w.cars[0]!, other = w.cars[1]!;
    expect(me.rejoin.count).toBe(1);
    expect(Math.hypot(me.x - other.x, me.y - other.y)).toBeGreaterThanOrEqual(cfg.clearM - 0.5);
    expect(ahead(nearest(me), spot)).toBeGreaterThan(0); // slid further back
    expect(me.rejoin.ghost, 'ghosted on landing').toBe(true);
    // Still ghosted while the other car is near, past the minimum ghost time; clears once it's away.
    for (let t = 0; t < Math.round(cfg.ghostSec * 60) + 5; t++) w = hold(place(w, 1, w.cars[0]!.x, w.cars[0]!.y, w.cars[0]!.heading), 1, IDLE); // car 1 sits right on it
    expect(w.cars[0]!.rejoin.ghost, 'still ghosted with a car on top').toBe(true);
    expect(w.cars[0]!.carContact).toBe(false); // sitting on top of each other, no contact
    w = place(w, 1, line.x[wrap(spot + 60)]!, line.y[wrap(spot + 60)]!, heading(spot + 60));
    w = hold(w, 2, IDLE);
    expect(w.cars[0]!.rejoin.ghost).toBe(false);
  });

  it('in a race: held still for the penalty, counted in the results; then a cooldown', () => {
    let w = createRaceWorld(ctx, ctx.physics.defaultCar ? [ctx.physics.defaultCar, ctx.physics.defaultCar] : [], { laps: 3, seed: 1 });
    for (let t = 0; t < 60 * 30 && w.race!.phase !== 'racing'; t++) w = step(w, [], ctx);
    w = hold(w, 30, { throttle: 1, brake: 0, steer: 0 }); // under way
    w = leaveTrackAt(w, 0, w.cars[0]!.rejoin.lastGoodQ, 10);
    w = hold(w, Math.round(cfg.holdSec * 60) + 1);
    expect(w.cars[0]!.rejoin.count, `race reset done (lastGood ${w.cars[0]!.rejoin.lastGoodQ}, hold ${w.cars[0]!.rejoin.holdTicks}, cool ${w.cars[0]!.rejoin.cooldownTicks}, pit ${w.cars[0]!.inPitLane})`).toBe(1);
    const at = { x: w.cars[0]!.x, y: w.cars[0]!.y };
    w = hold(w, Math.round(cfg.penaltySec * 60) - 5, { throttle: 1, brake: 0, steer: 0 }); // flooring it: still held
    expect(Math.hypot(w.cars[0]!.x - at.x, w.cars[0]!.y - at.y)).toBeLessThan(0.5);
    w = hold(w, 60, { throttle: 1, brake: 0, steer: 0 });
    expect(Math.hypot(w.cars[0]!.x - at.x, w.cars[0]!.y - at.y)).toBeGreaterThan(2); // penalty served: away it goes
    expect(raceResults(w.race!).find((r) => r.car === 0)!.resets).toBe(1);
    // Cooldown: holding again straight away does nothing.
    w = leaveTrackAt(w, 0, w.cars[0]!.rejoin.lastGoodQ, 10);
    w = hold(w, Math.round(cfg.holdSec * 60) + 5);
    expect(w.cars[0]!.rejoin.count).toBe(1);
  });

  it('an AI that cannot get going resets itself after recovery.resetAfterSec, like a player', () => {
    // No engine: it can't drive or reverse out, so only the reset gets it back.
    const dead: SimContext = { ...ctx, physics: { ...ctx.physics, engine: { ...ctx.physics.engine, maxDriveForceN: 0, powerKW: 0, reverseForceN: 0 } } };
    const cfgAi = { ...(aiJson as unknown as AiConfig), recovery: { ...(aiJson as unknown as AiConfig).recovery, resetAfterSec: 3 } };
    let w = leaveTrackAt(createWorld(dead, 1), 0, 120, 10);
    const aiLine = buildRacingLine(dead.track);
    const ai = aiInputSource(0, () => ({ world: w, ctx: dead, line: aiLine }), () => cfgAi.presets[cfgAi.defaultPreset]!, () => cfgAi, 5);
    for (let t = 0; t < 60 * 6 && !w.cars[0]!.rejoin.count; t++) w = step(w, [ai.read(w.tick)], dead);
    expect(w.cars[0]!.rejoin.count).toBe(1);
    expect(w.tick).toBeGreaterThan(60 * 3); // not before resetAfterSec
    expect(ai.state.resets).toBe(0); // it notices on its next read
    ai.read(w.tick);
    expect(ai.state.resets).toBe(1);
    expect(ai.state.troubleTicks).toBe(0);
  });

  it('is deterministic', () => {
    const run = () => hold(leaveTrackAt(createWorld(ctx, 2), 0, 300, 20), 200);
    expect(run().cars).toEqual(run().cars);
  });
});
