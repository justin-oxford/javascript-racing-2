// Suggest S1/S2 timing lines that split a lap into equal thirds by driving distance.
// Usage: npm run suggest-timing-lines -- <id> [--write]
// Needs startFinish in tracks/<id>/track.json (its arrow sets the driving direction).
//
// How: shortest-path distance over the racing surface (asphalt + kerb; pit lane excluded) from the
// forward side of start/finish, with the line itself blocked so distance has to go all the way round.
// The lap length is the distance reaching the line's back side. A sector line goes across the track
// where distance = 1/3 (2/3) of that, along the iso-distance contour, extended a little past the edges,
// oriented so its arrow points the way distance grows. Drag them in the editor afterwards if you like.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatTrackJson } from '../src/client/editor/format.ts';
import type { TimingLine, TrackJson } from '../src/sim/index.ts';
import { lapGeometry } from './lap-distance.ts';
import { loadTrackNode, TRACKS_DIR } from './load-track-node.ts';

const [id, ...flags] = process.argv.slice(2);
if (!id) {
  console.error('usage: npm run suggest-timing-lines -- <id> [--write]');
  process.exit(1);
}
const { track } = loadTrackNode(id);
let geo;
try {
  geo = lapGeometry(track);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
const { lap, bestNear } = geo;

const m = track.json.pxPerMeter;
const b1 = bestNear(1 / 3), b2 = bestNear(2 / 3);
const s1 = b1.line, s2 = b2.line;
const width = (l: TimingLine) => Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y).toFixed(0);
console.log(`${id}: shortest lap ~${lap.toFixed(0)} px (${(lap / m).toFixed(0)} m, inside line)`);
console.log(`  s1 ${JSON.stringify(s1)}  at ${(b1.at * 100).toFixed(0)}% of the lap, ${width(s1)} px long`);
console.log(`  s2 ${JSON.stringify(s2)}  at ${(b2.at * 100).toFixed(0)}% of the lap, ${width(s2)} px long`);

if (flags.includes('--write')) {
  const path = join(TRACKS_DIR, id, 'track.json');
  const json = JSON.parse(readFileSync(path, 'utf8')) as TrackJson;
  json.timingLines = { ...json.timingLines, s1, s2 };
  writeFileSync(path, formatTrackJson(json));
  console.log(`  written to tracks/${id}/track.json`);
}
