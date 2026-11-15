// @vitest-environment node
// Wake model card (round 8): one path trail for tow + dirty air. WAKE = ALONG x SIDEWAYS x SPEED RATIO.
import { describe, expect, it } from 'vitest';
import slipstreamJson from '../../config/slipstream.json';
import { defaultTrackIdNode, loadTrackNode, simContextNode } from '../../tools/load-track-node';
import { createWorld, step, trailWake, updateTrail, wakeEffects, type CarInput, type SlipstreamConfig, type TrailConfig, type TrailPoint, type WorldState } from './index';

const cfg = slipstreamJson as SlipstreamConfig;
const trail = cfg.trail as TrailConfig;
const L = 5.6, W = 2;
const OLD: SlipstreamConfig = { tow: cfg.tow, aiTowEagerness: cfg.aiTowEagerness, dirtyAir: { ...cfg.dirtyAir, cornerG: 0.6 } };

/** A car on a circle of radius R about the origin at angle a (rad), driving anticlockwise at v. */
const onCircle = (R: number, a: number, v: number, trail?: readonly TrailPoint[]) => {
  const x = R * Math.cos(a), y = R * Math.sin(a);
  // Velocity along the tangent (anticlockwise); heading: 0 = up (-y), so heading = atan2(vx, -vy).
  const vx = -Math.sin(a) * v, vy = Math.cos(a) * v;
  return { x, y, vx, vy, heading: Math.atan2(vx, -vy), angVel: v / R, ...(trail ? { trail } : {}) };
};
/** The trail a car leaves driving the last 120 m round the circle up to angle a1 (fed through updateTrail, 0.1 m at a time). */
const circleTrail = (R: number, a1: number, v: number): readonly TrailPoint[] => {
  let t: readonly TrailPoint[] | undefined;
  for (let sM = -120; sM <= 1e-9; sM += 0.1) { const p = onCircle(R, a1 + sM / R, v); t = updateTrail(t, p.x, p.y, v, trail, L); }
  return t!;
};

describe('wake model: one path trail', () => {
  it('follows the leader\'s curved path: a follower on that arc is in its wake, the old straight-back zone misses it', () => {
    const R = 30, v = 25, a = 1;
    const lead = onCircle(R, a, v, circleTrail(R, a, v));
    // Two car lengths behind along the arc (one car length bumper to bumper: ALONG = 1).
    const follower = onCircle(R, a - (2 * L) / R, v);
    const w = trailWake(follower, lead, L, W, trail);
    expect(w).toBeGreaterThan(0.9);
    // The old wake points along the leader's current heading: the follower is off its line and angled away.
    expect(wakeEffects([lead, follower], W, OLD, L).tow[1]).toBe(0);
    // The same distance straight back along the leader's current heading (off the arc): little or no wake now.
    const fx = Math.sin(lead.heading), fy = -Math.cos(lead.heading);
    const straightBack = { ...follower, x: lead.x - fx * 2 * L, y: lead.y - fy * 2 * L };
    expect(trailWake(straightBack, lead, L, W, trail)).toBeLessThan(w * 0.5);
  });

  it('a slow leader barely affects a fast follower (SPEED RATIO)', () => {
    const R = 1e6, a = 0; // a straight line, in practice
    const slow = 8, fast = 60;
    const lead = onCircle(R, a, slow, circleTrail(R, a, slow));
    const follower = onCircle(R, a - (2 * L) / R, fast);
    const fx = wakeEffects([lead, follower], W, cfg, L);
    expect(fx.tow[1]!).toBeLessThanOrEqual(cfg.tow.maxDragReduction * (slow / fast) + 1e-9);
    expect(fx.dirtyAir[1]!).toBeLessThanOrEqual(cfg.dirtyAir.maxDownforceLoss * (slow / fast) + 1e-9);
    expect(fx.tow[1]!).toBeGreaterThan(0);
  });

  it('is strongest tucked up (no dead zone close behind), fades to nothing at the trail\'s end, never stacks', () => {
    const R = 1e6, v = 50;
    const lead = onCircle(R, 0, v, circleTrail(R, 0, v));
    const at = (bumperM: number, side = 0) => {
      const f = onCircle(R, -(L + bumperM) / R, v);
      return wakeEffects([lead, { ...f, x: f.x + side }], W, cfg, L).tow[1]!;
    };
    expect(at(0.2)).toBeCloseTo(cfg.tow.maxDragReduction, 6);
    expect(at(L)).toBeCloseTo(cfg.tow.maxDragReduction, 6);
    expect(at(2 * L)).toBeLessThan(at(L));
    expect(at(4 * L)).toBeGreaterThan(0);
    expect(at(trail.lengthCars * L + 1)).toBe(0);
    expect(at(L, 4 * W)).toBe(0); // well off to the side
    // The leader gets nothing from the car behind it.
    expect(wakeEffects([lead, onCircle(R, -(2 * L) / R, v)], W, cfg, L).tow[0]).toBe(0);
    // Two cars ahead: the strongest single wake.
    const mid = onCircle(R, -(2 * L) / R, v, circleTrail(R, -(2 * L) / R, v));
    const back = onCircle(R, -(3 * L + 0.5) / R, v);
    const two = wakeEffects([lead, mid, back], W, cfg, L).tow[2]!;
    expect(two).toBeLessThanOrEqual(cfg.tow.maxDragReduction + 1e-12);
    expect(two).toBeCloseTo(Math.max(trailWake(back, lead, L, W, trail), trailWake(back, mid, L, W, trail)) * cfg.tow.maxDragReduction, 9);
  });

  it('dirty air comes from the same wake as the tow, on straights too (no cornering gate)', () => {
    const R = 1e6, v = 50;
    const lead = onCircle(R, 0, v, circleTrail(R, 0, v));
    const f = onCircle(R, -(2 * L) / R, v);
    const fx = wakeEffects([lead, { ...f, angVel: 0 }], W, cfg, L);
    expect(fx.dirtyAir[1]! / cfg.dirtyAir.maxDownforceLoss).toBeCloseTo(fx.tow[1]! / cfg.tow.maxDragReduction, 9);
    expect(fx.dirtyAir[1]!).toBeGreaterThan(0);
  });

  it('a reset (a jump) starts a new trail', () => {
    let t = updateTrail(undefined, 0, 0, 10, trail, L);
    t = updateTrail(t, 0, trail.stepM, 10, trail, L);
    expect(t.length).toBe(2);
    expect(updateTrail(t, 500, 500, 10, trail, L)).toEqual([{ x: 500, y: 500, v: 10 }]);
  });
});

describe('wake model in the sim (live config: trail on)', () => {
  const loaded = loadTrackNode(defaultTrackIdNode());
  const input = (tick: number, i: number): CarInput => ({ throttle: tick < 400 ? 1 : 0.6, brake: 0, steer: Math.sin(tick / (90 + 7 * i)) * 0.15 });
  const run = (ctx: ReturnType<typeof simContextNode>, w: WorldState, ticks: number) => {
    for (let t = 0; t < ticks; t++) w = step(w, w.cars.map((_, i) => input(w.tick, i)), ctx);
    return w;
  };

  it('is deterministic with two cars, and the trail is plain state', () => {
    const a = simContextNode(loaded), b = simContextNode(loaded);
    const wa = run(a, createWorld(a, 2), 600), wb = run(b, createWorld(b, 2), 600);
    expect(wa).toEqual(wb);
    expect(wa.cars[0]!.trail!.length).toBeGreaterThan(5);
    expect(JSON.parse(JSON.stringify(wa))).toEqual(wa);
  });

  it('rebuilding from the tick-300 plain state (trails included) stays on the continuous run', () => {
    const cont = simContextNode(loaded), first = simContextNode(loaded);
    const continuous = run(cont, createWorld(cont, 2), 600);
    const at300 = JSON.parse(JSON.stringify(run(first, createWorld(first, 2), 300))) as WorldState;
    const replay = run(simContextNode(loaded), JSON.parse(JSON.stringify(at300)) as WorldState, 300);
    expect(replay.cars.map((c) => [c.x, c.y, c.tow, c.dirtyAir, c.trail])).toEqual(continuous.cars.map((c) => [c.x, c.y, c.tow, c.dirtyAir, c.trail]));
  });
});
