// Wet weather + emergent dry line (POLISH card). Water is another layer on the track evolution grid (plain
// state): rain adds it, wheels clear it where they run (the dry line), it dries when the rain stops, and rain
// washes rubber and marbles away. Weather over a session is a seeded rain curve, so the server and replays get
// the same rain. Pure functions over plain data.
import type { SimTrack } from './track';
import type { SurfaceGrid, WheelWork } from './evolution';
import { drivableCells } from './evolution';

export type WeatherMode = 'dry' | 'wet' | 'changeable';

/** config/weather.json. */
export interface WeatherConfig {
  /** Water a cell gains per second at full rain; loses per second drying (no rain), x offLineDry off the line. */
  rainPerSec: number;
  dryPerSec: number;
  /** Cells nobody drives over dry this much slower (the dry line dries first: cars clear it and warm it). */
  offLineDry: number;
  /** A wheel clears clearPerSec of water x its load share x speed / clearRefMps (capped at 2x) from its cell. */
  clearPerSec: number;
  clearRefMps: number;
  /** Rain washes rubber and marbles away (per second at full rain). */
  washRubberPerSec: number;
  washMarblesPerSec: number;
  /** In the wet, rubber is slippery: its grip bonus becomes -wetRubber x gripBonus at full water. */
  wetRubber: number;
  /** Aquaplaning: water deeper than depth, above speedMps, grip x grip. */
  aquaplane: { depth: number; speedMps: number; grip: number };
  /** Wet: rain at intensity all session. Changeable: dry, then a shower (seeded start, length, intensity), then dry. */
  wet: { intensity: number };
  changeable: { startSec: [number, number]; lengthSec: [number, number]; intensity: [number, number]; rampSec: number };
  /** Starting water for a Wet session (the track is already wet). */
  wetStartWater: number;
  /** AI tyre calls by the water under its line (averaged over the next lookM). */
  /** slickOffLineWater (absent: off): on slicks, never steer off the racing line onto water deeper than this (and
   *  deeper than on the line by slickOffLineMargin, default 0.1): the dry line is the only grip a slick has. */
  ai: { interAbove: number; wetAbove: number; slickBelow: number; lookM: number; slickOffLineWater?: number; slickOffLineMargin?: number };
}

/** A seeded number in 0..1 from the session seed and a salt (no RNG state needed: the curve is a pure function). */
function hash01(seed: number, salt: number): number {
  let x = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The shower of a Changeable session: when it starts and stops (seconds) and how hard it rains. */
export function shower(seed: number, cfg: WeatherConfig): { start: number; end: number; intensity: number } {
  const c = cfg.changeable;
  const start = lerp(c.startSec[0], c.startSec[1], hash01(seed, 1));
  return { start, end: start + lerp(c.lengthSec[0], c.lengthSec[1], hash01(seed, 2)), intensity: lerp(c.intensity[0], c.intensity[1], hash01(seed, 3)) };
}

/** Rain intensity 0..1 at `sec` seconds into the session. */
export function rainAt(sec: number, mode: WeatherMode | undefined, seed: number, cfg: WeatherConfig): number {
  if (!mode || mode === 'dry') return 0;
  if (mode === 'wet') return cfg.wet.intensity;
  const s = shower(seed, cfg), r = Math.max(1e-6, cfg.changeable.rampSec);
  if (sec <= s.start || sec >= s.end) return 0;
  return s.intensity * Math.min(1, (sec - s.start) / r, (s.end - sec) / r);
}

/** Water depth 0..1 under a point (bilinear, like the other layers). */
export function waterAt(g: SurfaceGrid | undefined, x: number, y: number): number {
  if (!g?.water) return 0;
  const fx = x / g.cellM - 0.5, fy = y / g.cellM - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const at = (cx: number, cy: number) => (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h ? 0 : g.water![cy * g.w + cx]!);
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

/** A session's starting water: none, or (Wet) the whole drivable track at wetStartWater. */
export function startWater(g: SurfaceGrid, track: SimTrack, mode: WeatherMode | undefined, cfg: WeatherConfig): SurfaceGrid {
  if (mode !== 'wet') return g.water ? { ...g, water: undefined } : g;
  const ok = drivableCells(track, g);
  return { ...g, water: Array.from({ length: g.w * g.h }, (_, i) => (ok[i] ? cfg.wetStartWater : 0)) };
}

/**
 * One tick of water: rain adds it everywhere drivable, wheels clear it where they run, and without rain it
 * dries (offLineDry x slower where no wheel ran this tick); rain washes rubber and marbles away. Returns a new
 * grid (the same one when there's no water and no rain).
 */
export function updateWater(g: SurfaceGrid, track: SimTrack, wheels: readonly (WheelWork & { speed: number })[], rain: number, dt: number, cfg: WeatherConfig): SurfaceGrid {
  if (!g.water && rain <= 0) return g;
  const ok = drivableCells(track, g);
  const water = g.water ? g.water.slice() : new Array<number>(g.w * g.h).fill(0);
  const driven = new Uint8Array(g.w * g.h);
  for (const wh of wheels) {
    if (!wh.moving) continue;
    const cx = Math.floor(wh.x / g.cellM), cy = Math.floor(wh.y / g.cellM);
    if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) continue;
    const i = cy * g.w + cx;
    driven[i] = 1;
    water[i] = Math.max(0, water[i]! - cfg.clearPerSec * dt * Math.min(2, wh.load) * Math.min(2, wh.speed / cfg.clearRefMps));
  }
  const add = rain * cfg.rainPerSec * dt, dry = cfg.dryPerSec * dt * (1 - Math.min(1, rain * 4));
  let any = false;
  for (let i = 0; i < water.length; i++) {
    if (!ok[i]) { water[i] = 0; continue; }
    const v = water[i]! + add - (driven[i] ? dry : dry / Math.max(1, cfg.offLineDry));
    water[i] = Math.max(0, Math.min(1, v));
    if (water[i]! > 0) any = true;
  }
  const wash = (layer: number[], perSec: number) => (rain > 0 && perSec > 0 ? layer.map((v) => Math.max(0, v - perSec * rain * dt)) : layer);
  return { ...g, water: any ? water : undefined, rubber: wash(g.rubber, cfg.washRubberPerSec), marbles: wash(g.marbles, cfg.washMarblesPerSec) };
}
