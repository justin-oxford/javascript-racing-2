// Prediction (card 07 step 6) against the real server race host, no network: inputs reach the server a
// few ticks late (with jitter, order kept), snapshots come back a few ticks late. Same sim both ends, so
// the predicted car should land where the server puts it: corrections stay at rounding size.
import { describe, expect, it } from 'vitest';
import { RaceHost } from '../../server/race-host';
import { worldFromSnap, type InputMsg, type SnapMsg } from '../../server/protocol';
import { raceContext } from '../../server/tracks';
import { Predictor } from './predictor';

function run(aiCount: number, jitterTicks: number, ticks: number): number[] {
  const host = new RaceHost(raceContext('oxford'), { track: 'oxford', laps: 1, spec: 'C1', aiCount, aiPreset: 'medium' }, [{ player: 'p', name: 'Pat', team: 'cavalli' }], 5);
  const start = host.startWorld();
  const pred = new Predictor(raceContext('oxford'), 0, start.surface ? { surface: start.surface } : {});
  pred.start(start);
  let r = 12345;
  const rand = () => ((r = (r * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const up: Array<{ at: number; m: InputMsg }> = [], down: Array<{ at: number; s: SnapMsg }> = [];
  let base = start.cars, seq = 0;
  const errs: number[] = [];
  for (let t = 0; t < ticks; t++) {
    // Lights go out around tick 400 (grid + lights + hold): throttle from then, weaving.
    const m: InputMsg = { seq: seq++, throttle: t > 380 ? 1 : 0, brake: 0, steer: Math.sin(t / 40) * 0.4 };
    pred.tick(m);
    const last = up[up.length - 1]?.at ?? 0;
    up.push({ at: Math.max(last, t + 3 + Math.round((rand() * 2 - 1) * jitterTicks)), m });
    while (up.length && up[0]!.at <= t) host.setInput(0, up.shift()!.m);
    host.step();
    if (host.world.tick % 3 === 0) down.push({ at: t + 3, s: host.takeSnapshot().forCar(0) });
    while (down.length && down[0]!.at <= t) {
      const s = down.shift()!.s;
      const w = worldFromSnap(s, base, 0);
      base = w.cars;
      const c = pred.reconcile(w, s.ack);
      if (c && s.race?.phase === 'racing') errs.push(Math.hypot(c.dx, c.dy));
    }
  }
  return errs.sort((a, b) => a - b);
}

describe('Predictor', () => {
  it('lands on the server state: alone, with AI cars, with jitter', () => {
    for (const [ai, jit] of [[0, 0], [3, 1]] as const) {
      const e = run(ai, jit, 1000);
      expect(e.length).toBeGreaterThan(100);
      expect(e[Math.floor(e.length * 0.95)]!).toBeLessThan(0.01); // 1 cm
      expect(e[e.length - 1]!).toBeLessThan(0.05);
    }
  }, 60_000);
});
