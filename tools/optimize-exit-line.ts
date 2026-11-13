// The EXIT line (Racing line optimizer card, Justin 2026-11-13): for each corner followed by a long straight,
// the racing line moved sideways (smooth bumps, no kinks) to minimise the TIME from before the corner to the
// end of the straight, so it trades entry speed for exit speed. Reference car: physics defaultCar, half a tank.
// Reports, per corner, speed 30 m into the straight and the time to the end of it, NEUTRAL vs EXIT.
// Usage: npm run optimize-exit-line -- <id> [--write]   (--write: tracks/<id>/track.json racingLineExit)
// Re-run after optimize-racing-line or physics changes. Settings: config/racing-line.json exit*, ai.json racecraft.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import aiJson from '../config/ai.json' with { type: 'json' };
import lineJson from '../config/racing-line.json' with { type: 'json' };
import { formatTrackJson } from '../src/client/editor/format.ts';
import { buildRacingLine, buildStats, computeExitLine, cornersOf, offsetPath, type AiConfig, type TrackJson } from '../src/sim/index.ts';
import { catalog, loadTrackNode, simContextNode, TRACKS_DIR } from './load-track-node.ts';

const args = process.argv.slice(2);
const id = args[0];
if (!id) { console.error('usage: npm run optimize-exit-line -- <id> [--write]'); process.exit(1); }
const loaded = loadTrackNode(id);
const ctx = simContextNode(loaded);
const line = buildRacingLine(loaded.track)!;
const rc = (aiJson as unknown as AiConfig).racecraft!;
const stats = buildStats(ctx.physics.defaultCar, catalog);
const lc = lineJson as unknown as { exitLeadM: number; exitBumps: number };
const n = line.n, wrap = (q: number) => ((q % n) + n) % n;
const t0 = performance.now();
const { points, offsets: exit, speed: prof, time } = computeExitLine(line, ctx.physics, stats, { exitStraightM: rc.exitStraightM, exitShiftM: rc.exitShiftM, edgeM: rc.edgeM, exitLeadM: lc.exitLeadM, exitBumps: lc.exitBumps }, loaded.track.json.pxPerMeter);
console.log(`${id}: EXIT line in ${(performance.now() - t0).toFixed(0)} ms (straights >= ${rc.exitStraightM} m)`);

const neutralV = prof(line.x, line.y), ep = offsetPath(line, exit), exitV = prof(ep.x, ep.y);
const corners = cornersOf(line);
corners.forEach((c, k) => {
  const next = corners[(k + 1) % corners.length]!, straight = wrap(next.from - c.to) * 2;
  if (straight < rc.exitStraightM) return;
  const into = wrap(c.to + 15), from = c.from - Math.round(lc.exitLeadM / 2);
  let maxOff = 0;
  for (let q = from; q <= c.to + 20; q++) maxOff = Math.max(maxOff, Math.abs(exit[wrap(q)]!));
  const end = from + wrap(next.from - from);
  const tn = time(line.x, line.y, neutralV, from, end), te = time(ep.x, ep.y, exitV, from, end);
  console.log(`  T${k + 1} -> ${straight.toFixed(0)} m straight: 30 m in NEUTRAL ${(neutralV[into]! * 3.6).toFixed(1)} kph, EXIT ${(exitV[into]! * 3.6).toFixed(1)} kph (${((exitV[into]! - neutralV[into]!) * 3.6).toFixed(1)}); ` +
    `to the end of the straight ${tn.toFixed(3)} -> ${te.toFixed(3)} s (${(te - tn).toFixed(3)}); moves up to ${maxOff.toFixed(2)} m`);
});
const lap = (x: ArrayLike<number>, y: ArrayLike<number>, v: ArrayLike<number>) => time(x, y, v, 0, n);
console.log(`  whole lap (reference car): NEUTRAL ${lap(line.x, line.y, neutralV).toFixed(3)} s, EXIT everywhere ${lap(ep.x, ep.y, exitV).toFixed(3)} s`);

if (args.includes('--write')) {
  const path = join(TRACKS_DIR, id, 'track.json');
  const file = JSON.parse(readFileSync(path, 'utf8')) as TrackJson;
  file.racingLineExit = points;
  writeFileSync(path, formatTrackJson(file));
  console.log(`  written to tracks/${id}/track.json racingLineExit (${n} points)`);
}
