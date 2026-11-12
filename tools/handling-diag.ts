// Handling diagnostic (card 03b): N AI cars x L laps on the default track, headless, live config.
// Usage: npm run handling-diag -- [--cars 10] [--laps 10] [--seed 1] [--corners] [--physics file.json] [--line seed|generated]
// --clean: no AI mistakes or steering noise. --team <id>: every car from that team.
// --physics: run with another physics.json (A/B against live tuning). --line seed: drive racingLineSeed instead.
// Reports, while cornering (|lateral accel| > 0.3 g, > 10 m/s):
//   - per axle: % of cornering time the OUTSIDE (loaded) wheel is past its grip limit
//     (wheel.usage > 1: demand over grip today; slip past the tyre's peak after the tyre-curve fix)
//   - per corner (from the racing line's curvature): which axle went past the limit first, per pass
//   - skid marks: wheel-ticks that would lay a mark (the client's own wheelFx), split slide / lockup / spin
// Plus lap pace, wall hits and stuck events so a handling change can't quietly break the AI.
import aiJson from '../config/ai.json' with { type: 'json' };
import vfxJson from '../config/vfx.json' with { type: 'json' };
import { wheelFx } from '../src/client/vfx/triggers.ts';
import { readFileSync } from 'node:fs';
import { aiInputSource, buildRacingLine, createWorld, step, type AiConfig, type CarBuild, type PhysicsConfig, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode, surfaces } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1]! : def; };
const cars = Number(opt('cars', '10')), laps = Number(opt('laps', '10')), seed = Number(opt('seed', '1'));
const loaded = loadTrackNode(opt('track', defaultTrackIdNode()));
const physPath = args.includes('--physics') ? opt('physics', '') : '';
const ctx = physPath ? simContextNode(loaded, JSON.parse(readFileSync(physPath, 'utf8')) as PhysicsConfig) : simContextNode(loaded);
if (opt('line', 'generated') === 'seed') {
  if (!loaded.track.json.racingLineSeed?.length) throw new Error('no racingLineSeed in track.json');
  loaded.track.json.racingLine = loaded.track.json.racingLineSeed;
}
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const preset = args.includes('--clean') ? { ...cfg.presets[cfg.defaultPreset]!, mistakesPerMin: 0, noise: 0 } : cfg.presets[cfg.defaultPreset]!;
const G = 9.81, ppm = ctx.track.json.pxPerMeter;

// Corners: runs of racing-line points with |curvature| > 1/80 m, small gaps merged, at least 8 m long.
const corners: Array<{ from: number; to: number; dir: string; minR: number; at: string }> = [];
{
  const n = line.n, bend = (q: number) => Math.abs(line.k[(q + n) % n]!) > 1 / 80;
  let start = 0;
  while (bend(start)) start++; // begin on a straight so no corner straddles index 0
  let q = start, cur: { from: number; to: number } | undefined;
  for (let k = 0; k < n; k++, q++) {
    const i = q % n;
    if (bend(i)) { if (!cur) cur = { from: i, to: i }; else cur.to = i; }
    else if (cur && !(bend(i + 1) || bend(i + 2))) {
      const len = ((cur.to - cur.from + n) % n) + 1;
      if (len >= 4) {
        let kMax = 0, sum = 0, mx = 0, my = 0;
        for (let j = 0; j < len; j++) { const p = (cur.from + j) % n; kMax = Math.max(kMax, Math.abs(line.k[p]!)); sum += line.k[p]!; mx += line.x[p]!; my += line.y[p]!; }
        corners.push({ ...cur, dir: sum > 0 ? 'R' : 'L', minR: 1 / kMax, at: `(${Math.round((mx / len) * ppm)},${Math.round((my / len) * ppm)})` });
      }
      cur = undefined;
    }
  }
}
const cornerOf = (near: number) => corners.findIndex((c) => (c.from <= c.to ? near >= c.from && near <= c.to : near >= c.from || near <= c.to));

const builds: CarBuild[] = Array.from({ length: cars }, (_, i) => ({ ...ctx.physics.defaultCar, team: args.includes('--team') ? opt('team', '') : catalog.teams[i % catalog.teams.length]!.id }));
let world: WorldState = createWorld(ctx, builds);
const drivers = builds.map((_, i) => aiInputSource(i, () => ({ world, ctx, line }), () => preset, () => cfg, seed * 1000 + i));

let cornerTicks = 0, frontPast = 0, rearPast = 0, bothPast = 0, wheelTicks = 0;
let markSlide = 0, markLock = 0, markSpin = 0, walls = 0, lockFront = 0;
const perCorner = corners.map(() => ({ front: 0, rear: 0, same: 0, neither: 0 }));
const pass = builds.map(() => ({ corner: -1, first: '' as '' | 'front' | 'rear' | 'same' }));
const lapTimes: number[][] = builds.map(() => []);
let invalidLaps = 0;
const closePass = (i: number) => {
  const p = pass[i]!;
  if (p.corner >= 0) { const c = perCorner[p.corner]!; if (p.first === 'front') c.front++; else if (p.first === 'rear') c.rear++; else if (p.first === 'same') c.same++; else c.neither++; }
  p.corner = -1; p.first = '';
};

for (let tick = 0; tick < 60 * 60 * 20; tick++) {
  const prev = world;
  world = step(world, drivers.map((d) => d.read(world.tick)), ctx);
  world.cars.forEach((c, i) => {
    if (c.wallContact && !prev.cars[i]!.wallContact) walls++;
    const vFwd = c.speed, aRight = vFwd * c.angVel;
    // Which axle is past its limit (outside wheel: the loaded one).
    const outF = aRight > 0 ? 0 : 1, outR = aRight > 0 ? 2 : 3;
    const f = c.wheels[outF]!.usage > 1, r = c.wheels[outR]!.usage > 1;
    if (Math.abs(aRight) > 0.3 * G && Math.abs(vFwd) > 10) {
      cornerTicks++;
      if (f) frontPast++;
      if (r) rearPast++;
      if (f && r) bothPast++;
    }
    // Per corner, which axle went first on this pass.
    const d = drivers[i]!.state;
    const k = d.mode === 'race' ? cornerOf(d.near) : -1;
    if (k !== pass[i]!.corner) { closePass(i); pass[i]!.corner = k; }
    if (k >= 0 && !pass[i]!.first && (f || r)) pass[i]!.first = f && r ? 'same' : f ? 'front' : 'rear';
    // Skid marks, exactly as the client decides them.
    for (const w of [0, 1, 2, 3] as const) {
      wheelTicks++;
      const fx = wheelFx(prev.cars[i]!, c, w, vfxJson, surfaces, ctx.physics.tyres.peakSlipDeg);
      if (fx.mark > vfxJson.skid.minIntensity) { if (fx.lockup) { markLock++; if (w < 2) lockFront++; } else if (fx.spin) markSpin++; else markSlide++; }
    }
  });
  for (const e of world.events) if (e.type === 'lap') { if (e.invalid) invalidLaps++; else lapTimes[e.car]!.push(e.time); }
  if (world.cars.every((c) => c.timing.laps >= laps)) break;
}
builds.forEach((_, i) => closePass(i));

const pct = (a: number, b: number) => `${b ? ((100 * a) / b).toFixed(1) : '0.0'}%`;
const totalLaps = world.cars.reduce((a, c) => a + c.timing.laps, 0);
const best = lapTimes.map((l) => (l.length ? Math.min(...l) : NaN)).filter(Number.isFinite).sort((a, b) => a - b);
const stuck = drivers.reduce((a, d) => a + d.state.stuckEvents, 0);
console.log(`${loaded.track.json.id}: ${cars} AI cars x ${laps} laps, ${(world.tick / 60).toFixed(0)} s simulated; ${corners.length} corners on the racing line`);
console.log(`cornering time past the limit (outside wheel):  FRONT ${pct(frontPast, cornerTicks)}   REAR ${pct(rearPast, cornerTicks)}   both ${pct(bothPast, cornerTicks)}`);
const tot = perCorner.reduce((a, c) => ({ front: a.front + c.front, rear: a.rear + c.rear, same: a.same + c.same, neither: a.neither + c.neither }), { front: 0, rear: 0, same: 0, neither: 0 });
const passes = tot.front + tot.rear + tot.same + tot.neither;
console.log(`first axle past the limit per corner pass:      front ${pct(tot.front, passes)}   rear ${pct(tot.rear, passes)}   same tick ${pct(tot.same, passes)}   neither ${pct(tot.neither, passes)}   (${passes} passes)`);
console.log(`skid-mark wheel-ticks: ${pct(markSlide + markLock + markSpin, wheelTicks)} of all  (slide ${markSlide}, lockup ${markLock} [front ${lockFront} / rear ${markLock - lockFront}], wheelspin ${markSpin}; ${((markSlide + markLock + markSpin) / Math.max(1, totalLaps)).toFixed(0)} per car-lap)`);
console.log(`pace: best laps ${best.length ? `${best[0]!.toFixed(2)}-${best[best.length - 1]!.toFixed(2)} s` : '-'}; wall hits ${walls}; stuck events ${stuck}; laps ${totalLaps}, invalid ${invalidLaps}`);
if (args.includes('--corners')) {
  console.log('\ncorner  dir  min R   centre px        front  rear  same  neither');
  corners.forEach((c, k) => { const p = perCorner[k]!; console.log(`${String(k + 1).padStart(6)}  ${c.dir}   ${c.minR.toFixed(0).padStart(4)} m  ${c.at.padEnd(15)} ${String(p.front).padStart(6)} ${String(p.rear).padStart(5)} ${String(p.same).padStart(5)} ${String(p.neither).padStart(8)}`); });
}
