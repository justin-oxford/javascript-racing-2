// Low-speed maneuverability card: extra steering lock at low speed, fading out with speed.
import { describe, expect, it } from 'vitest';
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import rules from '../../config/rules.json';
import wallTracing from '../../config/wall-tracing.json';
import { loadTrackNode, simContextNode, surfaces } from '../../tools/load-track-node';
import { createSimTrack, createWorld, mechLockRad, steerLimit, step, traceWalls, type PhysicsConfig, type SimContext, type TrackJson, type WorldState } from './index';

const base = physicsJson as unknown as PhysicsConfig;
const withLock = (extra: number, toKph: number): PhysicsConfig => ({ ...structuredClone(base), steering: { ...base.steering, lowSpeedLockDeg: extra, lowSpeedLockToKph: toKph } });
const DEG = Math.PI / 180, KPH = 1 / 3.6;

/** A 300 x 300 m asphalt pad with the given physics. */
function pad(physics: PhysicsConfig): SimContext {
  const ctx = simContextNode(loadTrackNode('oxford'), physics);
  const PPM = 4, W = 300, H = 300, idx = (id: string) => surfaces.findIndex((s) => s.id === id);
  const data = new Uint8Array(W * PPM * H * PPM).fill(idx('asphalt'));
  for (let y = 0; y < H * PPM; y++) for (let x = 0; x < W * PPM; x++) if (x < PPM || y < PPM || x >= (W - 1) * PPM || y >= (H - 1) * PPM) data[y * W * PPM + x] = idx('wall');
  const json: TrackJson = { id: 'pad', name: 'pad', pxPerMeter: PPM, files: { mask: 'mask.png' }, timingLines: {}, racingLine: [], grid: [], spawn: { x: 150 * PPM, y: 150 * PPM, heading: 0 } };
  const track = createSimTrack(json, { width: W * PPM, height: H * PPM, data }, surfaces);
  return { ...ctx, track, walls: traceWalls(track.mask, track.index.wall, track.index.tyreBarrier, wallTracing), rules };
}

/** Full lock at a held speed for 5 s: the path radius over the last 2 s (distance / turned angle). */
function circle(ctx: SimContext, kph: number): number {
  const v = kph * KPH;
  let w: WorldState = createWorld(ctx, 1);
  w = { ...w, cars: [{ ...w.cars[0]!, x: 150, y: 150, heading: 0, vx: 0, vy: -v }] };
  let dist = 0, turned = 0, last = 0;
  for (let t = 0; t < 300; t++) {
    const c = w.cars[0]!, e = v - Math.hypot(c.vx, c.vy);
    w = step(w, [{ throttle: Math.max(0, Math.min(1, 0.25 + 0.5 * e)), brake: e < -0.5 ? Math.min(1, -0.3 * e) : 0, steer: 1 }], ctx);
    const n = w.cars[0]!, course = Math.atan2(n.vx, -n.vy);
    if (t >= 180) { dist += Math.hypot(n.vx, n.vy) / 60; turned += Math.atan2(Math.sin(course - last), Math.cos(course - last)); }
    last = course;
  }
  return dist / Math.abs(turned);
}

describe('low-speed steering lock', () => {
  it('adds lowSpeedLockDeg at a standstill, fading linearly to nothing by lowSpeedLockToKph; absent = as before', () => {
    const st = withLock(16, 110).steering;
    expect(mechLockRad(0, st) / DEG).toBeCloseTo(base.steering.lockDeg + 16, 6);
    expect(mechLockRad(55 * KPH, st) - mechLockRad(55 * KPH, base.steering)).toBeCloseTo(8 * DEG, 6);
    for (const kph of [110, 150, 250]) expect(mechLockRad(kph * KPH, st)).toBeCloseTo(mechLockRad(kph * KPH, base.steering), 9);
    expect(mechLockRad(60 * KPH, base.steering)).toBeCloseTo((base.steering.lockDeg * DEG) / (1 + 60 / base.steering.lockFalloffKph), 9);
  });

  it('turns much tighter at low speed, and the same at high speed (the assist holds the wheels at peak slip there)', () => {
    const before = pad(structuredClone(base)), after = pad(withLock(16, 110));
    const slowBefore = circle(before, 30), slowAfter = circle(after, 30);
    expect(slowAfter).toBeLessThan(slowBefore * 0.75);
    expect(circle(after, 130)).toBeCloseTo(circle(before, 130), 1);
    // ...and at 130 kph the steering limit itself is unchanged for a car going straight.
    const car = { x: 0, y: 0, heading: 0, vx: 0, vy: -130 * KPH, angVel: 0 };
    expect(steerLimit(car, 1, after.physics)).toBeCloseTo(steerLimit(car, 1, before.physics), 9);
  });
});
