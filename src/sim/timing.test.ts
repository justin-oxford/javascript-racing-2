// @vitest-environment node
import evolutionJson from '../../config/evolution.json';
import strategyJson from '../../config/strategy.json';
import weatherJson from '../../config/weather.json';
import ersJson from '../../config/ers.json';
import damageJson from '../../config/damage.json';
import assistsJson from '../../tools/fixtures/assists-baseline.json';
import slipstreamJson from '../../tools/fixtures/slipstream-baseline.json';
import contactJson from '../../tools/fixtures/contact-baseline.json';
import raceJson from '../../config/race.json';
import { describe, expect, it } from 'vitest';
// Frozen baseline, not live config: these behaviours must not change while Justin tunes.
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import rules from '../../config/rules.json';
import wallTracing from '../../config/wall-tracing.json';
import { catalog, surfaces } from '../../tools/load-track-node';
import {
  createPhysicsCache,
  createSimTrack,
  createWorld,
  crossing,
  newTiming,
  step,
  traceWalls,
  updateTiming,
  type LapTiming,
  type ErsConfig, type StrategyConfig, type WeatherConfig, type PhysicsConfig,
  type SimContext,
  type TimingEvent,
  type TrackJson,
  type WorldState,
} from './index';

// A straight track running up the screen (-y), 1 px = 1 m. Lines across it at y = 100 (S/F), 70 (S1), 40 (S2).
// Driving up = moving -y. Valid direction = right-hand normal of a->b: for a=(0,y) b=(20,y), that's (0,1)·…
// so we put a on the right (x=20) and b on the left (x=0): a->b = (-20, 0), right-hand normal (0, -20) = up.
const line = (y: number) => ({ a: { x: 20, y }, b: { x: 0, y } });
const json: Pick<TrackJson, 'timingLines' | 'pxPerMeter'> = { pxPerMeter: 1, timingLines: { startFinish: line(100), s1: line(70), s2: line(40) } };

/** Drive a car straight up from y0 to y1 at `speed` m/s in 1/60 s ticks, starting at sim time t. */
function drive(timing: LapTiming, y0: number, y1: number, speed: number, t: number, events: TimingEvent[], flags: Partial<{ offTrack: boolean; barrierContact: boolean }> = {}) {
  const dt = 1 / 60, dir = Math.sign(y1 - y0);
  let y = y0;
  while (dir * (y1 - y) > 0) {
    const ny = dir > 0 ? Math.min(y1, y + speed * dt) : Math.max(y1, y - speed * dt);
    timing = updateTiming(timing, { from: { x: 10, y }, to: { x: 10, y: ny }, t0: t, t1: t + dt, offTrack: false, barrierContact: false, ...flags }, json, 0, events);
    y = ny;
    t += dt;
  }
  return { timing, t };
}

describe('crossing', () => {
  it('counts only the valid direction and only within the segment', () => {
    const a = { x: 20, y: 100 }, b = { x: 0, y: 100 };
    expect(crossing({ x: 10, y: 101 }, { x: 10, y: 99 }, a, b)).toBeCloseTo(0.5); // up: valid
    expect(crossing({ x: 10, y: 99 }, { x: 10, y: 101 }, a, b)).toBeUndefined(); // down: wrong way
    expect(crossing({ x: 30, y: 101 }, { x: 30, y: 99 }, a, b)).toBeUndefined(); // past the end of the line
  });
});

describe('lap timing', () => {
  it('ignores the out-lap, then times three sectors and a lap, sub-tick precise', () => {
    const ev: TimingEvent[] = [];
    let { timing, t } = drive(newTiming(), 120, 101, 30, 0, ev); // out-lap: nothing yet
    expect(timing.started).toBe(false);
    ({ timing, t } = drive(timing, 101, 10, 30, t, ev)); // across S/F (start), S1, S2
    expect(timing.started).toBe(true);
    expect(ev.map((e) => e.type)).toEqual(['sector', 'sector']);
    // "Loop": state is data, so put the car back below S/F with its timing and drive through again.
    ({ timing, t } = drive(timing, 101.2, 95, 30, t, ev));
    const lap = ev.find((e) => e.type === 'lap')!;
    expect(lap).toMatchObject({ type: 'lap', lap: 1, invalid: false });
    if (lap.type !== 'lap') throw new Error();
    expect(lap.sectors).toHaveLength(3);
    expect(lap.sectors.reduce((a, b) => a + b, 0)).toBeCloseTo(lap.time, 9);
    // S1 is 30 m at 30 m/s: exactly 1 s, not rounded to a tick.
    expect(lap.sectors[0]).toBeCloseTo(1, 9);
    expect(timing.laps).toBe(1);
  });

  it('reversing back over a line and crossing it again does nothing', () => {
    const ev: TimingEvent[] = [];
    let { timing, t } = drive(newTiming(), 110, 90, 20, 0, ev); // start at S/F
    ({ timing, t } = drive(timing, 90, 110, 5, t, ev)); // reverse back over S/F
    ({ timing, t } = drive(timing, 110, 90, 20, t, ev)); // and forward again
    expect(ev).toEqual([]); // no lap, no sector
    expect(timing.next).toBe(0); // still waiting for S1
    ({ timing } = drive(timing, 90, 60, 20, t, ev));
    expect(ev).toHaveLength(1); // S1 counts normally
  });

  it('a skipped line means the lap does not close (sectors must come in order)', () => {
    const ev: TimingEvent[] = [];
    let { timing, t } = drive(newTiming(), 110, 95, 20, 0, ev); // start
    ({ timing, t } = drive(timing, 101, 95, 20, t, ev)); // "loop" straight back over S/F without S1/S2
    expect(ev).toEqual([]);
    expect(timing.next).toBe(0);
  });

  it('all four wheels off (or a barrier hit) voids the current sector and lap; the next lap is clean', () => {
    const ev: TimingEvent[] = [];
    let { timing, t } = drive(newTiming(), 110, 95, 30, 0, ev);
    ({ timing, t } = drive(timing, 95, 75, 30, t, ev)); // clean
    ({ timing, t } = drive(timing, 75, 72, 30, t, ev, { offTrack: true })); // cut, still in S1
    ({ timing, t } = drive(timing, 72, 10, 30, t, ev));
    ({ timing, t } = drive(timing, 101, 95, 30, t, ev)); // close the lap
    expect(ev.filter((e) => e.type === 'sector').map((e) => e.invalid)).toEqual([true, false, false]);
    expect(ev.find((e) => e.type === 'lap')!.invalid).toBe(true);
    ev.length = 0;
    ({ timing, t } = drive(timing, 95, 75, 30, t, ev, { barrierContact: true })); // barrier, next lap's S1
    expect(timing.lapInvalid && timing.sectorInvalid).toBe(true);
  });

  it('a track with no start/finish line has no timing', () => {
    const ev: TimingEvent[] = [];
    const t = updateTiming(newTiming(), { from: { x: 10, y: 120 }, to: { x: 10, y: 0 }, t0: 0, t1: 1, offTrack: false, barrierContact: false }, { pxPerMeter: 1, timingLines: {} }, 0, ev);
    expect(t.started).toBe(false);
    expect(ev).toEqual([]);
  });
});

describe('timing in the real sim', () => {
  it('a car driving up a straight starts timing at S/F and gets S1/S2 sector events', () => {
    const PPM = 10, w = 300, h = 4000;
    const data = new Uint8Array(w * h).fill(surfaces.findIndex((s) => s.id === 'asphalt'));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 10 || y < 10 || x >= w - 10 || y >= h - 10) data[y * w + x] = surfaces.findIndex((s) => s.id === 'wall');
    const l = (y: number) => ({ a: { x: 280, y }, b: { x: 20, y } });
    const tj: TrackJson = { id: 't', name: 't', pxPerMeter: PPM, files: { mask: 'm' }, racingLine: [], grid: [], spawn: { x: 150, y: 3950, heading: 0 }, timingLines: { startFinish: l(3800), s1: l(2800), s2: l(1800) } };
    const track = createSimTrack(tj, { width: w, height: h, data }, surfaces);
    const ctx: SimContext = { track, walls: traceWalls(track.mask, track.index.wall, track.index.tyreBarrier, wallTracing), physics: structuredClone(physicsJson) as unknown as PhysicsConfig, catalog, rules, contact: contactJson, race: raceJson, slipstream: slipstreamJson, assists: assistsJson, damage: damageJson, ers: ersJson as ErsConfig, evolution: { ...evolutionJson, enabled: false }, strategy: strategyJson as unknown as StrategyConfig, weather: weatherJson as unknown as WeatherConfig, cache: createPhysicsCache() };
    let world: WorldState = createWorld(ctx);
    const events: string[] = [];
    for (let i = 0; i < 60 * 12; i++) {
      world = step(world, [{ throttle: 1, brake: 0, steer: 0 }], ctx);
      for (const e of world.events) if (e.type === 'sector') events.push(`S${e.sector + 1} ${e.time.toFixed(3)}`);
    }
    expect(world.cars[0]!.timing.started).toBe(true);
    expect(events).toHaveLength(2);
    // 100 m sectors: the second (at higher speed) is quicker than the first.
    expect(parseFloat(events[1]!.split(' ')[1]!)).toBeLessThan(parseFloat(events[0]!.split(' ')[1]!));
  });
});
