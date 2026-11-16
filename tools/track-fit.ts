// Does a track's placed data still fit its mask? (Oxford redesign card, step 2.) After new art + mask, check:
// start/finish + sector lines (span the road, in driving order), spawn + the 10-car grid (every wheel on legal
// surface, no wall within 1 m), the racing line / seed / EXIT line (on legal surface), the pit path (built,
// on drivable surface, the lane covers every box), and the pit boxes (count, each stop inside its box).
// Usage: npm run track-fit -- <id> [--cars 10]
// Points are reported as line points (racingLine index) and track pixels.
import aiJson from '../config/ai.json' with { type: 'json' };
import { buildRacingLine, startPose, surfaceAt, wheelPositions, type AiConfig, type Point } from '../src/sim/index.ts';
import { loadTrackNode, simContextNode } from './load-track-node.ts';

void aiJson as unknown as AiConfig;
const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
if (!id) { console.error('usage: npm run track-fit -- <id> [--cars 10]'); process.exit(1); }
const ci = args.indexOf('--cars');
const CARS = ci >= 0 ? Number(args[ci + 1]) : 10;
const loaded = loadTrackNode(id);
const ctx = simContextNode(loaded);
const { track } = loaded;
const json = track.json, ppm = json.pxPerMeter;
const S = (x: number, y: number) => track.surfaces[surfaceAt(track, x, y)]!;
let problems = 0;
const warn = (m: string) => { problems++; console.log(`  ✗ ${m}`); };
const ok = (m: string) => console.log(`  ✓ ${m}`);
const line = json.racingLine;
const nearest = (x: number, y: number) => {
  let bi = -1, bd = Infinity;
  line.forEach((p, i) => { const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d < bd) { bd = d; bi = i; } });
  return bi;
};
const at = (x: number, y: number) => `(${Math.round(x)}, ${Math.round(y)}) near line point ${nearest(x, y)}`;
console.log(`Track fit "${id}"`);

// ---- Timing lines: each crosses legal surface, both ends off the racing surface, crossed in driving order.
console.log('\nTiming lines');
const keys = ['startFinish', 's1', 's2'] as const;
const crossIdx: Record<string, number> = {};
for (const k of keys) {
  const tl = json.timingLines[k];
  if (!tl) { warn(`${k}: not placed`); continue; }
  const n = Math.ceil(Math.hypot(tl.b.x - tl.a.x, tl.b.y - tl.a.y));
  let legal = 0;
  for (let t = 0; t <= n; t++) if (S(tl.a.x + ((tl.b.x - tl.a.x) * t) / n, tl.a.y + ((tl.b.y - tl.a.y) * t) / n).legal) legal++;
  const endA = S(tl.a.x, tl.a.y), endB = S(tl.b.x, tl.b.y);
  // Where the racing line crosses it.
  let cross = -1;
  for (let i = 0; i < line.length && cross < 0; i++) {
    const p = line[i]!, q = line[(i + 1) % line.length]!;
    const d = (q.x - p.x) * (tl.b.y - tl.a.y) - (q.y - p.y) * (tl.b.x - tl.a.x);
    if (Math.abs(d) < 1e-9) continue;
    const u = ((tl.a.x - p.x) * (tl.b.y - tl.a.y) - (tl.a.y - p.y) * (tl.b.x - tl.a.x)) / d;
    const v = ((tl.a.x - p.x) * (q.y - p.y) - (tl.a.y - p.y) * (q.x - p.x)) / d;
    if (u >= 0 && u < 1 && v >= 0 && v <= 1) cross = i;
  }
  crossIdx[k] = cross;
  const msg = `${k}: ${(legal / ppm).toFixed(1)} m of legal surface, ends on ${endA.id} / ${endB.id}, racing line crosses at point ${cross < 0 ? '—' : cross}`;
  if (cross < 0 || legal < 6 * ppm || ['asphalt', 'kerb'].includes(endA.id) || ['asphalt', 'kerb'].includes(endB.id)) warn(msg + (cross < 0 ? ' (the racing line never crosses it)' : legal < 6 * ppm ? ' (under 6 m of road)' : ' (an end sits on the road: the line stops short of the edge)'));
  else ok(msg);
}
if (keys.every((k) => (crossIdx[k] ?? -1) >= 0)) {
  const n = line.length, sf = crossIdx.startFinish!, d = (k: string) => (crossIdx[k]! - sf + n) % n;
  if (d('s1') < d('s2')) ok(`driving order S/F -> S1 -> S2 (sectors ${d('s1')} / ${d('s2') - d('s1')} / ${n - d('s2')} line points)`);
  else warn(`sector lines out of driving order (S1 at +${d('s1')}, S2 at +${d('s2')} points from S/F)`);
}

// ---- Spawn + grid: every wheel legal, no wall within 1 m of the car's centre.
console.log(`\nSpawn + grid (${CARS} cars)`);
const wallNear = (x: number, y: number, rM: number) => {
  const r = rM * ppm;
  for (let a = 0; a < 16; a++) { const s = S(x + Math.cos((a * Math.PI) / 8) * r, y + Math.sin((a * Math.PI) / 8) * r); if (s.id === 'wall' || s.id === 'tyreBarrier') return true; }
  return false;
};
let gridBad = 0;
for (let i = 0; i < CARS; i++) {
  const p = startPose(i, ctx);
  const w = wheelPositions({ x: p.x / ppm, y: p.y / ppm, heading: p.heading }, ctx.physics);
  const bad = w.filter((q) => !S(q.x * ppm, q.y * ppm).legal);
  if (bad.length || wallNear(p.x, p.y, 1)) { gridBad++; warn(`slot ${i + 1} ${at(p.x, p.y)}: ${bad.length} wheel(s) off legal surface${wallNear(p.x, p.y, 1) ? ', a wall within 1 m' : ''}`); }
}
if (!gridBad) ok(`spawn + ${CARS - 1} grid slots: every wheel on legal surface, no wall within 1 m (${json.grid.length ? 'placed slots' : 'generated behind the spawn'})`);

// ---- Lines on the road.
console.log('\nLines');
const offRoad = (pts: readonly Point[] | undefined, name: string) => {
  if (!pts?.length) { console.log(`  - ${name}: none`); return; }
  const bad = pts.map((p, i) => (S(p.x, p.y).legal ? -1 : i)).filter((i) => i >= 0);
  if (bad.length) warn(`${name}: ${bad.length} of ${pts.length} points off legal surface: ${bad.slice(0, 12).map((i) => `${i} ${S(pts[i]!.x, pts[i]!.y).id}`).join(', ')}${bad.length > 12 ? ' …' : ''}`);
  else ok(`${name}: all ${pts.length} points on legal surface`);
};
offRoad(json.racingLine, 'racing line');
offRoad(json.racingLineSeed, 'racing line seed (the optimizer starts here)');
offRoad(json.racingLineExit, 'EXIT line');
if (json.racingLineSpeed && json.racingLineSpeed.length !== line.length) warn(`racingLineSpeed has ${json.racingLineSpeed.length} values for ${line.length} line points (stale)`);

// ---- Pit path + boxes.
console.log('\nPits');
const rl = buildRacingLine(track);
const pit = rl?.pit;
if (!pit) warn('no pit path built (pit lane not reachable from the racing line?)');
else {
  const off: number[] = [];
  for (let q = 0; q < pit.n; q++) {
    const s = S(pit.x[q]! * ppm, pit.y[q]! * ppm);
    if (s.id === 'wall' || s.id === 'tyreBarrier' || s.id === 'outOfBounds') off.push(q);
  }
  if (off.length) warn(`pit path: ${off.length} of ${pit.n} points on wall / out of bounds (first at ${at(pit.x[off[0]!]! * ppm, pit.y[off[0]!]! * ppm)})`);
  else ok(`pit path: ${pit.n} points (${(pit.length).toFixed(0)} m), leaves the racing line at point ${pit.entry}, rejoins at ${pit.exit}; lane = path points ${pit.laneFrom}–${pit.laneTo}`);
  const boxes = track.boxes;
  if (boxes.length < CARS) warn(`${boxes.length} pit boxes for ${CARS} cars`);
  else ok(`${boxes.length} pit boxes`);
  const outside = pit.boxStops.filter((b, i) => { const bx = boxes[i]!; const q = b.q; return q < pit.laneFrom || q > pit.laneTo || !(bx.x0 <= b.x * ppm && b.x * ppm < bx.x1 && bx.y0 <= b.y * ppm && b.y * ppm < bx.y1); }).length;
  if (outside) warn(`${outside} box stop(s) outside the lane or their box`);
  else ok('every box stop is inside the pit lane range and its box');
}

console.log(`\n${problems ? `${problems} problem(s)` : 'Everything fits.'}`);
process.exitCode = problems ? 1 : 0;
