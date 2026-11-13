// Track evolution probe (POLISH card): 10 AI cars, 20 laps on the default track from a green track, live
// config. Reports rubber and marbles on vs off the racing line, the AI's lap times early vs late (the track
// rubbering in), sim cost, snapshot size, and writes the grid as an image (rubber dark, marbles orange).
// Usage: npm run evolution-probe [-- --laps 20 --out <file.png> --off]
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, createWorld, step, type AiConfig, type CarBuild, type SurfaceGrid, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const laps = Number(opt('laps', '20'));
const out = opt('out', 'evolution-grid.png');
const loaded = loadTrackNode(defaultTrackIdNode());
const ctx0 = simContextNode(loaded);
// --off: the same session with evolution off (to separate the track rubbering in from fuel and tyres).
const ctx = args.includes('--off') ? { ...ctx0, evolution: { ...ctx0.evolution, enabled: false } } : ctx0;
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const builds: CarBuild[] = Array.from({ length: 10 }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id }));
let w: WorldState = createWorld(ctx, builds);
const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => ({ ...cfg.presets[cfg.defaultPreset]!, mistakesPerMin: 0 }), () => cfg, 500 + i));
const lapTimes: number[][] = builds.map(() => []);
const t0 = performance.now();
for (let t = 0; t < 60 * 60 * 30 && w.cars.some((c) => c.timing.laps < laps); t++) {
  w = step(w, ai.map((d) => d.read(w.tick)), ctx);
  for (const e of w.events) if (e.type === 'lap' && !e.invalid) lapTimes[e.car]!.push(e.time);
}
const simMs = performance.now() - t0;
if (!w.surface) { console.log(`evolution off: ${(w.tick / 60).toFixed(0)} s simulated, ${(simMs / w.tick).toFixed(3)} ms/tick`); }
const g = (w.surface ?? { w: 1, h: 1, cellM: 2, rubber: [0], marbles: [0] }) as SurfaceGrid;

// On vs off the line: cells within 2 m of the racing line vs track cells further away.
const near = new Uint8Array(g.w * g.h);
for (let q = 0; q < line.n; q++) {
  const cx = Math.floor(line.x[q]! / g.cellM), cy = Math.floor(line.y[q]! / g.cellM);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && y >= 0 && x < g.w && y < g.h) near[y * g.w + x] = 1; }
}
const stats = (layer: number[], onLine: boolean) => {
  let sum = 0, n = 0, max = 0;
  layer.forEach((v, i) => { if (!!near[i] === onLine && (v > 0 || onLine)) { sum += v; n++; max = Math.max(max, v); } });
  return { mean: n ? sum / n : 0, max, n };
};
const rOn = stats(g.rubber, true), rOff = stats(g.rubber, false), mOn = stats(g.marbles, true), mOff = stats(g.marbles, false);
const marbleTotal = (onLine: boolean) => g.marbles.reduce((a, v, i) => a + (!!near[i] === onLine ? v : 0), 0);
console.log(`${loaded.track.json.id}: 10 AI x ${laps} laps from green, ${(w.tick / 60).toFixed(0)} s simulated in ${(simMs / 1000).toFixed(1)} s (${(simMs / w.tick).toFixed(3)} ms/tick)`);
console.log(`grid ${g.w} x ${g.h} cells of ${g.cellM} m; snapshot size ${(JSON.stringify(g).length / 1024).toFixed(0)} KB as JSON`);
console.log(`rubber:  on the line mean ${(rOn.mean * 100).toFixed(1)}% (max ${(rOn.max * 100).toFixed(0)}%), off the line (where any) mean ${(rOff.mean * 100).toFixed(1)}%`);
console.log(`marbles: share of all marbles off the line ${((100 * marbleTotal(false)) / Math.max(1e-9, marbleTotal(false) + marbleTotal(true))).toFixed(0)}%; off-line cells with marbles ${mOff.n}, max ${(mOff.max * 100).toFixed(0)}%; on the line mean ${(mOn.mean * 100).toFixed(2)}%`);
// Lap times early vs late (median of laps 2-4 vs the last 3, per car, averaged): the track rubbering in, minus tyre wear and fuel.
const med = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)] ?? NaN; };
const early = lapTimes.map((l) => med(l.slice(1, 4))), late = lapTimes.map((l) => med(l.slice(-3)));
const avg = (a: number[]) => a.filter(Number.isFinite).reduce((x, y) => x + y, 0) / a.filter(Number.isFinite).length;
console.log(`AI lap time: laps 2-4 ${avg(early).toFixed(3)} s, last 3 laps ${avg(late).toFixed(3)} s (${(avg(late) - avg(early)).toFixed(3)} s; fuel burn helps, tyre wear hurts too)`);

// The grid as an image: track cells grey, rubber darker, marbles orange.
const png = new PNG({ width: g.w, height: g.h });
for (let i = 0; i < g.w * g.h; i++) {
  const r = g.rubber[i]!, m = g.marbles[i]!;
  const base = near[i] ? 150 : 110;
  png.data[i * 4] = Math.min(255, base * (1 - r * 0.8) + m * 255);
  png.data[i * 4 + 1] = Math.min(255, base * (1 - r * 0.8) + m * 120);
  png.data[i * 4 + 2] = base * (1 - r * 0.8);
  png.data[i * 4 + 3] = 255;
}
writeFileSync(out, PNG.sync.write(png));
console.log(`grid image: ${out} (${g.w} x ${g.h}; grey = near the line, dark = rubber, orange = marbles)`);
