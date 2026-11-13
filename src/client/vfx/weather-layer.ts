// Wet weather visuals (POLISH card), client only, drawn FROM the sim's water layer: standing water darkens
// the track (the dry line shows as a lighter strip), rain falls as streaks, and every car shows a blinking red
// rain light at the gearbox while it rains or the track is wet. The water canvas is repainted twice a second
// (the dry line forms over laps; per-frame repaints would be wasted).
import { bodyOffsetM, type CarState, type PhysicsConfig, type SurfaceGrid, type WorldState } from '../../sim';

export class WeatherLayer {
  private readonly water = document.createElement('canvas');
  private paintedAt = -Infinity;
  private hasWater = false;

  /** Standing water under the cars (track-pixel space; `ppm` track pixels per metre). */
  drawWater(ctx: CanvasRenderingContext2D, g: SurfaceGrid | undefined, ppm: number, now: number): void {
    if (!g?.water) return;
    if (now - this.paintedAt > 500) this.paint(g, now);
    if (!this.hasWater) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.water, 0, 0, g.w * g.cellM * ppm, g.h * g.cellM * ppm);
    ctx.restore();
  }

  private paint(g: SurfaceGrid, now: number): void {
    this.paintedAt = now;
    const c = this.water;
    if (c.width !== g.w || c.height !== g.h) { c.width = g.w; c.height = g.h; }
    const cx = c.getContext('2d')!, img = cx.createImageData(g.w, g.h), d = img.data;
    this.hasWater = false;
    for (let i = 0; i < g.w * g.h; i++) {
      const v = Math.min(1, g.water![i] ?? 0);
      if (v > 0.01) this.hasWater = true;
      // Dark blue-grey, deeper water darker; a touch of sheen (lighter blue) on the deepest.
      d[i * 4] = 20 + 30 * v; d[i * 4 + 1] = 32 + 40 * v; d[i * 4 + 2] = 52 + 70 * v;
      d[i * 4 + 3] = Math.round(255 * 0.5 * v);
    }
    cx.putImageData(img, 0, 0);
  }

  /** Rain streaks over everything (track-pixel space), `rain` 0..1. */
  drawRain(ctx: CanvasRenderingContext2D, rain: number, widthPx: number, heightPx: number, now: number): void {
    if (rain <= 0.01) return;
    const n = Math.round(rain * 400), t = now / 1000;
    ctx.save();
    ctx.strokeStyle = `rgba(200, 215, 235, ${0.25 + 0.25 * rain})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      // Fixed pseudo-random columns, falling diagonally with time.
      let s = (k * 2654435761) >>> 0;
      s = (s * 1664525 + 1013904223) >>> 0; const x0 = (s >>> 8) % widthPx;
      s = (s * 1664525 + 1013904223) >>> 0; const y0 = (s >>> 8) % heightPx;
      const y = (y0 + t * 900) % heightPx, x = (x0 + t * 250) % widthPx;
      ctx.moveTo(x, y);
      ctx.lineTo(x + 6, y + 22);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Blinking red rain lights at each car's gearbox while it's wet (track-pixel space). */
  drawRainLights(ctx: CanvasRenderingContext2D, world: WorldState, physics: PhysicsConfig, ppm: number, now: number): void {
    if (Math.floor(now / 250) % 2) return; // 2 Hz blink
    ctx.save();
    ctx.fillStyle = 'rgba(255, 40, 30, 0.95)';
    for (const car of world.cars) this.light(ctx, car, physics, ppm);
    ctx.restore();
  }

  private light(ctx: CanvasRenderingContext2D, car: CarState, physics: PhysicsConfig, ppm: number): void {
    const back = physics.car.lengthM / 2 - bodyOffsetM(physics); // CG to the rear of the body
    const fx = Math.sin(car.heading), fy = -Math.cos(car.heading);
    const x = (car.x - fx * back) * ppm, y = (car.y - fy * back) * ppm, r = 0.35 * ppm;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
}
