// Track data as the sim sees it. Pure: no image decoding here. Loaders (browser canvas,
// Node pngjs) produce RGBA; snapToPalette turns it into palette indices; the sim only
// ever reads the index array.
import type { Pose } from './types';

export interface Point {
  x: number;
  y: number;
}

/**
 * A directed timing line a -> b. The valid crossing direction is the right-hand normal
 * of a -> b in screen coordinates (x right, y down): crossing from its left side to its right.
 */
export interface TimingLine {
  a: Point;
  b: Point;
}

export type TimingKey = 'startFinish' | 's1' | 's2';
export const TIMING_KEYS: readonly TimingKey[] = ['startFinish', 's1', 's2'];

/**
 * tracks/<id>/track.json. Coordinates are mask pixels.
 * File paths are relative to the track folder; a leading "/" means relative to the site root (public/).
 */
export interface TrackJson {
  id: string;
  name: string;
  /** Test fixture (Indiana): never shown in a player-facing track list. */
  fixture?: boolean;
  pxPerMeter: number;
  files: {
    /** What players see. Missing file = blockout (the mask drawn in muted colours). */
    background?: string;
    mask: string;
    /** Used when `mask` doesn't exist yet. */
    maskDraft?: string;
    /** Things cars drive under. */
    overhead?: string;
  };
  /** Placed in the editor; a freshly blocked-out track has none yet. */
  timingLines: Partial<Record<TimingKey, TimingLine>>;
  /** Closed polyline in driving order. */
  racingLine: Point[];
  /** Ordered grid slots. */
  grid: Pose[];
  /** Where R puts you. */
  spawn: Pose;
}

export interface TrackListing {
  id: string;
  /** Test fixtures (Indiana) never appear in a player-facing list. */
  fixture: boolean;
}

/** The track the game opens on: the first authored (non-fixture) track, else the first fixture. */
export function defaultTrackId(tracks: readonly TrackListing[]): string | undefined {
  return (tracks.find((t) => !t.fixture) ?? tracks[0])?.id;
}

/** Tracks a player may pick from: never fixtures. */
export function playerTracks(tracks: readonly TrackListing[]): TrackListing[] {
  return tracks.filter((t) => !t.fixture);
}

/** What a track folder gives us before its mask is loaded: track.json if it exists, else just an id. */
export type TrackJsonStub = Partial<TrackJson> & { id: string };

export interface TrackDefaults {
  pxPerMeter: number;
  files: { mask: string; background: string; overhead: string };
}

/** Folder with only a mask (the blockout stage): file names we expect to find there. */
export function stubTrackJson(id: string, defaults: TrackDefaults): TrackJsonStub {
  return { id, files: { ...defaults.files } };
}

/**
 * Fill in whatever a track.json doesn't have yet. Existing keys are never touched, so a complete
 * track.json comes back unchanged (the editor's lossless export depends on this).
 * Default spawn: the middle of the pit box nearest the image centre, else the nearest legal pixel. Heading 0.
 */
export function completeTrackJson(stub: TrackJsonStub, mask: TrackMask, surfaces: readonly SurfaceDef[], defaults: TrackDefaults): TrackJson {
  const json = stub as TrackJson;
  json.name ??= stub.id;
  json.pxPerMeter ??= defaults.pxPerMeter;
  json.files ??= { ...defaults.files };
  json.timingLines ??= {};
  json.racingLine ??= [];
  json.grid ??= [];
  if (!json.spawn) {
    const idx = resolveSurfaceIndex(surfaces);
    const box = nearestToCentre(mask, (s) => s === idx.pitBox);
    const pick = box ? regionCentroid(mask, box) : nearestToCentre(mask, (s) => surfaces[s]!.legal);
    json.spawn = pick ? { x: pick.x + 0.5, y: pick.y + 0.5, heading: 0 } : { x: mask.width / 2, y: mask.height / 2, heading: 0 };
  }
  return json;
}

/** Centre of the 4-connected same-surface region containing `seed` (so a car spawns mid-box, not on its edge). */
function regionCentroid(mask: TrackMask, seed: Point): Point {
  const { width: w, data } = mask;
  const want = data[seed.y * w + seed.x]!;
  const seen = new Uint8Array(data.length);
  const stack = [seed.y * w + seed.x];
  let sx = 0, sy = 0, n = 0;
  while (stack.length) {
    const i = stack.pop()!;
    if (seen[i] || data[i] !== want) continue;
    seen[i] = 1;
    const x = i % w, y = (i - x) / w;
    sx += x; sy += y; n++;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (i + w < data.length) stack.push(i + w);
  }
  return { x: Math.round(sx / n), y: Math.round(sy / n) };
}

function nearestToCentre(mask: TrackMask, want: (s: number) => boolean): Point | undefined {
  const cx = mask.width / 2, cy = mask.height / 2;
  let best: Point | undefined, bestD = Infinity;
  for (let y = 0; y < mask.height; y++)
    for (let x = 0; x < mask.width; x++) {
      if (!want(mask.data[y * mask.width + x]!)) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
  return best;
}

export interface SurfaceDef {
  id: string;
  /** Mask palette colour. */
  color: string;
  /** Muted colour used to draw the mask when a track has no background art yet. */
  blockout: string;
  /** Multiplies the grip of a wheel on this surface. */
  grip: number;
  /** Rolling resistance of a wheel on this surface, as a fraction of its load (gravel slows hard). */
  rollingDrag: number;
  /** Counts as on track for track limits. */
  legal: boolean;
}

/** A decoded mask: one palette index per pixel, row-major. */
export interface TrackMask {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Wall/barrier outline, closed, flat [x0, y0, x1, y1, ...] in mask pixels. */
export interface WallChain {
  points: number[];
  barrier: boolean;
}

/** Everything static the sim needs about a track. */
export interface SimTrack {
  json: TrackJson;
  mask: TrackMask;
  surfaces: readonly SurfaceDef[];
  /** Palette indices by role, resolved once from `surfaces`. */
  index: SurfaceIndex;
}

export interface SurfaceIndex {
  wall: number;
  tyreBarrier: number;
  pitLane: number;
  pitBox: number;
  outOfBounds: number;
}

export function resolveSurfaceIndex(surfaces: readonly SurfaceDef[]): SurfaceIndex {
  const find = (id: string): number => {
    const i = surfaces.findIndex((s) => s.id === id);
    if (i < 0) throw new Error(`surfaces config is missing "${id}"`);
    return i;
  };
  return {
    wall: find('wall'),
    tyreBarrier: find('tyreBarrier'),
    pitLane: find('pitLane'),
    pitBox: find('pitBox'),
    outOfBounds: find('outOfBounds'),
  };
}

export function createSimTrack(json: TrackJson, mask: TrackMask, surfaces: readonly SurfaceDef[]): SimTrack {
  return { json, mask, surfaces, index: resolveSurfaceIndex(surfaces) };
}

/** Surface index at a point. Anything off the image is out of bounds. */
export function surfaceAt(track: SimTrack, x: number, y: number): number {
  const { mask } = track;
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) return track.index.outOfBounds;
  return mask.data[py * mask.width + px]!;
}

// ---------------------------------------------------------------------------
// Palette snapping (pure; used by both loaders)

export interface SnapResult {
  mask: TrackMask;
  /** Pixels that weren't exactly a palette colour (anti-aliasing, stray brush, transparency). */
  offPalette: number;
}

const parseHex = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/**
 * Snap RGBA pixels to the nearest palette colour. Pixels under half opacity
 * count as out of bounds.
 */
export function snapToPalette(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  surfaces: readonly SurfaceDef[],
): SnapResult {
  const palette = surfaces.map((s) => parseHex(s.color));
  const oob = resolveSurfaceIndex(surfaces).outOfBounds;
  const data = new Uint8Array(width * height);
  const memo = new Map<number, number>();
  let offPalette = 0;

  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4]!, g = rgba[i * 4 + 1]!, b = rgba[i * 4 + 2]!, a = rgba[i * 4 + 3]!;
    if (a < 128) {
      data[i] = oob;
      offPalette++;
      continue;
    }
    const key = (r << 16) | (g << 8) | b;
    let best = memo.get(key);
    if (best === undefined) {
      let bestD = Infinity;
      best = 0;
      for (let p = 0; p < palette.length; p++) {
        const c = palette[p]!;
        const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      // Encode "inexact" as a negative value to avoid a second lookup table.
      best = bestD === 0 ? best : -1 - best;
      memo.set(key, best);
    }
    if (best < 0) {
      offPalette++;
      data[i] = -1 - best;
    } else {
      data[i] = best;
    }
  }
  return { mask: { width, height, data }, offPalette };
}

/** Cheap content hash (FNV-1a) for caching traced walls per mask. */
export function hashMask(mask: TrackMask): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < mask.data.length; i++) {
    h ^= mask.data[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
