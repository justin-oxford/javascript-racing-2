// Load a track in Node: read track.json, decode mask.png (or the draft) with pure-JS pngjs,
// snap to the palette and trace walls. Used by headless tests (and later the server, card 07).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  createSimTrack,
  snapToPalette,
  traceWalls,
  type SimContext,
  type SimTrack,
  type SurfaceDef,
  type TrackJson,
  type WallChain,
} from '../src/sim/index.ts';
import carGeometry from '../config/car-geometry.json' with { type: 'json' };
import kinematics from '../config/placeholder-kinematics.json' with { type: 'json' };
import rules from '../config/rules.json' with { type: 'json' };
import surfacesConfig from '../config/surfaces.json' with { type: 'json' };
import wallTracing from '../config/wall-tracing.json' with { type: 'json' };

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const surfaces: readonly SurfaceDef[] = surfacesConfig.surfaces;

export interface LoadedTrack {
  track: SimTrack;
  walls: WallChain[];
  maskFile: string;
  offPalette: number;
}

export function loadTrackNode(id: string): LoadedTrack {
  const dir = join(ROOT, 'tracks', id);
  const json = JSON.parse(readFileSync(join(dir, 'track.json'), 'utf8')) as TrackJson;
  let maskFile = json.files.mask;
  if (!existsSync(join(dir, maskFile)) && json.files.maskDraft) maskFile = json.files.maskDraft;
  const png = PNG.sync.read(readFileSync(join(dir, maskFile)));
  const { mask, offPalette } = snapToPalette(png.data, png.width, png.height, surfaces);
  const track = createSimTrack(json, mask, surfaces);
  const walls = traceWalls(mask, track.index.wall, track.index.tyreBarrier, wallTracing);
  return { track, walls, maskFile, offPalette };
}

export function simContextNode(track: SimTrack): SimContext {
  return { track, kinematics, carGeometry, rules };
}
