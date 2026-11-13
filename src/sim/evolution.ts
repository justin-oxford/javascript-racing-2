// Track evolution (POLISH card): the surface changes as cars drive on it, and it's gameplay, so it's sim
// state. A coarse grid over the drivable track (asphalt + kerb), each cell holding:
//   rubber  0..1  laid by every wheel where it runs (by load and slip): more grip, up to rubber.gripBonus
//   marbles 0..1  shed from tyre wear and thrown to the outside of corners: less grip (marbles.gripLoss);
//                 wheels running over them slowly sweep them away
// Wheel grip x (1 + gripBonus x rubber) x (1 - gripLoss x marbles), sampled bilinearly so grip doesn't
// step at cell edges. Plain number[] (JSON snapshots, rebuild from any tick). Built to take another layer
// (the Wet weather card's water) the same way.
import type { Point, SimTrack } from './track';

/** config/evolution.json. */
export interface EvolutionConfig {
  enabled: boolean;
  /** Cell size, metres (fixed when a session's grid is made). */
  cellM: number;
  rubber: { layPerSec: number; gripBonus: number };
  marbles: { shedPerWear: number; throwM: number; gripLoss: number; sweepPerSec: number };
  /** Between sessions (race weekend): marbles swept, rubber kept minus this share. */
  sessions: { rubberLoss: number };
  /** Starting state of a new weekend: rubber along the racing line for 'medium' / 'rubbered', over lineWidthM. */
  start: { medium: number; rubbered: number; lineWidthM: number };
  /** Client only: how the grid is drawn. */
  visual?: { rubberRgb: string; rubberMaxAlpha: number; marbleRgb: string; marbleDots: number };
}

export type TrackStart = 'green' | 'medium' | 'rubbered';

/** The evolving surface (plain data on the world). Cells row-major, `w` x `h`, each `cellM` metres. */
export interface SurfaceGrid {
  w: number;
  h: number;
  cellM: number;
  rubber: number[];
  marbles: number[];
  /** Wet weather card: standing water 0..1 per cell; absent = a dry track (weather.ts). */
  water?: number[] | undefined;
}

// Which cells are drivable track (static per track + cell size, not state).
const drivableCache = new WeakMap<SimTrack, Map<number, Uint8Array>>();
function drivable(track: SimTrack, cellM: number, w: number, h: number): Uint8Array {
  let m = drivableCache.get(track);
  if (!m) drivableCache.set(track, (m = new Map()));
  let d = m.get(cellM);
  if (d) return d;
  d = new Uint8Array(w * h);
  const ppm = track.json.pxPerMeter, mw = track.mask.width, mh = track.mask.height, data = track.mask.data;
  const { pitLane, pitBox } = track.index;
  // A cell is track if any of a 3x3 sample inside it is racing surface: legal, not the pit lane.
  const isTrack = (s: number) => !!track.surfaces[s]?.legal && s !== pitLane && s !== pitBox;
  for (let cy = 0; cy < h; cy++)
    for (let cx = 0; cx < w; cx++) {
      let hit = false;
      for (let sy = 0; sy < 3 && !hit; sy++)
        for (let sx = 0; sx < 3 && !hit; sx++) {
          const px = Math.floor(((cx + (sx + 0.5) / 3) * cellM) * ppm), py = Math.floor(((cy + (sy + 0.5) / 3) * cellM) * ppm);
          if (px < mw && py < mh) hit = isTrack(data[py * mw + px]!);
        }
      d[cy * w + cx] = hit ? 1 : 0;
    }
  m.set(cellM, d);
  return d;
}

/** Which cells of a grid are drivable track (weather.ts uses it for rain). */
export function drivableCells(track: SimTrack, g: Pick<SurfaceGrid, 'w' | 'h' | 'cellM'>): Uint8Array {
  return drivable(track, g.cellM, g.w, g.h);
}

/** A green track: no rubber, no marbles. */
export function newSurfaceGrid(track: SimTrack, cfg: EvolutionConfig): SurfaceGrid {
  const ppm = track.json.pxPerMeter;
  const w = Math.ceil(track.mask.width / ppm / cfg.cellM), h = Math.ceil(track.mask.height / ppm / cfg.cellM);
  return { w, h, cellM: cfg.cellM, rubber: new Array<number>(w * h).fill(0), marbles: new Array<number>(w * h).fill(0) };
}

/** A new weekend that isn't green: rubber laid along the racing line (track pixels), fading over lineWidthM. */
export function seedRubber(g: SurfaceGrid, track: SimTrack, line: readonly Point[], start: TrackStart, cfg: EvolutionConfig): SurfaceGrid {
  if (start === 'green' || line.length < 2) return g;
  const level = start === 'medium' ? cfg.start.medium : cfg.start.rubbered;
  const ppm = track.json.pxPerMeter, half = cfg.start.lineWidthM / 2, ok = drivable(track, g.cellM, g.w, g.h);
  const rubber = g.rubber.slice();
  for (let cy = 0; cy < g.h; cy++)
    for (let cx = 0; cx < g.w; cx++) {
      const i = cy * g.w + cx;
      if (!ok[i]) continue;
      const x = (cx + 0.5) * g.cellM, y = (cy + 0.5) * g.cellM;
      let best = Infinity;
      for (let k = 0; k < line.length; k++) {
        const a = line[k]!, b = line[(k + 1) % line.length]!;
        best = Math.min(best, segDist(x, y, a.x / ppm, a.y / ppm, b.x / ppm, b.y / ppm));
        if (best < 0.01) break;
      }
      if (best < half + g.cellM) rubber[i] = Math.max(rubber[i]!, level * Math.max(0, 1 - Math.max(0, best - half) / g.cellM));
    }
  return { ...g, rubber };
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Between sessions: marbles swept to zero, rubber kept minus sessions.rubberLoss. */
export function nextSession(g: SurfaceGrid, cfg: EvolutionConfig): SurfaceGrid {
  const keep = 1 - cfg.sessions.rubberLoss;
  return { ...g, rubber: g.rubber.map((r) => r * keep), marbles: new Array<number>(g.w * g.h).fill(0) }; // (water carries over: weather.ts)
}

/** Bilinear sample of a layer at (x, y) metres (cell centres). */
function sample(g: SurfaceGrid, layer: number[], x: number, y: number): number {
  const fx = x / g.cellM - 0.5, fy = y / g.cellM - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const at = (cx: number, cy: number) => (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h ? 0 : layer[cy * g.w + cx]!);
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

/** What's under a point: rubber and marbles 0..1 (telemetry). */
export function surfaceAtPoint(g: SurfaceGrid | undefined, x: number, y: number): { rubber: number; marbles: number } {
  return g ? { rubber: sample(g, g.rubber, x, y), marbles: sample(g, g.marbles, x, y) } : { rubber: 0, marbles: 0 };
}

/** Grip multiplier for a wheel at (x, y) metres. With water (`wetRubber` from weather.json): rubber is
 *  slippery in the wet, its bonus turning into -wetRubber x gripBonus at full water, so the dry-weather line
 *  is the worst place to be in the rain. */
export function evolutionGrip(g: SurfaceGrid | undefined, x: number, y: number, cfg: EvolutionConfig, water = 0, wetRubber = 0): number {
  if (!g || !cfg.enabled) return 1;
  const s = surfaceAtPoint(g, x, y);
  const rubberFx = 1 - water * (1 + wetRubber); // 1 dry, -wetRubber at full water
  return (1 + cfg.rubber.gripBonus * s.rubber * rubberFx) * (1 - cfg.marbles.gripLoss * s.marbles);
}

/** One wheel's effect this tick (what update() needs from the car step). */
export interface WheelWork {
  x: number;
  y: number;
  /** Load as a fraction of a quarter of the car's weight (1 = static share). */
  load: number;
  /** Combined slip as a fraction of the tyre's peak (wheel.usage). */
  usage: number;
  /** Tyre worn this tick (0..1 of the tyre). */
  wear: number;
  /** Unit vector toward the outside of the corner (world), and how hard it's cornering (0..1+). */
  outX: number;
  outY: number;
  corner: number;
  /** Moving (a parked car lays nothing). */
  moving: boolean;
}

/** One tick: wheels lay rubber, wear sheds marbles thrown outward, wheels sweep marbles. Returns a new grid. */
export function updateSurface(g: SurfaceGrid, track: SimTrack, wheels: readonly WheelWork[], dt: number, cfg: EvolutionConfig): SurfaceGrid {
  if (!cfg.enabled || !wheels.length) return g;
  const ok = drivable(track, g.cellM, g.w, g.h);
  let rubber: number[] | undefined, marbles: number[] | undefined;
  const cell = (x: number, y: number) => {
    const cx = Math.floor(x / g.cellM), cy = Math.floor(y / g.cellM);
    return cx < 0 || cy < 0 || cx >= g.w || cy >= g.h ? -1 : cy * g.w + cx;
  };
  for (const wh of wheels) {
    if (!wh.moving) continue;
    const i = cell(wh.x, wh.y);
    if (i >= 0 && ok[i]) {
      // Rubber: by load and slip (a loaded, working tyre lays more).
      const lay = cfg.rubber.layPerSec * dt * Math.min(2, wh.load) * (0.5 + Math.min(1.5, wh.usage));
      if (lay > 0) { rubber ??= g.rubber.slice(); rubber[i] = Math.min(1, rubber[i]! + lay); }
      // Sweep: running over marbles clears them.
      const m = (marbles ?? g.marbles)[i]!;
      if (m > 0) { marbles ??= g.marbles.slice(); marbles[i] = Math.max(0, m - cfg.marbles.sweepPerSec * dt); }
    }
    // Marbles: what the tyre sheds lands to the outside of the corner, further the harder it corners.
    if (wh.wear > 0) {
      const d = cfg.marbles.throwM * Math.min(1.5, wh.corner);
      const j = cell(wh.x + wh.outX * d, wh.y + wh.outY * d);
      if (j >= 0 && ok[j]) { marbles ??= g.marbles.slice(); marbles[j] = Math.min(1, marbles[j]! + wh.wear * cfg.marbles.shedPerWear); }
    }
  }
  return rubber || marbles ? { ...g, rubber: rubber ?? g.rubber, marbles: marbles ?? g.marbles } : g;
}
