// Which tracks exist, from the folders in /tracks. Shared by the Vite plugin (browser track list)
// and the Node loader (tests, later the server).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TrackListing } from '../src/sim/track.ts';
export { defaultTrackId, playerTracks, type TrackListing } from '../src/sim/track.ts';

export const TRACK_ID_RE = /^[a-z0-9-]+$/;

/** A folder is a track if it has a mask (final or draft) or a track.json. */
export function listTracks(tracksDir: string): TrackListing[] {
  if (!existsSync(tracksDir)) return [];
  return readdirSync(tracksDir)
    .filter((id) => TRACK_ID_RE.test(id) && statSync(join(tracksDir, id)).isDirectory())
    .filter((id) => ['mask.png', 'mask-draft.png', 'track.json'].some((f) => existsSync(join(tracksDir, id, f))))
    .sort()
    .map((id) => {
      let fixture = false;
      const jsonPath = join(tracksDir, id, 'track.json');
      if (existsSync(jsonPath)) {
        try {
          fixture = (JSON.parse(readFileSync(jsonPath, 'utf8')) as { fixture?: unknown }).fixture === true;
        } catch {
          // A half-saved track.json shouldn't take the whole list down.
        }
      }
      return { id, fixture };
    });
}
