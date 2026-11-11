// Browser track loading: track.json (bundled, optional), mask + background + overhead (tracks/<id>/,
// fetched at runtime so they can hot-reload). The mask is decoded to palette indices here,
// before anything reaches the sim.
import trackList from 'virtual:tracks';
import physicsJson from '../../config/physics.json';
import rules from '../../config/rules.json';
import specsJson from '../../config/specs.json';
import surfacesConfig from '../../config/surfaces.json';
import teamsJson from '../../config/teams.json';
import trackDefaults from '../../config/track-defaults.json';
import wallTracing from '../../config/wall-tracing.json';
import {
  completeTrackJson,
  createPhysicsCache,
  createSimTrack,
  defaultTrackId,
  hashMask,
  snapToPalette,
  stubTrackJson,
  traceWalls,
  type CarCatalog,
  type PhysicsConfig,
  type SimContext,
  type SimTrack,
  type SpecsConfig,
  type SurfaceDef,
  type TeamDef,
  type TrackDefaults,
  type TrackJson,
  type TrackJsonStub,
  type TrackMask,
  type WallChain,
} from '../sim';

// Live config objects. The tuning panel edits these in place; the sim reads them every tick.
export { surfacesConfig };
export const surfaces: SurfaceDef[] = surfacesConfig.surfaces;
export const physics = physicsJson as PhysicsConfig;
export const catalog: CarCatalog = { teams: teamsJson.teams as TeamDef[], specs: specsJson as unknown as SpecsConfig };
export { rules };
const defaults = trackDefaults as TrackDefaults;

const trackJsons = import.meta.glob<TrackJson>('/tracks/*/track.json', { eager: true, import: 'default' });

/** ?track=<id> wins (dev convenience; fixtures allowed there), else the first authored track. */
export function chooseTrackId(): string {
  const asked = new URLSearchParams(location.search).get('track');
  if (asked && trackList.some((t) => t.id === asked)) return asked;
  const id = defaultTrackId(trackList);
  if (!id) throw new Error('No tracks found in /tracks');
  return id;
}

/** track.json if the track has one, else a stub (blockout stage: mask only). */
export function getTrackJsonStub(id: string): TrackJsonStub {
  return trackJsons[`/tracks/${id}/track.json`] ?? stubTrackJson(id, defaults);
}

export const siteUrl = (path: string): string => `${import.meta.env.BASE_URL}${path}`;

/** Track file path -> URL. Relative to the track folder; a leading "/" means site root (public/). */
export function trackFileUrl(id: string, file: string): string {
  return file.startsWith('/') ? siteUrl(file.slice(1)) : siteUrl(`tracks/${id}/${file}`);
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

/** Fetch an image, or undefined if it isn't there. Always bypasses the cache (hot reload). */
async function fetchImage(url: string): Promise<Blob | undefined> {
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

/** Mask drawn as flat colours: the palette (debug overlay) or the muted blockout colours (no art yet). */
function maskToCanvas(mask: TrackMask, colour: 'color' | 'blockout'): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = mask.width;
  canvas.height = mask.height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(mask.width, mask.height);
  const rgb = surfaces.map((s) => [1, 3, 5].map((i) => parseInt(s[colour].slice(i, i + 2), 16)));
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
  /** Palette colours, for the K overlay and the editor. */
  canvas: HTMLCanvasElement;
  /** Muted colours, drawn as the track when there's no background art. */
  blockout: HTMLCanvasElement;
  file: string;
}

/** Load (or reload) the mask: files.mask, falling back to files.maskDraft. Completes the track.json stub. */
export async function loadMask(stub: TrackJsonStub): Promise<MaskState> {
  const files: TrackJson['files'] = stub.files ?? defaults.files;
  let file = files.mask;
  let blob = await fetchImage(trackFileUrl(stub.id, file));
  if (!blob && files.maskDraft) {
    file = files.maskDraft;
    blob = await fetchImage(trackFileUrl(stub.id, file));
    console.warn(`[track] ${stub.id}: ${files.mask} not found, using ${file}`);
  }
  if (!blob) throw new Error(`[track] ${stub.id}: no mask found`);
  const { rgba, width, height } = await decodePng(blob);
  const { mask, offPalette } = snapToPalette(rgba, width, height, surfaces);
  const frac = offPalette / (width * height);
  if (frac > surfacesConfig.offPaletteWarnFraction)
    console.warn(`[track] ${stub.id}/${file}: ${offPalette} pixels (${(frac * 100).toFixed(1)}%) were off-palette and got snapped`);
  const json = completeTrackJson(stub, mask, surfaces, defaults);
  const track = createSimTrack(json, mask, surfaces);
  return { track, walls: wallsFor(track), canvas: maskToCanvas(mask, 'color'), blockout: maskToCanvas(mask, 'blockout'), file };
}

/** Background art, or undefined while the track is still a blockout. */
export async function loadBackground(json: TrackJson): Promise<HTMLImageElement | undefined> {
  if (!json.files.background) return undefined;
  const blob = await fetchImage(trackFileUrl(json.id, json.files.background));
  return blob ? loadImage(URL.createObjectURL(blob)) : undefined;
}

export async function loadOverhead(json: TrackJson): Promise<HTMLImageElement | undefined> {
  if (!json.files.overhead) return undefined;
  const blob = await fetchImage(trackFileUrl(json.id, json.files.overhead));
  return blob ? loadImage(URL.createObjectURL(blob)) : undefined;
}

/** One sprite per team (placeholder v0.16 JPGs until the livery card). */
export async function loadTeamSprites(): Promise<Map<string, HTMLImageElement>> {
  const entries = await Promise.all(catalog.teams.map(async (t) => [t.id, await loadImage(siteUrl(t.sprite))] as const));
  return new Map(entries);
}

export function simContext(mask: MaskState): SimContext {
  return { track: mask.track, walls: mask.walls, physics, catalog, rules, cache: createPhysicsCache() };
}
