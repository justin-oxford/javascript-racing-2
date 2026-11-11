// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TimingEvent } from '../../sim';
import { Session, type KeyValueStore } from './session';

function memStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), keys: () => [...map.keys()] };
}
const sector = (s: number, time: number, invalid = false): TimingEvent => ({ type: 'sector', car: 0, sector: s, time, invalid });
const lap = (time: number, sectors: number[], invalid = false): TimingEvent => ({ type: 'lap', car: 0, lap: 1, time, sectors, invalid });
function runLap(s: Session, secs: number[], invalid: boolean[] = [false, false, false]) {
  secs.forEach((t, i) => s.onEvent(sector(i, t, invalid[i]), true));
  s.onEvent(lap(secs.reduce((a, b) => a + b, 0), secs, invalid.some(Boolean)), true);
}
const colors = (s: Session) => s.tiles.map((t) => t.color);

describe('session timing colours (card 04 rules)', () => {
  it('first clean lap is purple (best known); a faster lap is purple again; a slower one yellow', () => {
    const s = new Session(memStore(), 'oxford', 'C1', 'bluebull');
    runLap(s, [10, 20, 30]);
    expect(colors(s)).toEqual(['purple', 'purple', 'purple', 'purple']);
    runLap(s, [9, 21, 30]); // S1 faster; S2 slower; S3 and the lap (60) only equal: not faster
    expect(colors(s)).toEqual(['purple', 'yellow', 'yellow', 'yellow']);
    runLap(s, [9, 20, 29.5]); // 58.5: a new best lap
    expect(colors(s)[3]).toBe('purple');
  });

  it('green = your team PB that another team has already beaten on this spec', () => {
    const store = memStore();
    const fast = new Session(store, 'oxford', 'C1', 'cavalli');
    runLap(fast, [9, 19, 29]);
    const me = new Session(store, 'oxford', 'C1', 'motus');
    runLap(me, [12, 22, 32]); // first Motus lap: its PB, but Cavalli's stored PB is faster -> green
    expect(colors(me)).toEqual(['green', 'green', 'green', 'green']);
    runLap(me, [13, 21, 33]);
    expect(colors(me)).toEqual(['yellow', 'green', 'yellow', 'yellow']);
    expect(me.tiles[1]!.split).toBeCloseTo(-1);
    expect(me.tiles[0]!.split).toBeCloseTo(1);
  });

  it('an invalid sector is dark red and an invalid lap neither counts nor sets a PB', () => {
    const s = new Session(memStore(), 'oxford', 'C1', 'bluebull');
    runLap(s, [10, 20, 30]);
    runLap(s, [8, 18, 28], [false, true, false]);
    expect(colors(s)).toEqual(['purple', 'invalid', 'purple', 'invalid']);
    expect(s.personalBest.lap).toBe(60);
    expect(s.personalBest.sectors).toEqual([8, 20, 28]); // valid sectors still count
    expect(s.average).toBe(60);
    expect(s.completedLaps).toBe(2);
    expect(s.theoreticalBest).toBe(56);
  });

  it('PBs survive a "reload" (new Session on the same store); spec change resets times, team change keeps them', () => {
    const store = memStore();
    const a = new Session(store, 'oxford', 'C1', 'bluebull');
    runLap(a, [10, 20, 30]);
    const b = new Session(store, 'oxford', 'C1', 'bluebull');
    expect(b.personalBest.lap).toBe(60);
    runLap(b, [11, 21, 31]);
    expect(b.lastLap).toBe(63);
    b.changeTeam('cavalli');
    expect(b.lastLap).toBe(63); // kept for comparison
    expect(b.personalBest.lap).toBeUndefined(); // Cavalli has no PB yet
    b.changeSpec('C2');
    expect(b.lastLap).toBeUndefined();
    expect(b.completedLaps).toBe(0);
  });

  it('a new lap wipes the previous lap\'s tiles at S1', () => {
    const s = new Session(memStore(), 'oxford', 'C1', 'bluebull');
    runLap(s, [10, 20, 30]);
    s.onEvent(sector(0, 11), true);
    expect(s.tiles.map((t) => t.time)).toEqual([11, undefined, undefined, undefined]);
  });
});
