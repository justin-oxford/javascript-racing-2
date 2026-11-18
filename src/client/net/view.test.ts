import { describe, expect, it } from 'vitest';
import type { WorldState } from '../../sim';
import { permuteWorld, SnapBuffer, viewOrder } from './view';

describe('viewOrder / permuteWorld', () => {
  it('puts my car first and keeps the rest in order', () => {
    expect(viewOrder(4, 2)).toEqual([2, 0, 1, 3]);
    expect(viewOrder(3, -1)).toEqual([0, 1, 2]);
  });

  it('re-indexes cars, race cars, running order and events together', () => {
    const car = (x: number) => ({ x }) as unknown as WorldState['cars'][number];
    const rc = (slot: number) => ({ slot }) as unknown as NonNullable<WorldState['race']>['cars'][number];
    const w = {
      tick: 9, cars: [car(0), car(1), car(2)],
      events: [{ type: 'lap', car: 2 }],
      race: { order: [1, 2, 0], cars: [rc(0), rc(1), rc(2)] },
    } as unknown as WorldState;
    const v = permuteWorld(w, viewOrder(3, 2));
    expect(v.cars.map((c) => c.x)).toEqual([2, 0, 1]);
    expect(v.race!.cars.map((c) => c.slot)).toEqual([2, 0, 1]);
    // Server order 1, 2, 0 is view order 2, 0, 1.
    expect(v.race!.order).toEqual([2, 0, 1]);
    expect((v.events[0] as { car: number }).car).toBe(0);
  });
});

describe('SnapBuffer', () => {
  const ms = 1000 / 60;
  it('draws the delay behind the server clock, between the two snapshots either side', () => {
    const b = new SnapBuffer<{ tick: number }>(60, 1000);
    // Snapshots every 3 ticks, each arriving 40 ms after the server made it.
    for (let t = 0; t <= 30; t += 3) b.push({ tick: t }, t * ms + 40);
    const now = 30 * ms + 40; // the newest just arrived
    const rt = b.renderTick(now, 100)!;
    expect(rt).toBeCloseTo(30 - 100 / ms, 6); // 6 ticks back
    const br = b.bracket(rt)!;
    expect(br.a.tick + br.alpha * (br.b.tick - br.a.tick)).toBeCloseTo(24, 6);
  });

  it('follows the quickest arrivals, so a late snapshot does not drag the clock', () => {
    const b = new SnapBuffer<{ tick: number }>(60, 1000);
    b.push({ tick: 0 }, 40);
    b.push({ tick: 3 }, 3 * ms + 90); // 50 ms late
    b.push({ tick: 6 }, 6 * ms + 40);
    const rt = b.renderTick(6 * ms + 40, 0)!;
    expect(rt).toBeGreaterThan(5.9);
  });

  it('hands out each snapshot once, in order', () => {
    const b = new SnapBuffer<{ tick: number }>();
    for (const t of [3, 6, 9]) b.push({ tick: t }, t);
    expect(b.take(6).map((s) => s.tick)).toEqual([3, 6]);
    expect(b.take(9).map((s) => s.tick)).toEqual([9]);
    expect(b.take(9)).toEqual([]);
    b.push({ tick: 8 }, 0); // older than the newest: ignored
    expect(b.snaps.map((s) => s.tick)).toEqual([3, 6, 9]);
  });

  it('interpolates between snapshots', () => {
    const b = new SnapBuffer<{ tick: number }>();
    b.push({ tick: 3 }, 0);
    b.push({ tick: 6 }, 0);
    const br = b.bracket(4)!;
    expect([br.a.tick, br.b.tick]).toEqual([3, 6]);
    expect(br.alpha).toBeCloseTo(1 / 3);
  });
});
