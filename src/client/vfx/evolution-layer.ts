// Track evolution visuals (POLISH card): the rubber and marbles drawn FROM the sim's surface grid, so what
// you see is what grips (a darker line = more grip; pebbles off the line = less). Client only.
// Repainted into the static layer whenever it rebuilds (every skid fade step, ~15 s, or on resize): the
// grid changes slowly, so that's often enough and costs no extra rebuilds.
import type { SurfaceGrid } from '../../sim';

/** Marbles are drawn at this many pixels per cell (pebbles need more detail than the soft rubber). */
const MARBLE_PX = 6;

export class EvolutionLayer {
  private readonly rubber = document.createElement('canvas');
  private readonly marbles = document.createElement('canvas');

  constructor(private readonly cfg: { rubberRgb: string; rubberMaxAlpha: number; marbleRgb: string; marbleDots: number }) {}

  /** Draw the grid onto a static-layer rebuild (track-pixel space; `ppm` track pixels per metre). */
  draw(ctx: CanvasRenderingContext2D, g: SurfaceGrid | undefined, ppm: number): void {
    if (!g) return;
    this.paint(g);
    const w = g.w * g.cellM * ppm, h = g.h * g.cellM * ppm; // the grid starts at the track origin
    ctx.save();
    ctx.imageSmoothingEnabled = true; // soft rubber, no cell steps
    ctx.drawImage(this.rubber, 0, 0, w, h);
    ctx.drawImage(this.marbles, 0, 0, w, h);
    ctx.restore();
  }

  private paint(g: SurfaceGrid): void {
    const r = this.rubber;
    if (r.width !== g.w || r.height !== g.h) { r.width = g.w; r.height = g.h; }
    const rc = r.getContext('2d')!;
    const img = rc.createImageData(g.w, g.h), d = img.data;
    const [rr, rg, rb] = this.cfg.rubberRgb.split(',').map(Number);
    for (let i = 0; i < g.w * g.h; i++) {
      d[i * 4] = rr!; d[i * 4 + 1] = rg!; d[i * 4 + 2] = rb!;
      d[i * 4 + 3] = Math.round(255 * this.cfg.rubberMaxAlpha * Math.min(1, g.rubber[i]!));
    }
    rc.putImageData(img, 0, 0);
    const m = this.marbles;
    if (m.width !== g.w * MARBLE_PX || m.height !== g.h * MARBLE_PX) { m.width = g.w * MARBLE_PX; m.height = g.h * MARBLE_PX; }
    const mc = m.getContext('2d')!;
    mc.clearRect(0, 0, m.width, m.height);
    mc.fillStyle = `rgb(${this.cfg.marbleRgb})`;
    for (let i = 0; i < g.w * g.h; i++) {
      const level = g.marbles[i]!;
      if (level < 0.02) continue;
      const n = Math.round(level * this.cfg.marbleDots);
      const cx = (i % g.w) * MARBLE_PX, cy = Math.floor(i / g.w) * MARBLE_PX;
      // Pebbles at fixed pseudo-random spots per cell (stable from one repaint to the next).
      let s = (i * 2654435761) >>> 0;
      for (let k = 0; k < n; k++) {
        s = (s * 1664525 + 1013904223) >>> 0; const x = (s >>> 8) % MARBLE_PX;
        s = (s * 1664525 + 1013904223) >>> 0; const y = (s >>> 8) % MARBLE_PX;
        mc.fillRect(cx + x, cy + y, 1, 1);
      }
    }
  }
}
