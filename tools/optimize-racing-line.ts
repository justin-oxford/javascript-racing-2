// Optimize a track's racing line (card "Racing line optimizer"): seed -> minimum-curvature line using the
// full usable width (+ kerbUse of kerbs) -> speed profile for the reference car (physics defaultCar).
// Usage: npm run optimize-racing-line -- <id> [--write] [--kerb-use 0.5] [--blend 0] [--margin 0.3]
// --write keeps the seed in racingLineSeed (taken from racingLine the first time) and writes the
// generated racingLine + racingLineSpeed (m/s) to tracks/<id>/track.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import lineJson from '../config/racing-line.json' with { type: 'json' };
import { formatTrackJson } from '../src/client/editor/format.ts';
import { buildStats, optimizeRacingLine, speedProfile, type LineOptimizerConfig, type TrackJson } from '../src/sim/index.ts';
import { catalog, loadTrackNode, simContextNode, TRACKS_DIR } from './load-track-node.ts';

const args = process.argv.slice(2);
const id = args[0];
if (!id) { console.error('usage: npm run optimize-racing-line -- <id> [--write] [--kerb-use 0.5] [--blend 0] [--margin 0.3]'); process.exit(1); }
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : undefined; };
const cfg: LineOptimizerConfig = { ...(lineJson as LineOptimizerConfig), kerbUse: opt('kerb-use') ?? lineJson.kerbUse, shortestBlend: opt('blend') ?? lineJson.shortestBlend, safetyMarginM: opt('margin') ?? lineJson.safetyMarginM };

const loaded = loadTrackNode(id);
const ctx = simContextNode(loaded);
const json = ctx.track.json;
const seed = json.racingLineSeed?.length ? json.racingLineSeed : json.racingLine;
if (seed.length < 3) { console.error(`${id} has no racing line to seed from: place a rough one in the editor (?edit=1)`); process.exit(1); }

const t0 = performance.now();
const out = optimizeRacingLine(ctx.track, seed, cfg, ctx.physics);
const ppm = json.pxPerMeter;
const stats = buildStats(ctx.physics.defaultCar, catalog);
const v = speedProfile(out.line.map((p) => p.x / ppm), out.line.map((p) => p.y / ppm), ctx.physics, stats, { cornerMargin: 1, brakeMargin: 1, fuelKg: ctx.physics.fuel.startKg / 2 });
let lapS = 0;
for (let i = 0; i < out.line.length; i++) { const a = out.line[i]!, b = out.line[(i + 1) % out.line.length]!; lapS += Math.hypot(b.x - a.x, b.y - a.y) / ppm / Math.max(1, (v[i]! + v[(i + 1) % v.length]!) / 2); }
console.log(`${id}: ${out.line.length} points, ${out.lengthM.toFixed(0)} m, tightest radius ${out.minRadiusM.toFixed(1)} m, ` +
  `min room to the usable edge ${out.minClearanceM.toFixed(2)} m (need ${(ctx.physics.car.widthM / 2 + cfg.safetyMarginM).toFixed(2)}), pushed in ${out.pushedIn}, ` +
  `kerbUse ${cfg.kerbUse}, blend ${cfg.shortestBlend}; ${(performance.now() - t0).toFixed(0)} ms`);
console.log(`  speed profile (${ctx.physics.defaultCar.team}): ${(Math.min(...v) * 3.6).toFixed(0)}-${(Math.max(...v) * 3.6).toFixed(0)} kph, ideal lap ${lapS.toFixed(2)} s`);

if (args.includes('--write')) {
  const path = join(TRACKS_DIR, id, 'track.json');
  const file = JSON.parse(readFileSync(path, 'utf8')) as TrackJson;
  file.racingLineSeed = file.racingLineSeed?.length ? file.racingLineSeed : file.racingLine;
  file.racingLine = out.line;
  file.racingLineSpeed = Array.from(v, (s) => Math.round(s * 10) / 10);
  writeFileSync(path, formatTrackJson(file));
  console.log(`  written to tracks/${id}/track.json (seed kept in racingLineSeed)`);
}
