// Where do cars hit walls or get stuck? (Oxford redesign card, report section 5.) AI races, a 10-car team
// field on a shuffled grid; every wall / tyre-barrier contact (its start) and every stuck event is logged with
// the nearest racing-line point (track.json racingLine index). Spots are line-point zones, worst first, each
// with a cropped screenshot of the art and the events drawn on it.
// Usage: npm run hotspots -- <id> [--brain rules,lookahead] [--seeds 8] [--laps 10] [--jobs 15] [--tag name]
//        [--min 3] [--out reports/img]
//   Writes <out>/<tag>-hotspots.png (the whole track, half size) and <out>/<tag>-spot-<point>.png per spot.
import aiJson from '../config/ai.json' with { type: 'json' };
import driversJson from '../config/drivers.json' with { type: 'json' };
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  aiInputSource, assignDrivers, buildRacingLine, createRaceWorld, driverPreset, step,
  type AiConfig, type CarBuild, type DriverDef, type WorldState,
} from '../src/sim/index.ts';
import { catalog, loadTrackNode, ROOT, simContextNode, TRACKS_DIR } from './load-track-node.ts';

interface Ev { kind: 'wall' | 'barrier' | 'stuck'; lp: number; x: number; y: number; kph: number; brain: string; seed: number; lap: number }
interface Job { track: string; brain: string; seed: number; laps: number }
const TICK = 60;
const ARGS = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = ARGS.indexOf(`--${n}`); return i >= 0 ? ARGS[i + 1]! : d; };

function worker(job: Job): { events: Ev[]; carLaps: number } {
  const loaded = loadTrackNode(job.track), ctx = simContextNode(loaded);
  const cfg = structuredClone(aiJson) as unknown as AiConfig;
  cfg.brain = job.brain as 'rules' | 'lookahead';
  const line = buildRacingLine(loaded.track)!;
  const json = loaded.track.json, ppm = json.pxPerMeter, rl = json.racingLine;
  const nearest = (x: number, y: number) => { let bi = 0, bd = Infinity; rl.forEach((p, i) => { const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d < bd) { bd = d; bi = i; } }); return bi; };
  const n = 10;
  const builds: CarBuild[] = Array.from({ length: n }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i % catalog.teams.length]!.id }));
  const lineup = assignDrivers((driversJson as { drivers: DriverDef[] }).drivers, n, job.seed);
  const base = cfg.presets[cfg.defaultPreset]!;
  const presets = builds.map((_, i) => driverPreset(base, lineup[i], cfg.skill?.spread ?? 0));
  let w: WorldState = createRaceWorld(ctx, builds, { laps: job.laps, seed: job.seed });
  const drivers = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => presets[i]!, () => cfg, job.seed * 1000 + i));
  const events: Ev[] = [];
  const wasWall = new Array<boolean>(n).fill(false), wasBar = new Array<boolean>(n).fill(false), stuckSeen = new Array<number>(n).fill(0);
  const maxTicks = TICK * 60 * job.laps * 2;
  for (let t = 0; t < maxTicks; t++) {
    w = step(w, drivers.map((d) => d.read(w.tick)), ctx);
    w.cars.forEach((c, i) => {
      const px = c.x * ppm, py = c.y * ppm, kph = Math.hypot(c.vx, c.vy) * 3.6, lap = c.timing.laps + 1;
      if (c.wallContact && !wasWall[i]) events.push({ kind: 'wall', lp: nearest(px, py), x: px, y: py, kph, brain: job.brain, seed: job.seed, lap });
      if (c.barrierContact && !wasBar[i]) events.push({ kind: 'barrier', lp: nearest(px, py), x: px, y: py, kph, brain: job.brain, seed: job.seed, lap });
      wasWall[i] = c.wallContact; wasBar[i] = c.barrierContact;
      const st = drivers[i]!.state;
      if (st.stuckEvents > stuckSeen[i]!) { stuckSeen[i] = st.stuckEvents; events.push({ kind: 'stuck', lp: nearest(px, py), x: px, y: py, kph, brain: job.brain, seed: job.seed, lap }); }
    });
    if (w.race && w.race.cars.every((rc) => rc.finished)) break;
  }
  const carLaps = w.cars.reduce((a, c) => a + Math.min(job.laps, c.timing.laps), 0);
  return { events, carLaps };
}

async function main() {
  const id = ARGS.find((a, i) => !a.startsWith('--') && !ARGS[i - 1]?.startsWith('--'));
  if (!id) { console.error('usage: npm run hotspots -- <id> [--brain rules,lookahead] [--seeds 8] [--laps 10] [--jobs 15] [--tag name]'); process.exit(1); }
  const brains = opt('brain', 'rules,lookahead').split(','), seeds = Number(opt('seeds', '8')), laps = Number(opt('laps', '10'));
  const jobsN = Number(opt('jobs', '15')), tag = opt('tag', id), MIN = Number(opt('min', '3'));
  const outDir = join(ROOT, opt('out', 'reports/img'));
  mkdirSync(outDir, { recursive: true });
  const jobs: Job[] = brains.flatMap((brain) => Array.from({ length: seeds }, (_, s) => ({ track: id, brain, seed: s + 1, laps })));
  const self = fileURLToPath(import.meta.url);
  const results: Array<{ events: Ev[]; carLaps: number; brain: string }> = [];
  let next = 0;
  const runOne = (job: Job) => new Promise<void>((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', self, '--worker', JSON.stringify(job)], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('close', () => { const m = /RESULT (.*)/.exec(out); if (m) results.push({ ...(JSON.parse(m[1]!) as { events: Ev[]; carLaps: number }), brain: job.brain }); else console.error(`job failed: ${JSON.stringify(job)}`); resolve(); });
  });
  await Promise.all(Array.from({ length: Math.min(jobsN, jobs.length) }, async () => { while (next < jobs.length) await runOne(jobs[next++]!); }));

  const json = JSON.parse(readFileSync(join(TRACKS_DIR, id, 'track.json'), 'utf8')) as { racingLine: Array<{ x: number; y: number }>; pxPerMeter: number; files: { background?: string } };
  const N = json.racingLine.length;
  const events = results.flatMap((r) => r.events);
  const carLaps: Record<string, number> = {};
  for (const r of results) carLaps[r.brain] = (carLaps[r.brain] ?? 0) + r.carLaps;
  console.log(`Hotspots "${id}" (${tag}): ${results.length} races, car-laps ${brains.map((b) => `${b} ${carLaps[b] ?? 0}`).join(', ')}`);
  for (const b of brains) {
    const e = events.filter((x) => x.brain === b), per = (k: string) => (100 * e.filter((x) => x.kind === k).length / Math.max(1, carLaps[b] ?? 0)).toFixed(2);
    console.log(`  ${b}: wall hits ${per('wall')} / barrier ${per('barrier')} / stuck ${per('stuck')} per 100 car-laps`);
  }
  // Zones: events grouped by line point, neighbours within 4 points merged (~8 m).
  const byLp = new Array<Ev[]>(N).fill(undefined as unknown as Ev[]).map(() => [] as Ev[]);
  for (const e of events) byLp[e.lp]!.push(e);
  const zones: Array<{ from: number; to: number; ev: Ev[] }> = [];
  const used = new Uint8Array(N);
  const order = byLp.map((e, i) => [e.length, i] as const).filter(([c]) => c > 0).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (used[i]) continue;
    let from = i, to = i;
    while (byLp[(from - 1 + N) % N]!.length && !used[(from - 1 + N) % N] && (i - from + N) % N < 8) from = (from - 1 + N) % N;
    for (let g = 1; g <= 4; g++) if (byLp[(to + g) % N]!.length && !used[(to + g) % N] && (to + g - i + N) % N < 12) to = (to + g) % N;
    const ev: Ev[] = [];
    for (let q = from; ; q = (q + 1) % N) { if (!used[q]) { used[q] = 1; ev.push(...byLp[q]!); } if (q === to) break; }
    zones.push({ from, to, ev });
  }
  zones.sort((a, b) => b.ev.length - a.ev.length);
  const art = PNG.sync.read(readFileSync(join(TRACKS_DIR, id, json.files.background ?? 'background.png')));
  const COL: Record<Ev['kind'], [number, number, number]> = { wall: [255, 40, 40], barrier: [255, 0, 255], stuck: [255, 230, 0] };
  const dot = (img: PNG, x: number, y: number, c: [number, number, number], r: number) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const xx = Math.round(x + dx), yy = Math.round(y + dy);
      if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue;
      const k = (yy * img.width + xx) * 4; img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = 255;
    }
  };
  const listed = zones.filter((z) => z.ev.length >= MIN);
  console.log(`  spots with ${MIN}+ events (line points; wall / barrier / stuck; by brain; median speed at the hit):`);
  for (const z of listed) {
    const c = (k: string) => z.ev.filter((e) => e.kind === k).length;
    const kph = z.ev.filter((e) => e.kind !== 'stuck').map((e) => e.kph).sort((a, b) => a - b);
    const cx = z.ev.reduce((a, e) => a + e.x, 0) / z.ev.length, cy = z.ev.reduce((a, e) => a + e.y, 0) / z.ev.length;
    const file = `${tag}-spot-${z.from}.png`;
    console.log(`  - line points ${z.from}–${z.to}: ${c('wall')} / ${c('barrier')} / ${c('stuck')} (${brains.map((b) => `${b} ${z.ev.filter((e) => e.brain === b).length}`).join(', ')}); ${kph.length ? `${kph[kph.length >> 1]!.toFixed(0)} kph` : '—'}; around (${cx.toFixed(0)}, ${cy.toFixed(0)}) -> ${file}`);
    // Crop 480x320 around the spot.
    const Wc = 480, Hc = 320, x0 = Math.max(0, Math.min(art.width - Wc, Math.round(cx - Wc / 2))), y0 = Math.max(0, Math.min(art.height - Hc, Math.round(cy - Hc / 2)));
    const crop = new PNG({ width: Wc, height: Hc });
    for (let y = 0; y < Hc; y++) art.data.copy(crop.data, y * Wc * 4, ((y0 + y) * art.width + x0) * 4, ((y0 + y) * art.width + x0 + Wc) * 4);
    for (let q = z.from; ; q = (q + 1) % N) { const p = json.racingLine[q]!; dot(crop, p.x - x0, p.y - y0, [80, 200, 255], 2); if (q === z.to) break; }
    for (const e of z.ev) dot(crop, e.x - x0, e.y - y0, COL[e.kind], 4);
    writeFileSync(join(outDir, file), PNG.sync.write(crop));
  }
  // Overview: the whole track at half size, every event drawn.
  const ov = new PNG({ width: art.width >> 1, height: art.height >> 1 });
  for (let y = 0; y < ov.height; y++) for (let x = 0; x < ov.width; x++) { const s = ((y * 2) * art.width + x * 2) * 4, d = (y * ov.width + x) * 4; ov.data[d] = art.data[s]!; ov.data[d + 1] = art.data[s + 1]!; ov.data[d + 2] = art.data[s + 2]!; ov.data[d + 3] = 255; }
  for (const e of events) dot(ov, e.x / 2, e.y / 2, COL[e.kind], 3);
  writeFileSync(join(outDir, `${tag}-hotspots.png`), PNG.sync.write(ov));
  writeFileSync(join(outDir, `${tag}-hotspots.json`), JSON.stringify({ id, tag, carLaps, zones: listed.map((z) => ({ from: z.from, to: z.to, n: z.ev.length, wall: z.ev.filter((e) => e.kind === 'wall').length, barrier: z.ev.filter((e) => e.kind === 'barrier').length, stuck: z.ev.filter((e) => e.kind === 'stuck').length })) }));
  console.log(`  wrote ${tag}-hotspots.png, ${tag}-hotspots.json and ${listed.length} spot crop(s) to ${outDir}`);
}

if (ARGS[0] === '--worker') {
  const r = worker(JSON.parse(ARGS[1]!) as Job);
  console.log(`RESULT ${JSON.stringify(r)}`);
} else void main();
