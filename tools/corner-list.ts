// Corners of a track's racing line, tightest first (Track: Colon card): each corner's tightest radius (local, +-2 points
// on the AI's 2 m path), the reference car's planned speed there (measured limits, base setup), its line point and where
// it is on the art, and its direction.
// Usage: npm run corner-list -- <id>
import { buildRacingLine, buildStats, cornersOf, cornerTable, normalizeSetup, speedProfile } from '../src/sim/index.ts';
import { catalog, loadTrackNode, simContextNode } from './load-track-node.ts';

const id = process.argv[2] ?? 'oxford';
const L = loadTrackNode(id), ctx = simContextNode(L), line = buildRacingLine(L.track)!, j = L.track.json, ppm = j.pxPerMeter;
const build = { ...ctx.physics.defaultCar, setup: normalizeSetup(j.baseSetup ?? ctx.physics.defaultCar.setup, catalog.specs.setup) };
const v = speedProfile(line.x, line.y, ctx.physics, buildStats(build, catalog), { cornerMargin: 1, brakeMargin: 1, fuelKg: ctx.physics.fuel.startKg / 2, table: cornerTable(ctx, build) });
const n = line.n, wrap = (q: number) => ((q % n) + n) % n;
const R2 = (i: number) => { const a = wrap(i - 2), b = wrap(i + 2); const ax = line.x[i]! - line.x[a]!, ay = line.y[i]! - line.y[a]!, bx = line.x[b]! - line.x[i]!, by = line.y[b]! - line.y[i]!; const cr = ax * by - ay * bx; return Math.abs(cr) > 1e-9 ? (Math.hypot(ax, ay) * Math.hypot(bx, by) * Math.hypot(line.x[b]! - line.x[a]!, line.y[b]! - line.y[a]!)) / (2 * Math.abs(cr)) : Infinity; };
// The racing line's own points (track.json index) for the report's line-point numbers.
const near = (x: number, y: number) => { let bi = 0, bd = Infinity; j.racingLine.forEach((p, i) => { const d = (p.x - x * ppm) ** 2 + (p.y - y * ppm) ** 2; if (d < bd) { bd = d; bi = i; } }); return bi; };
const rows = cornersOf(line).map((c) => {
  let q = c.from, r = Infinity, at = c.from, vmin = Infinity;
  for (; ; q = wrap(q + 1)) { const rr = R2(q); if (rr < r) { r = rr; at = q; } vmin = Math.min(vmin, v[q]!); if (q === c.to) break; }
  return { r, at, kph: vmin * 3.6, x: line.x[at]! * ppm, y: line.y[at]! * ppm, dir: Math.sign(line.k[at]!) > 0 ? 'R' : 'L', pt: near(line.x[at]!, line.y[at]!) };
}).sort((a, b) => a.r - b.r);
console.log(`Corners of ${id}, tightest first (radius on the racing line; planned speed with the measured limits, base setup):`);
console.log('  radius   kph  dir  line point   track px');
for (const r of rows) console.log(`  ${r.r.toFixed(1).padStart(5)} m ${r.kph.toFixed(0).padStart(5)}   ${r.dir}   ${String(r.pt).padStart(6)}       (${r.x.toFixed(0)}, ${r.y.toFixed(0)})`);
