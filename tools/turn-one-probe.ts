// Lap-1 turn-one probe (card "Lap-1 turn-one pile-up"): 10 AI on the grid (team field, shuffled), lights out, through
// turn one (the first real corner after the start line). For each car: its minimum speed through turn one on lap 1, by
// GRID POSITION, as a share of its own planned apex speed there (its preset's margins, measured limits). Also the most
// cars abreast through turn one, lap-1 heavy hits, stuck cars, and where the braking chain starts (the first grid slot
// whose minimum falls under 80% of its own plan).
// Usage: npm run turn-one-probe -- [--track oxford] [--seeds 20] [--set ai.x.y=v ...]
import aiJson from '../config/ai.json' with { type: 'json' };
import driversJson from '../config/drivers.json' with { type: 'json' };
import {
  aiInputSource, assignDrivers, buildRacingLine, buildStats, cornersOf, cornerTable, createRaceWorld, driverPreset, normalizeSetup, speedProfile, step,
  type AiConfig, type CarBuild, type DriverDef, type WorldState,
} from '../src/sim/index.ts';
import { contactLog } from './contact-split.ts';
import { catalog, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const track = opt('track', 'oxford'), seeds = Number(opt('seeds', '20'));
const L = loadTrackNode(track), ctx = simContextNode(L), line = buildRacingLine(L.track)!;
const base = structuredClone(aiJson) as unknown as AiConfig;
for (const [k, a] of args.entries()) if (a === '--set') { const [path, v] = args[k + 1]!.split('='); const ks = path!.split('.').slice(1); let o = base as unknown as Record<string, unknown>; for (const x of ks.slice(0, -1)) o = o[x] as Record<string, unknown>; o[ks[ks.length - 1]!] = v === 'true' ? true : v === 'false' ? false : Number(v); }
const setup = normalizeSetup(L.track.json.baseSetup ?? ctx.physics.defaultCar.setup, catalog.specs.setup);
const n = line.n, wrap = (q: number) => ((q % n) + n) % n;
// Turn one: the first corner (curvature over 1/40) after line point 0, from its start to 10 points past its end.
const t1 = cornersOf(line).map((c) => { let k = 0; for (let q = c.from; q !== wrap(c.to + 1); q = wrap(q + 1)) k = Math.max(k, Math.abs(line.k[q]!)); return { ...c, k }; }).filter((c) => c.k > 1 / 40).sort((a, b) => a.from - b.from)[0]!;
const inT1 = (q: number) => { const a = wrap(t1.from - 5), b = wrap(t1.to + 10); return a <= b ? q >= a && q <= b : q >= a || q <= b; };

const out: Record<string, { ratio: number[][]; abreast: number[]; heavy: number[]; stuck: number[] }> = {};
for (const brain of ['rules', 'lookahead'] as const) {
  const cfg = { ...base, brain };
  const res = { ratio: Array.from({ length: 10 }, () => [] as number[]), abreast: [] as number[], heavy: [] as number[], stuck: [] as number[] };
  for (let seed = 1; seed <= seeds; seed++) {
    const builds: CarBuild[] = Array.from({ length: 10 }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i % catalog.teams.length]!.id, setup }));
    const lineup = assignDrivers((driversJson as { drivers: DriverDef[] }).drivers, 10, seed);
    const presets = builds.map((_, i) => driverPreset(cfg.presets[cfg.defaultPreset]!, lineup[i], cfg.skill?.spread ?? 0));
    let w: WorldState = createRaceWorld(ctx, builds, { laps: 3, seed: seed + 100 });
    const order = w.race!.order; // order[slot] = car
    const drivers = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => presets[i]!, () => cfg, seed * 1000 + i));
    const plan = builds.map((b, i) => { const p = speedProfile(line.x, line.y, ctx.physics, buildStats(b, catalog), { cornerMargin: presets[i]!.cornerMargin, brakeMargin: presets[i]!.brakeMargin, fuelKg: ctx.physics.fuel.startKg, table: cfg.measuredLimits ? cornerTable(ctx, b) : undefined }); let m = Infinity; for (let q = t1.from; q !== wrap(t1.to + 1); q = wrap(q + 1)) m = Math.min(m, p[q]!); return m; });
    const minV = new Array<number>(10).fill(Infinity), done = new Array<boolean>(10).fill(false), seen = new Array<boolean>(10).fill(false);
    const log = contactLog(ctx);
    let abreast = 0, stuck = 0;
    for (let t = 0; t < 60 * 45 && !done.every(Boolean); t++) {
      w = step(w, drivers.map((d) => d.read(w.tick)), ctx);
      log.tick(w);
      if (w.race?.phase !== 'racing') continue;
      const inside: number[] = [];
      w.cars.forEach((c, i) => {
        const q = drivers[i]!.state.near;
        if (q < 0 || done[i] || c.timing.laps >= 1) return;
        if (inT1(q)) { seen[i] = true; minV[i] = Math.min(minV[i]!, Math.hypot(c.vx, c.vy)); inside.push(i); }
        else if (seen[i]) done[i] = true;
      });
      // Abreast: cars in turn one within a car length of each other along the road, more than a car width apart across.
      for (const a of inside) { const ca = w.cars[a]!, hx = Math.sin(ca.heading), hy = -Math.cos(ca.heading); let k = 1; for (const b of inside) { if (b === a) continue; const cb = w.cars[b]!, dx = cb.x - ca.x, dy = cb.y - ca.y, lon = dx * hx + dy * hy, lat = -dx * hy + dy * hx; if (Math.abs(lon) < ctx.physics.car.lengthM && Math.abs(lat) > ctx.physics.car.widthM * 0.9) k++; } abreast = Math.max(abreast, k); }
    }
    stuck = drivers.reduce((a, d) => a + d.state.stuckEvents, 0);
    (log as { finish?: () => void }).finish?.();
    res.heavy.push(log.incidents.filter((x) => x.peakMps >= log.thresholdMps).length);
    res.stuck.push(stuck);
    res.abreast.push(abreast);
    order.forEach((car, slot) => { if (Number.isFinite(minV[car]!)) res.ratio[slot]!.push(minV[car]! / plan[car]!); });
  }
  out[brain] = res;
}
const med = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1]! : NaN; };
console.log(`Turn-one probe, ${track}: turn one = line points ${t1.from}-${t1.to}; ${seeds} starts per brain${args.includes('--set') ? `; ${args.filter((a, i) => args[i - 1] === '--set').join(' ')}` : ''}`);
for (const [brain, r] of Object.entries(out)) {
  const ratios = r.ratio.map(med);
  const chain = ratios.findIndex((x) => x < 0.8);
  console.log(`  ${brain}: min speed / own planned apex speed by grid slot (median): ${ratios.map((x, i) => `P${i + 1} ${(x * 100).toFixed(0)}%`).join(' ')}`);
  console.log(`  ${brain}: last car ${(ratios[9]! * 100).toFixed(0)}% (target >= 60%); braking chain starts at ${chain < 0 ? 'none (all >= 80%)' : `P${chain + 1}`}; most abreast median ${med(r.abreast)}; lap-1 heavy hits per start ${(r.heavy.reduce((a, b) => a + b, 0) / r.heavy.length).toFixed(2)}; stuck per start ${(r.stuck.reduce((a, b) => a + b, 0) / r.stuck.length).toFixed(2)}`);
}
