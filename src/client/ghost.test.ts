// Ghost car (Replays card): keeps only the quickest valid lap, survives a reload (the store), interpolates
// poses, and refuses another track's ghost file.
import { describe, expect, it } from 'vitest';
import { Ghost, parseGhost } from './ghost';

const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
/** A lap of `ticks` ticks driving straight along x at 1 m a tick. */
function drive(g: Ghost, ticks: number): void {
  g.tick(0, 0, 0, true, true); // crossing the line
  for (let t = 1; t < ticks; t++) g.tick(t, 0, 0, true, false);
}

describe('ghost', () => {
  it('keeps the quickest valid lap only, and it is there after a reload', () => {
    const s = store(), g = new Ghost(s, 'oxford', 'C1');
    drive(g, 100);
    expect(g.onLap(30, false, 'Justin', 60)).toBe(true);
    drive(g, 100);
    expect(g.onLap(31, false, 'Justin', 60)).toBe(false); // slower
    drive(g, 100);
    expect(g.onLap(29, true, 'Justin', 60)).toBe(false); // invalid
    expect(g.ghost!.lapTime).toBe(30);
    expect(new Ghost(s, 'oxford', 'C1').ghost!.lapTime).toBe(30);
    expect(new Ghost(s, 'oxford', 'C2').ghost).toBeUndefined(); // per spec
  });

  it('replays the poses (interpolated) and stops at the end of the lap', () => {
    const g = new Ghost(store(), 'oxford', 'C1');
    drive(g, 100);
    g.onLap(30, false, 'Justin', 60);
    expect(g.poseAt(10.5 / 60)!.x).toBeCloseTo(10.5, 6);
    expect(g.poseAt(200 / 60)).toBeUndefined();
  });

  it('a ghost file for another track is refused', () => {
    const g = new Ghost(store(), 'oxford', 'C1');
    drive(g, 50);
    g.onLap(30, false, 'Justin', 60);
    const text = JSON.stringify(g.ghost);
    expect(typeof parseGhost(text, 'oxford')).toBe('object');
    expect(parseGhost(text, 'indiana')).toContain('for oxford');
    expect(parseGhost('{"x":1}', 'oxford')).toBe('not a ghost file');
  });
});
