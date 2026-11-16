// Re-measure the two AI cards (Game-scale car round, step 4) on a car: "late-stint spins on corner exits" and "plan speed
// from the path it's actually on" (side-by-side wall incidents).
// Usage: npm run ai-cards-probe -- [--track oxford] [--races-only] [--car v1] [--seeds 10] [--jobs 12] [--set ai.x.y=v ...] [--json out.json]
//   STINTS: 10 AI (team field), 20 laps, no fuel burn and no stops (one stint), both brains. Per lap of the stint: spins
//     (body slip > 60 deg at > 5 m/s) and big slides (> 25 deg) that aren't the AI's own scripted mistakes, the lap time
//     vs the car's laps 2-4, front / rear tyre wear left. Where (line point) the spins happen.
//   RACES: 10 AI, 10 laps, both brains: wall contacts while a car is alongside (within a car length ahead / behind, 1-5 m
//     to the side) = side-by-side wall incidents, split by whether the car was on the INSIDE of the corner; the inside
//     car's front slip and its planned speed vs the speed the path it was actually on allows; heavy hits and stuck events
//     per 20 laps (the step 4 ship rule).
import aiJson from '../config/ai.json' with { type: 'json' };
import carV1 from '../config/car-v1.json' with { type: 'json' };
import driversJson from '../config/drivers.json' with { type: 'json' };
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  aiInputSource, assignDrivers, buildRacingLine, buildStats, carTurnRadiusM, createRaceWorld, driverPreset, normalizeSetup, step,
  type AiConfig, type CarBuild, type DriverDef, type PhysicsConfig, type WorldState,
} from '../src/sim/index.ts';
import { contactLog } from './contact-split.ts';
import { catalog, loadTrackNode, ROOT, simContextNode } from './load-track-node.ts';

interface Job { kind: 'stint' | 'race'; brain: string; seed: number; car: string; sets: string[]; track: string }
const ARGS = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = ARGS.indexOf(`--${n}`); return i >= 0 ? ARGS[i + 1]! : d; };
const DEG = 180 / Math.PI;

function worker(job: Job) {
  const loaded = loadTrackNode(job.track);
  const base = simContextNode(loaded);
  const physics = structuredClone(base.physics) as PhysicsConfig;
  let baseRaw: unknown = loaded.track.json.baseSetup;
  if (job.car === 'v1') {
    const snap = carV1 as unknown as { physics: Record<string, unknown>; specs: Record<string, unknown>; baseSetup: Record<string, unknown> };
    for (const [k, v] of Object.entries(snap.physics)) (physics as unknown as Record<string, unknown>)[k] = structuredClone(v);
    for (const [k, v] of Object.entries(snap.specs)) (catalog.specs as unknown as Record<string, unknown>)[k] = structuredClone(v);
    baseRaw = snap.baseSetup.oxford ?? baseRaw;
  }
  if (job.kind === 'stint') physics.fuel = { ...physics.fuel, burnKgPerSec: 0 };
  const ctx = simContextNode(loaded, physics);
  const cfg = structuredClone(aiJson) as unknown as AiConfig;
  cfg.brain = job.brain as 'rules' | 'lookahead';
  for (const s of job.sets) { const [path, v] = s.split('=') as [string, string]; const ks = path.split('.'); let o = (ks[0] === 'ai' ? cfg : ctx) as unknown as Record<string, unknown>; for (const k of ks.slice(1, -1)) o = o[k] as Record<string, unknown>; o[ks[ks.length - 1]!] = v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) ? Number(v) : v; }
  const line = buildRacingLine(loaded.track)!;
  const setup = normalizeSetup(baseRaw ?? physics.defaultCar.setup, catalog.specs.setup);
  const n = 10;
  const builds: CarBuild[] = Array.from({ length: n }, (_, i) => ({ ...physics.defaultCar, team: catalog.teams[i % catalog.teams.length]!.id, setup }));
  const lineup = assignDrivers((driversJson as { drivers: DriverDef[] }).drivers, n, job.seed);
  const presets = builds.map((_, i) => driverPreset(cfg.presets[cfg.defaultPreset]!, lineup[i], cfg.skill?.spread ?? 0));
  const laps = job.kind === 'stint' ? 20 : 10;
  let w: WorldState = createRaceWorld(ctx, builds, { laps, seed: job.seed });
  const drivers = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => presets[i]!, () => cfg, job.seed * 1000 + i));
  const log = contactLog(ctx);
  const course = (c: { vx: number; vy: number }) => Math.atan2(c.vx, -c.vy);
  const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const spinOn = new Array<boolean>(n).fill(false), slideOn = new Array<boolean>(n).fill(false), wallOn = new Array<boolean>(n).fill(false);
  const lastCourse = w.cars.map(course);
  const lapOf = (i: number) => w.cars[i]!.timing.laps + 1;
  const perLap = Array.from({ length: laps + 2 }, () => ({ spins: 0, slides: 0, time: [] as number[], front: [] as number[], rear: [] as number[] }));
  const spinAt: number[] = [];
  const sbs = { incidents: 0, inside: 0, insideFrontPast: 0, planOver: [] as number[] };
  const stuckSeen = new Array<number>(n).fill(0);
  let stuck = 0;
  const stats = buildStats(builds[0]!, catalog);
  const lapStart = new Array<number>(n).fill(0);
  for (let t = 0; t < 60 * 60 * (job.kind === 'stint' ? 14 : 8) && !(w.race && w.race.cars.every((rc) => rc.finished)); t++) {
    w = step(w, drivers.map((d) => d.read(w.tick)), ctx);
    log.tick(w);
    for (const e of w.events) if (e.type === 'lap' && w.cars[e.car]) {
      const L = w.cars[e.car]!.timing.laps; const c = w.cars[e.car]!;
      if (L <= laps) { perLap[L]!.time.push(e.invalid ? NaN : e.time); perLap[L]!.front.push((c.wheels[0]!.wear + c.wheels[1]!.wear) / 2); perLap[L]!.rear.push((c.wheels[2]!.wear + c.wheels[3]!.wear) / 2); }
      lapStart[e.car] = t;
    }
    w.cars.forEach((c, i) => {
      const v = Math.hypot(c.vx, c.vy), cc = course(c), body = Math.abs(wrapA(c.heading - cc)) * DEG;
      const yaw = wrapA(cc - lastCourse[i]!) * 60; lastCourse[i] = cc;
      const st = drivers[i]!.state, scripted = !!st.mistake;
      const lap = Math.min(laps, lapOf(i));
      if (v > 5 && body > 60 && !spinOn[i]) { spinOn[i] = true; if (!scripted) { perLap[lap]!.spins++; spinAt.push(st.near); } }
      if (body < 30) spinOn[i] = false;
      if (v > 5 && body > 25 && !slideOn[i]) { slideOn[i] = true; if (!scripted) perLap[lap]!.slides++; }
      if (body < 12) slideOn[i] = false;
      if (st.stuckEvents > stuckSeen[i]!) { stuckSeen[i] = st.stuckEvents; stuck++; }
      // Side by side: another car within a car length along, 1-5 m across.
      const hx = Math.sin(c.heading), hy = -Math.cos(c.heading);
      let along = -1, latRel = 0;
      w.cars.forEach((o, j) => { if (j === i) return; const dx = o.x - c.x, dy = o.y - c.y, lon = dx * hx + dy * hy, lat = -dx * hy + dy * hx; if (Math.abs(lon) < physics.car.lengthM && Math.abs(lat) > 1 && Math.abs(lat) < 5) { along = j; latRel = lat; } });
      if (c.wallContact && !wallOn[i] && along >= 0) {
        sbs.incidents++;
        // Inside = the other car is on the outside of this car's turn (+lat = right; yaw > 0 = turning right).
        const inside = Math.sign(latRel) === -Math.sign(yaw) && Math.abs(yaw) > 0.05;
        if (inside) {
          sbs.inside++;
          if (Math.max(Math.abs(c.wheels[0]!.slipDeg), Math.abs(c.wheels[1]!.slipDeg)) > physics.tyres.peakSlipDeg) sbs.insideFrontPast++;
          // Planned speed vs what the path it was on (radius from its own turn rate) allows.
          const R = Math.abs(yaw) > 1e-3 ? v / Math.abs(yaw) : Infinity;
          let lo = 1, hi = 120; for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (carTurnRadiusM(mid, physics, stats).radiusM <= R) lo = mid; else hi = mid; }
          if (Number.isFinite(R)) sbs.planOver.push(st.lastAllowed / lo);
        }
      }
      wallOn[i] = c.wallContact;
    });
  }
  const carLaps = w.cars.reduce((a, c) => a + Math.min(laps, c.timing.laps), 0);
  (log as { finish?: () => void }).finish?.();
  const heavy = log.incidents.filter((i) => i.peakMps >= log.thresholdMps).length;
  return { kind: job.kind, brain: job.brain, perLap: perLap.map((p) => ({ spins: p.spins, slides: p.slides, time: p.time, front: p.front, rear: p.rear })), spinAt, sbs, carLaps, stuck, heavy };
}

async function main() {
  const brains = ['rules', 'lookahead'], seeds = Number(opt('seeds', '10')), jobsN = Number(opt('jobs', '12')), car = opt('car', 'live');
  const sets = ARGS.flatMap((a, i) => (a === '--set' ? [ARGS[i + 1]!] : []));
  const track = opt('track', 'oxford'), racesOnly = ARGS.includes('--races-only');
  const jobs: Job[] = brains.flatMap((brain) => Array.from({ length: seeds }, (_, s) => [...(racesOnly ? [] : [{ kind: 'stint', brain, seed: s + 1, car, sets, track } as Job]), { kind: 'race', brain, seed: s + 1, car, sets, track } as Job]).flat());
  const self = fileURLToPath(import.meta.url);
  const res: Array<ReturnType<typeof worker>> = [];
  let next = 0;
  const runOne = (job: Job) => new Promise<void>((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', self, '--worker', JSON.stringify(job)], { cwd: ROOT });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('close', () => { const m = /RESULT (.*)/.exec(out); if (m) res.push(JSON.parse(m[1]!)); else console.error(`job failed ${JSON.stringify(job)}`); resolve(); });
  });
  await Promise.all(Array.from({ length: jobsN }, async () => { while (next < jobs.length) await runOne(jobs[next++]!); }));
  const out: Record<string, unknown> = { car, sets };
  console.log(`AI cards probe, car ${car}${sets.length ? ` (${sets.join(' ')})` : ''}: ${seeds} seeds x 2 brains`);
  for (const b of brains) {
    const st = res.filter((r) => r.kind === 'stint' && r.brain === b), ra = res.filter((r) => r.kind === 'race' && r.brain === b);
    const cars = st.length * 10;
    const band = (from: number, to: number, k: 'spins' | 'slides') => { let s = 0; for (const r of st) for (let L = from; L <= to; L++) s += r.perLap[L]?.[k] ?? 0; return s / (cars * (to - from + 1)); };
    const early = band(1, 5, 'spins'), late = band(16, 20, 'spins'), earlyS = band(1, 5, 'slides'), lateS = band(16, 20, 'slides');
    // Pace drop: each lap's median time vs laps 2-4.
    const med = (a: number[]) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[b.length >> 1]! : NaN; };
    const lapMed = (L: number) => med(st.flatMap((r) => r.perLap[L]?.time ?? []));
    const fresh = med([2, 3, 4].map(lapMed)), worst = Math.max(...[17, 18, 19, 20].map(lapMed).filter(Number.isFinite));
    const wear20 = { front: med(st.flatMap((r) => r.perLap[20]?.front ?? [])), rear: med(st.flatMap((r) => r.perLap[20]?.rear ?? [])) };
    const spinPts = st.flatMap((r) => r.spinAt);
    const hist = new Map<number, number>(); for (const q of spinPts) hist.set(Math.round(q / 5) * 5, (hist.get(Math.round(q / 5) * 5) ?? 0) + 1);
    const top = [...hist.entries()].sort((a, c) => c[1] - a[1]).slice(0, 5);
    const raceLaps = ra.reduce((a, r) => a + r.carLaps, 0);
    const sbs = ra.reduce((a, r) => ({ incidents: a.incidents + r.sbs.incidents, inside: a.inside + r.sbs.inside, insideFrontPast: a.insideFrontPast + r.sbs.insideFrontPast, planOver: a.planOver.concat(r.sbs.planOver) }), { incidents: 0, inside: 0, insideFrontPast: 0, planOver: [] as number[] });
    const per20 = (x: number) => (20 * x) / Math.max(1, raceLaps / 10) / 10; // per car per 20 laps
    const heavyPer = ra.map((r) => (r.heavy * 20) / Math.max(1, r.carLaps / 10) / 10), stuckPer = ra.map((r) => (r.stuck * 20) / Math.max(1, r.carLaps / 10) / 10);
    const q = (a: number[], p: number) => { const b = [...a].sort((x, y) => x - y); if (!b.length) return NaN; const x = (b.length - 1) * p, lo = Math.floor(x); return b[lo]! + (b[Math.min(b.length - 1, lo + 1)]! - b[lo]!) * (x - lo); };
    const row = {
      stint: { spinsPerCarLapEarly: early, spinsPerCarLapLate: late, lateVsEarly: early > 0 ? late / early : late > 0 ? Infinity : 1, slidesEarly: earlyS, slidesLate: lateS, freshLap: fresh, worstLateLap: worst, paceDrop: worst / fresh - 1, wearLeftLap20: wear20, spinSpots: top },
      race: { carLaps: raceLaps, sbsIncidents: sbs.incidents, sbsPer100CarLaps: (100 * sbs.incidents) / Math.max(1, raceLaps), insideIncidents: sbs.inside, insideFrontPastPeak: sbs.insideFrontPast, planOverPathMedian: q(sbs.planOver, 0.5), heavyPer20: { median: q(heavyPer, 0.5), iqr: q(heavyPer, 0.75) - q(heavyPer, 0.25) }, stuckPer20: { median: q(stuckPer, 0.5), iqr: q(stuckPer, 0.75) - q(stuckPer, 0.25) } },
    };
    out[b] = row;
    console.log(`  ${b}: STINT spins / car-lap early (1-5) ${early.toFixed(3)}, late (16-20) ${late.toFixed(3)} (x${row.stint.lateVsEarly.toFixed(1)}); big slides ${earlyS.toFixed(3)} -> ${lateS.toFixed(3)}; lap time fresh ${fresh.toFixed(2)} s, worst late ${worst.toFixed(2)} s (${((worst / fresh - 1) * 100).toFixed(1)}%); wear left after 20 laps F ${wear20.front.toFixed(3)} R ${wear20.rear.toFixed(3)}; spin spots ${top.map(([p, c]) => `${p}:${c}`).join(' ')}`);
    console.log(`  ${b}: RACES ${raceLaps} car-laps: side-by-side wall incidents ${sbs.incidents} (${row.race.sbsPer100CarLaps.toFixed(2)} / 100 car-laps), inside car ${sbs.inside} (fronts past peak ${sbs.insideFrontPast}, planned / path-allowed speed median ${row.race.planOverPathMedian.toFixed(2)}); heavy hits / 20 laps median ${row.race.heavyPer20.median.toFixed(2)} IQR ${row.race.heavyPer20.iqr.toFixed(2)}; stuck / 20 laps median ${row.race.stuckPer20.median.toFixed(2)} IQR ${row.race.stuckPer20.iqr.toFixed(2)}`);
    void per20;
  }
  if (ARGS.includes('--json')) writeFileSync(opt('json', 'out.json'), JSON.stringify(out, null, 1));
}

if (ARGS[0] === '--worker') console.log(`RESULT ${JSON.stringify(worker(JSON.parse(ARGS[1]!) as Job))}`);
else void main();
