// Load a track in Node: read track.json (if any), decode mask.png (or the draft) with pure-JS pngjs,
// snap to the palette and trace walls. Used by headless tests (and later the server, card 07).
import contactJson from '../config/contact.json' with { type: 'json' };
import raceJson from '../config/race.json' with { type: 'json' };
import slipstreamJson from '../config/slipstream.json' with { type: 'json' };
import assistsJson from '../config/assists.json' with { type: 'json' };
import damageJson from '../config/damage.json' with { type: 'json' };
import ersJson from '../config/ers.json' with { type: 'json' };
import evolutionJson from '../config/evolution.json' with { type: 'json' };
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  type ErsConfig,
  completeTrackJson,
  createPhysicsCache,
  createSimTrack,
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
  type WallChain,
} from '../src/sim/index.ts';
import physicsJson from '../config/physics.json' with { type: 'json' };
import rules from '../config/rules.json' with { type: 'json' };
import specsJson from '../config/specs.json' with { type: 'json' };
import surfacesConfig from '../config/surfaces.json' with { type: 'json' };
import teamsJson from '../config/teams.json' with { type: 'json' };
import trackDefaults from '../config/track-defaults.json' with { type: 'json' };
import wallTracing from '../config/wall-tracing.json' with { type: 'json' };
import { defaultTrackId, listTracks } from './track-list.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TRACKS_DIR = join(ROOT, 'tracks');
export const surfaces: readonly SurfaceDef[] = surfacesConfig.surfaces;
export const catalog: CarCatalog = { teams: teamsJson.teams as TeamDef[], specs: specsJson as unknown as SpecsConfig };

export interface LoadedTrack {
  track: SimTrack;
  walls: WallChain[];
  maskFile: string;
  offPalette: number;
}

/** The track the game opens on: the first authored track, else the Indiana fixture. */
export function defaultTrackIdNode(): string {
  const id = defaultTrackId(listTracks(TRACKS_DIR));
  if (!id) throw new Error('no tracks in /tracks');
  return id;
}

export function loadTrackNode(id: string): LoadedTrack {
  const dir = join(TRACKS_DIR, id);
  const jsonPath = join(dir, 'track.json');
  const stub: TrackJsonStub = existsSync(jsonPath)
    ? (JSON.parse(readFileSync(jsonPath, 'utf8')) as TrackJsonStub)
    : stubTrackJson(id, trackDefaults as TrackDefaults);
  const files: TrackJson['files'] = stub.files ?? (trackDefaults as TrackDefaults).files;
  let maskFile = files.mask;
  if (!existsSync(join(dir, maskFile)) && files.maskDraft) maskFile = files.maskDraft;
  const png = PNG.sync.read(readFileSync(join(dir, maskFile)));
  const { mask, offPalette } = snapToPalette(png.data, png.width, png.height, surfaces);
  const json = completeTrackJson(stub, mask, surfaces, trackDefaults as TrackDefaults);
  const track = createSimTrack(json, mask, surfaces);
  const walls = traceWalls(mask, track.index.wall, track.index.tyreBarrier, wallTracing);
  return { track, walls, maskFile, offPalette };
}

/** A fresh sim context. Each one owns its own Planck cache, so contexts never share hidden state. */
export function simContextNode(loaded: LoadedTrack, physics: PhysicsConfig = structuredClone(physicsJson as PhysicsConfig)): SimContext {
  return { track: loaded.track, walls: loaded.walls, physics, catalog, rules, contact: contactJson, race: raceJson, slipstream: slipstreamJson, assists: assistsJson, damage: damageJson, ers: ersJson as ErsConfig, evolution: evolutionJson, cache: createPhysicsCache() };
}
