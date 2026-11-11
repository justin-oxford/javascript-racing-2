// Draw the timing lines on the track, from track.json, clipped to legal surface (asphalt, kerb, pit
// lane, pit box per the mask) so each spans exactly the track width wherever its ends were placed.
// Never painted into art: the line you see is the line that times you. Drawn under rubber and skids.
import type { SimTrack, TimingKey, TimingLine } from '../../sim';
import { TIMING_KEYS, surfaceAt } from '../../sim';
import type hudJson from '../../../config/hud.json';
import type { TileColor } from './session';

export type HudConfig = typeof hudJson;

interface Run {
  x0: number; y0: number; x1: number; y1: number;
}

/** The legal stretches along a line, in mask pixels. */
export function legalRuns(track: SimTrack, line: TimingLine, stepPx: number): Run[] {
  const { a, b } = line;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len / stepPx));
  const runs: Run[] = [];
  let start = -1;
  for (let i = 0; i <= n + 1; i++) {
    const f = Math.min(1, i / n);
    const legal = i <= n && track.surfaces[surfaceAt(track, a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f)]?.legal;
    if (legal && start < 0) start = i;
    if (!legal && start >= 0) {
      const f0 = start / n, f1 = Math.min(1, (i - 1) / n);
      if (f1 > f0) runs.push({ x0: a.x + (b.x - a.x) * f0, y0: a.y + (b.y - a.y) * f0, x1: a.x + (b.x - a.x) * f1, y1: a.y + (b.y - a.y) * f1 });
      start = -1;
    }
  }
  return runs;
}

const LABEL: Record<TimingKey, string> = { startFinish: '', s1: 'S1', s2: 'S2' };

export class TimingLines {
  private flash: { key: TimingKey; color: string; until: number } | undefined;

  constructor(private readonly cfg: HudConfig) {}

  /** Your car crossed a line: flash it in the sector colour. */
  flashLine(key: TimingKey, color: TileColor, now: number): void {
    const c = this.cfg.colors;
    const hex = color === 'purple' ? c.purple : color === 'green' ? c.green : color === 'yellow' ? c.yellow : color === 'invalid' ? c.invalidLive : undefined;
    if (hex) this.flash = { key, color: hex, until: now + this.cfg.lines.flashSec * 1000 };
  }

  draw(ctx: CanvasRenderingContext2D, track: SimTrack, now: number): void {
    const l = this.cfg.lines;
    const ppm = track.json.pxPerMeter;
    for (const key of TIMING_KEYS) {
      const line = track.json.timingLines[key];
      if (!line) continue;
      const runs = legalRuns(track, line, l.sampleStepPx);
      if (!runs.length) continue;
      const sf = key === 'startFinish';
      const flashing = this.flash && this.flash.key === key && now < this.flash.until ? this.flash : undefined;
      ctx.save();
      ctx.globalAlpha = sf ? 1 : l.sectorAlpha;
      ctx.strokeStyle = flashing?.color ?? (sf ? l.startFinishColor : l.sectorColor);
      ctx.lineWidth = (sf ? l.startFinishWidthM : l.sectorWidthM) * ppm * (flashing ? 1.8 : 1);
      ctx.lineCap = 'butt';
      ctx.beginPath();
      for (const r of runs) {
        ctx.moveTo(r.x0, r.y0);
        ctx.lineTo(r.x1, r.y1);
      }
      ctx.stroke();
      // "S1"/"S2" marker at the track edge: just past the end of the longest run, at the line's b end.
      if (!sf) {
        const main = runs.reduce((p, r) => (Math.hypot(r.x1 - r.x0, r.y1 - r.y0) > Math.hypot(p.x1 - p.x0, p.y1 - p.y0) ? r : p));
        const dx = main.x1 - main.x0, dy = main.y1 - main.y0, d = Math.hypot(dx, dy) || 1;
        const size = l.markerSizeM * ppm;
        ctx.globalAlpha = 1;
        ctx.fillStyle = flashing?.color ?? l.markerColor;
        ctx.font = `bold ${size}px "Formula1 Bold", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(LABEL[key], main.x1 + (dx / d) * size * 0.9, main.y1 + (dy / d) * size * 0.9);
      }
      ctx.restore();
    }
  }
}
