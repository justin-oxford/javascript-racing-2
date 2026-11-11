// K debug layer (and the editor's overlays): mask, walls, timing lines, racing line, grid, spawn,
// wheel sample points. Everything in track-pixel space.
import type { PhysicsConfig, Pose, TimingLine, TrackJson, WallChain, WorldState } from '../sim';
import { wheelPositions } from '../sim';
import { interpolatePose } from './render';
import { surfaces } from './track-loader';

export const TIMING_COLORS: Record<string, string> = { startFinish: '#ff3b3b', s1: '#ffd400', s2: '#ffd400' };

export function drawMask(ctx: CanvasRenderingContext2D, mask: HTMLCanvasElement, opacity: number): void {
  if (opacity <= 0) return;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
}

export function drawWalls(ctx: CanvasRenderingContext2D, walls: readonly WallChain[], lw: number): void {
  ctx.save();
  ctx.lineWidth = lw * 1.5;
  ctx.lineJoin = 'round';
  for (const w of walls) {
    ctx.strokeStyle = w.barrier ? '#ff00ff' : '#ff8c00';
    ctx.beginPath();
    for (let i = 0; i < w.points.length; i += 2) {
      if (i === 0) ctx.moveTo(w.points[0]!, w.points[1]!);
      else ctx.lineTo(w.points[i]!, w.points[i + 1]!);
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

/** Timing line plus an arrow along its valid crossing direction (right-hand normal of a -> b). */
export function drawTimingLine(ctx: CanvasRenderingContext2D, line: TimingLine, color: string, label: string, lw: number): void {
  const { a, b } = line;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len; // right-hand normal, screen coords
  const arrow = 14 * lw;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw * 2;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.moveTo(mx, my);
  ctx.lineTo(mx + nx * arrow, my + ny * arrow);
  ctx.stroke();
  ctx.beginPath();
  const tx = mx + nx * arrow, ty = my + ny * arrow;
  ctx.moveTo(tx + nx * 5 * lw, ty + ny * 5 * lw);
  ctx.lineTo(tx - ny * 4 * lw, ty + nx * 4 * lw);
  ctx.lineTo(tx + ny * 4 * lw, ty - nx * 4 * lw);
  ctx.fill();
  ctx.font = `${11 * lw}px monospace`;
  ctx.fillText(label, mx - nx * 6 * lw + 3 * lw, my - ny * 6 * lw);
  ctx.restore();
}

export function drawRacingLine(ctx: CanvasRenderingContext2D, pts: TrackJson['racingLine'], lw: number): void {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = lw * 1.5;
  ctx.setLineDash([6 * lw, 4 * lw]);
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/** A pose marker: box with a heading tick. */
export function drawPose(ctx: CanvasRenderingContext2D, p: Pose, color: string, label: string, lw: number): void {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.heading);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw * 1.5;
  ctx.strokeRect(-6, -15, 12, 30);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -22);
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `${10 * lw}px monospace`;
  ctx.fillText(label, p.x + 9, p.y - 9);
  ctx.restore();
}

export function drawTrackData(ctx: CanvasRenderingContext2D, json: TrackJson, lw: number): void {
  drawRacingLine(ctx, json.racingLine, lw);
  for (const [k, line] of Object.entries(json.timingLines)) if (line) drawTimingLine(ctx, line, TIMING_COLORS[k] ?? '#fff', k === 'startFinish' ? 'S/F' : k.toUpperCase(), lw);
  json.grid.forEach((g, i) => drawPose(ctx, g, '#ffffff', String(i + 1), lw));
  drawPose(ctx, json.spawn, '#39ff14', 'R', lw);
}

/** Each wheel's sample point, filled with the colour of the surface it's on. */
export function drawWheels(ctx: CanvasRenderingContext2D, prev: WorldState, curr: WorldState, alpha: number, physics: PhysicsConfig, pxPerMeter: number, lw: number): void {
  ctx.save();
  ctx.lineWidth = lw;
  curr.cars.forEach((car, i) => {
    const pose = interpolatePose(prev.cars[i], car, alpha);
    wheelPositions(pose, physics).forEach((p, w) => {
      ctx.fillStyle = surfaces[car.wheels[w]?.surface ?? -1]?.color ?? '#fff';
      ctx.strokeStyle = '#000';
      ctx.beginPath();
      ctx.arc(p.x * pxPerMeter, p.y * pxPerMeter, 2.5 * lw, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  });
  ctx.restore();
}
