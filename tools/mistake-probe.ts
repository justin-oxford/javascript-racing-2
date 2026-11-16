// AI mistake rate probe (card "AI mistake rate: measure it, and a switch to compare"): 10 AI (team field, roster drivers),
// 10-lap races, both brains, Oxford and Colon. Per car per 10 laps: mistakes by type (late brake / wide / wheelspin /
// spin); the time each type costs (the lap it happened on vs the car's median clean lap); the rate split by the driver's
// CONSISTENCY stat (thirds of the roster: low <= 55, mid 60-70, high >= 75); and how many ended in a stuck car or a heavy hit within 5 s.
// Usage: npm run mistake-probe -- [--tracks oxford,colon] [--seeds 10] [--jobs 12] [--scale 1]
import aiJson from '../config/ai.json' with { type: 'json' };
import driversJson from '../config/drivers.json' with { type: 'json' };
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aiInputSource, assignDrivers, buildRacingLine, createRaceWorld, driverPreset, normalizeSetup, step, type AiConfig, type CarBuild, type DriverDef, type WorldState } from '../src/sim/index.ts';
import { contactLog } from './contact-split.ts';
import { catalog, loadTrackNode, ROOT, simContextNode } from './load-track-node.ts';

interface Job { track: string; brain: string; seed: number; scale: number }
interface Ev { kind: string; cons: number; lap: number; car: number; tick: number }
const ARGS = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = ARGS.indexOf(`--${n}`); return i >= 0 ? ARGS[i + 1]! : d; };
const KINDS = ['lateBrake', 'wide', 'wheelspin', 'spin'];

function worker(job: Job) {
  const L = loadTrackNode(job.track), ctx = simContextNode(L), line = buildRacingLine(L.track)!;
  const cfg = structuredClone(aiJson) as unknown as AiConfig;
  cfg.brain = job.brain as 'rules';
  if (cfg.mistakes) cfg.mistakes.scale = job.scale;
  const setup = normalizeSetup(L.track.json.baseSetup ?? ctx.physics.defaultCar.setup, catalog.specs.setup);
  const builds: CarBuild[] = Array.from({ length: 10 }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i % catalog.teams.length]!.id, setup }));
  const lineup = assignDrivers((driversJson as { drivers: DriverDef[] }).drivers, 10, job.seed);
  const presets = builds.map((_, i) => driverPreset(cfg.presets[cfg.defaultPreset]!, lineup[i], cfg.skill?.spread ?? 0));
  let w: WorldState = createRaceWorld(ctx, builds, { laps: 10, seed: job.seed });
  const drivers = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => presets[i]!, () => cfg, job.seed * 1000 + i));
  const log = contactLog(ctx);
  const evs: Ev[] = [], seen = new Array<number>(10).fill(0), stuckSeen = new Array<number>(10).fill(0);
  const stuckAt: Array<{ car: number; tick: number }> = [];
  const laps: Array<{ car: number; lap: number; time: number }> = [];
  for (let t = 0; t < 60 * 60 * 8 && !(w.race && w.race.cars.every((c) => c.finished)); t++) {
    w = step(w, drivers.map((d) => d.read(w.tick)), ctx);
    log.tick(w);
    for (const e of w.events) if (e.type === 'lap' && !e.invalid) laps.push({ car: e.car, lap: w.cars[e.car]!.timing.laps, time: e.time });
    drivers.forEach((d, i) => {
      const s = d.state;
      if (s.mistakes > seen[i]!) { seen[i] = s.mistakes; evs.push({ kind: s.lastMistake, cons: lineup[i]?.consistency ?? 50, lap: w.cars[i]!.timing.laps + 1, car: i, tick: w.tick }); }
      if (s.stuckEvents > stuckSeen[i]!) { stuckSeen[i] = s.stuckEvents; stuckAt.push({ car: i, tick: w.tick }); }
    });
  }
  (log as { finish?: () => void }).finish?.();
  const heavy = log.incidents.filter((x) => x.peakMps >= log.thresholdMps);
  const carLaps = w.cars.reduce((a, c) => a + Math.min(10, c.timing.laps), 0);
  // Per mistake: the lap's time over the car's median clean lap; did it end stuck / in a heavy hit within 5 s.
  const med = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1]! : NaN; };
  const mistakeLaps = new Set(evs.map((e) => `${e.car}:${e.lap}`));
  const cleanMed = builds.map((_, i) => med(laps.filter((l) => l.car === i && l.lap > 1 && !mistakeLaps.has(`${i}:${l.lap}`)).map((l) => l.time)));
  const out = evs.map((e) => {
    const lt = laps.find((l) => l.car === e.car && l.lap === e.lap);
    return { kind: e.kind, cons: e.cons, cost: lt && Number.isFinite(cleanMed[e.car]!) ? lt.time - cleanMed[e.car]! : NaN, stuck: stuckAt.some((s) => s.car === e.car && s.tick >= e.tick && s.tick - e.tick < 300), heavy: heavy.some((h) => (h.a === e.car || h.b === e.car) && h.startTick >= e.tick && h.startTick - e.tick < 300) };
  });
  const consOf = lineup.map((d) => d?.consistency ?? 50);
  return { track: job.track, brain: job.brain, carLaps, cons: consOf, lapsByCar: builds.map((_, i) => Math.min(10, w.cars[i]!.timing.laps)), out };
}

async function main() {
  const tracks = opt('tracks', 'oxford,colon').split(','), seeds = Number(opt('seeds', '10')), jobsN = Number(opt('jobs', '12')), scale = Number(opt('scale', '1'));
  const jobs: Job[] = tracks.flatMap((track) => ['rules', 'lookahead'].flatMap((brain) => Array.from({ length: seeds }, (_, s) => ({ track, brain, seed: s + 1, scale }))));
  const self = fileURLToPath(import.meta.url);
  const res: Array<ReturnType<typeof worker>> = [];
  let next = 0;
  const runOne = (job: Job) => new Promise<void>((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', self, '--worker', JSON.stringify(job)], { cwd: ROOT });
    let o = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('close', () => { const m = /RESULT (.*)/.exec(o); if (m) res.push(JSON.parse(m[1]!)); else console.error(`job failed ${JSON.stringify(job)}`); resolve(); });
  });
  await Promise.all(Array.from({ length: jobsN }, async () => { while (next < jobs.length) await runOne(jobs[next++]!); }));
  const band = (c: number) => (c <= 55 ? 'low' : c > 70 ? 'high' : 'mid');
  const med = (a: number[]) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[b.length >> 1]! : NaN; };
  console.log(`Mistake probe (scale x${scale}): ${seeds} races x 10 laps per track per brain`);
  for (const track of tracks) for (const brain of ['rules', 'lookahead']) {
    const r = res.filter((x) => x.track === track && x.brain === brain), carLaps = r.reduce((a, x) => a + x.carLaps, 0), all = r.flatMap((x) => x.out);
    const per10 = (k: number) => (10 * k) / Math.max(1, carLaps);
    const byKind = KINDS.map((k) => { const m = all.filter((x) => x.kind === k); return `${k} ${per10(m.length).toFixed(2)} (cost ${med(m.map((x) => x.cost)).toFixed(2)} s, stuck ${m.filter((x) => x.stuck).length}, heavy ${m.filter((x) => x.heavy).length})`; });
    const bandLaps: Record<string, number> = { low: 0, mid: 0, high: 0 };
    for (const x of r) x.cons.forEach((c, i) => { bandLaps[band(c)] = (bandLaps[band(c)] ?? 0) + x.lapsByCar[i]!; });
    const byBand = ['low', 'mid', 'high'].map((b) => `${b} ${((10 * all.filter((x) => band(x.cons) === b).length) / Math.max(1, bandLaps[b]!)).toFixed(2)}`);
    console.log(`  ${track} ${brain}: ${per10(all.length).toFixed(2)} mistakes per car per 10 laps; ${byKind.join('; ')}`);
    console.log(`  ${track} ${brain}: by CONSISTENCY (per car per 10 laps): ${byBand.join(', ')}; ended stuck ${all.filter((x) => x.stuck).length}, in a heavy hit ${all.filter((x) => x.heavy).length} of ${all.length}`);
  }
}

if (ARGS[0] === '--worker') console.log(`RESULT ${JSON.stringify(worker(JSON.parse(ARGS[1]!) as Job))}`);
else void main();
