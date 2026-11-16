// Ghost car (Replays card): keeps only the quickest valid lap, survives a reload (the store), interpolates
// poses, and refuses another track's ghost file.
import { describe, expect, it } from 'vitest';
import { Ghost, parseGhost, recordTrackKey } from './ghost';

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
  it('a new layout version: its own records key, and ghosts from the old layout are refused cleanly', () => {
    expect(recordTrackKey('oxford', undefined)).toBe('oxford'); // version 1 keeps the old keys
    expect(recordTrackKey('oxford', 1)).toBe('oxford');
    expect(recordTrackKey('oxford', 2)).toBe('oxford@v2');
    const s = store(), v1 = new Ghost(s, 'oxford', 'C1');
    drive(v1, 50);
    v1.onLap(30, false, 'Justin', 60);
    const text = JSON.stringify(v1.ghost);
    expect(new Ghost(s, 'oxford@v2', 'C1').ghost).toBeUndefined(); // the stored v1 ghost isn't shown on v2
    expect(parseGhost(text, 'oxford@v2')).toBe('that ghost was driven on an older oxford layout (v1); this track is v2');
    const v2 = new Ghost(s, 'oxford@v2', 'C1');
    drive(v2, 50);
    v2.onLap(40, false, 'Justin', 60);
    expect(parseGhost(JSON.stringify(v2.ghost), 'oxford@v2')).toMatchObject({ lapTime: 40 });
    expect(new Ghost(s, 'oxford', 'C1').ghost!.lapTime).toBe(30); // v1's own ghost is still kept under its key
  });
});
