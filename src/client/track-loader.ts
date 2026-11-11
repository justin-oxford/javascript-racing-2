// Browser track loading: track.json (bundled), background (public/), mask + overhead (tracks/<id>/,
// fetched at runtime so they can hot-reload). The mask is decoded to palette indices here,
// before anything reaches the sim.
import carGeometry from '../../config/car-geometry.json';
import kinematics from '../../config/placeholder-kinematics.json';
import rules from '../../config/rules.json';
import surfacesConfig from '../../config/surfaces.json';
import wallTracing from '../../config/wall-tracing.json';
import {
  createSimTrack,
  hashMask,
  snapToPalette,
  traceWalls,
  type SimContext,
  type SimTrack,
  type SurfaceDef,
  type TrackJson,
  type TrackMask,
  type WallChain,
} from '../sim';

export const surfaces: readonly SurfaceDef[] = surfacesConfig.surfaces;

const trackJsons = import.meta.glob<TrackJson>('/tracks/*/track.json', { eager: true, import: 'default' });

export function getTrackJson(id: string): TrackJson {
  const json = trackJsons[`/tracks/${id}/track.json`];
  if (!json) throw new Error(`No track "${id}"`);
  return json;
}

export const siteUrl = (path: string): string => `${import.meta.env.BASE_URL}${path}`;
const trackFileUrl = (id: string, file: string): string => siteUrl(`tracks/${id}/${file}`);

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

/** Fetch a PNG, or undefined if it isn't there. Always bypasses the cache (hot reload). */
async function fetchPng(url: string): Promise<Blob | undefined> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return undefined;
  return res.blob();
}

async function decodePng(blob: Blob): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  // No colour management or premultiplication: we want the exact painted values.
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return { rgba: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
}

const wallCache = new Map<number, WallChain[]>();

/** Trace walls, re-using the result if this exact mask was traced before. */
function wallsFor(track: SimTrack): WallChain[] {
  const key = hashMask(track.mask);
  let walls = wallCache.get(key);
  if (!walls) {
    const t0 = performance.now();
    walls = traceWalls(track.mask, track.index.wall, track.index.tyreBarrier, wallTracing);
    wallCache.set(key, walls);
    console.info(`[track] traced ${walls.length} wall outlines in ${(performance.now() - t0).toFixed(0)} ms`);
  }
  return walls;
}

/** Mask rendered back to flat palette colours, for overlays. */
function maskToCanvas(mask: TrackMask): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = mask.width;
  canvas.height = mask.height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(mask.width, mask.height);
  const rgb = surfaces.map((s) => [1, 3, 5].map((i) => parseInt(s.color.slice(i, i + 2), 16)));
  for (let i = 0; i < mask.data.length; i++) {
    const c = rgb[mask.data[i]!]!;
    img.data[i * 4] = c[0]!;
    img.data[i * 4 + 1] = c[1]!;
    img.data[i * 4 + 2] = c[2]!;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export interface MaskState {
  track: SimTrack;
  walls: WallChain[];
  canvas: HTMLCanvasElement;
  file: string;
}

/** Load (or reload) the mask: prefer files.mask, fall back to files.maskDraft. */
export async function loadMask(json: TrackJson): Promise<MaskState> {
  let file = json.files.mask;
  let blob = await fetchPng(trackFileUrl(json.id, file));
  if (!blob && json.files.maskDraft) {
    file = json.files.maskDraft;
    blob = await fetchPng(trackFileUrl(json.id, file));
    console.warn(`[track] ${json.id}: ${json.files.mask} not found, using ${file}`);
  }
  if (!blob) throw new Error(`[track] ${json.id}: no mask found`);
  const { rgba, width, height } = await decodePng(blob);
  const { mask, offPalette } = snapToPalette(rgba, width, height, surfaces);
  const frac = offPalette / (width * height);
  if (frac > surfacesConfig.offPaletteWarnFraction)
    console.warn(`[track] ${json.id}/${file}: ${offPalette} pixels (${(frac * 100).toFixed(1)}%) were off-palette and got snapped`);
  const track = createSimTrack(json, mask, surfaces);
  return { track, walls: wallsFor(track), canvas: maskToCanvas(mask), file };
}

export async function loadOverhead(json: TrackJson): Promise<HTMLImageElement | undefined> {
  if (!json.files.overhead) return undefined;
  return loadImage(`${trackFileUrl(json.id, json.files.overhead)}?t=${Date.now()}`);
}

export function simContext(track: SimTrack): SimContext {
  return { track, kinematics, carGeometry, rules };
}
