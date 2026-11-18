// Tracks on the server: loaded from /tracks the same way the headless tests load them, once per track id.
import { loadTrackNode, simContextNode, TRACKS_DIR, type LoadedTrack } from '../../tools/load-track-node.ts';
import { listTracks, playerTracks } from '../../tools/track-list.ts';
import type { SimContext } from '../sim';

const loaded = new Map<string, LoadedTrack>();

/** Tracks a host can pick (fixtures left out), with their display names. */
export function roomTracks(): Array<{ id: string; name: string }> {
  return playerTracks(listTracks(TRACKS_DIR)).map((t) => {
    const l = load(t.id);
    return { id: t.id, name: l.track.json.name };
  });
}

function load(id: string): LoadedTrack {
  let l = loaded.get(id);
  if (!l) { l = loadTrackNode(id); loaded.set(id, l); }
  return l;
}

/** A fresh sim context for one race (its own Planck cache: rooms never share hidden state). */
export function raceContext(id: string): SimContext {
  return simContextNode(load(id));
}
