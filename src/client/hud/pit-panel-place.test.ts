// @vitest-environment node
// Pit panel placement (HUD v2 card): below the box, clear of the pit lane, on the canvas.
import { describe, expect, it } from 'vitest';
import { loadTrackNode } from '../../../tools/load-track-node';
import { coversPit, placePitPanel } from './pit-panel-place';

/** A synthetic 1000x600 canvas: a pit lane band y 200-260 with a box y 210-240, x 400-440. */
const lane = (x: number, y: number) => x >= 100 && x < 900 && y >= 200 && y < 260;
const base = { box: { x0: 400, y0: 210, x1: 440, y1: 240 }, w: 300, h: 120, width: 1000, height: 600, top: 100, isPit: lane };

describe('pit panel placement', () => {
  it('goes below the lane when directly below the box would cover it', () => {
    const p = placePitPanel(base);
    expect(p.side).toBe('below');
    expect(p.y).toBeGreaterThanOrEqual(260);
    expect(p.x).toBe(270); // centred on the box
    expect(coversPit(p.x, p.y, base.w, base.h, lane, 1)).toBe(false);
  });

  it('clamps sideways to the canvas (a box at the end of the lane)', () => {
    const p = placePitPanel({ ...base, box: { x0: 960, y0: 210, x1: 1000, y1: 240 } });
    expect(p.x).toBe(700);
    expect(p.x + base.w).toBeLessThanOrEqual(1000);
  });

  it('goes above when there is no room below, never into the top bar', () => {
    const lowLane = (x: number, y: number) => y >= 440 && y < 520;
    const p = placePitPanel({ ...base, box: { x0: 400, y0: 450, x1: 440, y1: 480 }, isPit: lowLane });
    expect(p.side).toBe('above');
    expect(p.y + base.h).toBeLessThanOrEqual(440);
    expect(p.y).toBeGreaterThanOrEqual(100);
  });

  it.each(['oxford', 'colon'])('on %s, every box: fully on the canvas, below the top bar, no pit lane or box pixels covered', (id) => {
    const t = loadTrackNode(id).track;
    const { width, height } = t.mask;
    const isPit = (x: number, y: number) => {
      const px = Math.floor(x), py = Math.floor(y);
      if (px < 0 || py < 0 || px >= width || py >= height) return false;
      const s = t.mask.data[py * width + px];
      return s === t.index.pitLane || s === t.index.pitBox;
    };
    expect(t.boxes.length).toBeGreaterThan(1);
    for (const b of t.boxes) {
      const p = placePitPanel({ box: b, w: 1000, h: 300, width, height, top: 100, isPit });
      expect(p.side).not.toBe('clamped');
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x + 1000).toBeLessThanOrEqual(width);
      expect(p.y).toBeGreaterThanOrEqual(100);
      expect(p.y + 300).toBeLessThanOrEqual(height);
      expect(coversPit(p.x, p.y, 1000, 300, isPit, 2)).toBe(false);
    }
  });
});
