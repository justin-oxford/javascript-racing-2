// Wet weather probe (POLISH card): a Changeable race on the default track, 10 AI (Equal cars), live config.
// Per lap: rain, mean water on the racing line (and off it), tyres in use, mean lap time on slicks vs inters.
// Per car: stops (lap, from -> to). The CROSSOVER LAP after the shower: by grip (when slicks out-grip inters
// on the water left on the line) and by lap times (first lap slicks are quicker than inters).
// Usage: npm run weather-probe [-- --laps 20 --seed 3 --mode changeable|wet]
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, compoundWaterGrip, createRaceWorld, rainAt, shower, step, waterAt, type AiConfig, type CarBuild, type Compound, type WeatherMode, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const laps = Number(opt('laps', '20')), seed = Number(opt('seed', '3')), mode = opt('mode', 'changeable') as WeatherMode;
const loaded = loadTrackNode(defaultTrackIdNode());
const ctx = simContextNode(loaded);
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const settings = { weather: mode, weatherSeed: seed };

function race() {
  const builds: CarBuild[] = Array.from({ length: 10 }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id, equalise: ctx.race.equalise, compound: mode === 'wet' ? 'wet' : 'medium' }));
  let w: WorldState = createRaceWorld(ctx, builds, { laps, seed, settings });
  const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => ({ ...cfg.presets[cfg.defaultPreset]!, mistakesPerMin: 0 }), () => cfg, seed * 100 + i));
  const stops: string[][] = builds.map(() => []);
  const stuckSeen: number[] = [];
  const lapRows: Array<{ lap: number; rain: number; onLine: number; offLine: number; tyres: Record<string, number>; slick: number[]; inter: number[] }> = [];
  const leaderLap = () => Math.max(...w.cars.map((c) => c.timing.laps));
  let row = { lap: 0, rain: 0, onLine: 0, offLine: 0, tyres: {} as Record<string, number>, slick: [] as number[], inter: [] as number[] };
  for (let t = 0; t < 60 * 60 * 40 && w.race!.phase !== 'results'; t++) {
    const prev = w;
    w = step(w, ai.map((d) => d.read(w.tick)), ctx);
    if (process.env.STUCK) ai.forEach((d, i) => { if (d.state.stuckEvents > (stuckSeen[i] ?? 0)) { stuckSeen[i] = d.state.stuckEvents; const c = w.cars[i]!; console.log(`  stuck t=${(w.tick / 60).toFixed(0)} car ${i} lap ${c.timing.laps} ${c.compound} near ${d.state.near} ${d.state.mode} water here ${waterAt(w.surface, c.x, c.y).toFixed(2)} wall ${c.wallContact} carContact ${c.carContact}`); } });
    w.cars.forEach((c, i) => { if (c.compound !== prev.cars[i]!.compound) stops[i]!.push(`L${c.timing.laps} ${prev.cars[i]!.compound}->${c.compound}`); });
    // PITLOG=1: every pit entry and service (what it had, what it got, the water it saw).
    if (process.env.PITLOG) ai.forEach((d, i) => {
      const c = w.cars[i]!, p = prev.cars[i]!;
      if (c.inPitLane && !p.inPitLane) console.log(`  t=${(w.tick / 60).toFixed(0)} car ${i} lap ${c.timing.laps} INTO PITS on ${c.compound} fuel ${c.fuelKg.toFixed(1)} wear ${c.wheels.map((x) => x.wear.toFixed(2)).join('/')} water here ${waterAt(w.surface, c.x, c.y).toFixed(2)}`);
      if (!c.servicing && p.servicing) console.log(`  t=${(w.tick / 60).toFixed(0)} car ${i} serviced: ${p.compound} -> ${c.compound}, fuel ${c.fuelKg.toFixed(1)}`);
    });
    for (const e of w.events) if (e.type === 'lap') (['inter', 'wet'].includes(w.cars[e.car]!.compound) ? row.inter : row.slick).push(e.time);
    if (leaderLap() > row.lap) {
      // The water on the racing line, and 4 m to the side of it.
      let on = 0, off = 0;
      for (let q = 0; q < line.n; q += 5) {
        on += waterAt(w.surface, line.x[q]!, line.y[q]!);
        const a = (q + 1) % line.n, tx = line.x[a]! - line.x[q]!, ty = line.y[a]! - line.y[q]!, l = Math.hypot(tx, ty) || 1;
        off += waterAt(w.surface, line.x[q]! - (ty / l) * 4, line.y[q]! + (tx / l) * 4);
      }
      const k = Math.ceil(line.n / 5);
      row = { ...row, rain: rainAt(w.tick / 60, mode, seed, ctx.weather), onLine: on / k, offLine: off / k, tyres: w.cars.reduce((a, c) => ({ ...a, [c.compound]: (a[c.compound] ?? 0) + 1 }), {} as Record<string, number>) };
      lapRows.push(row);
      row = { lap: leaderLap(), rain: 0, onLine: 0, offLine: 0, tyres: {}, slick: [], inter: [] };
    }
  }
  return { w, ai, stops, lapRows };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const r = race();
if (mode === 'changeable') { const s = shower(seed, ctx.weather); console.log(`shower: ${s.start.toFixed(0)}-${s.end.toFixed(0)} s, intensity ${s.intensity.toFixed(2)}`); }
console.log('lap  rain  water on line / 4 m off   tyres                     mean lap slicks / wet tyres');
for (const x of r.lapRows) console.log(`${String(x.lap + 1).padStart(3)}  ${x.rain.toFixed(2)}  ${x.onLine.toFixed(2)} / ${x.offLine.toFixed(2)}             ${Object.entries(x.tyres).map(([k, v]) => `${k} ${v}`).join(', ').padEnd(26)}${mean(x.slick).toFixed(2)} / ${mean(x.inter).toFixed(2)}`);
console.log('\nstops:');
r.stops.forEach((s, i) => console.log(`  car ${i}: ${s.join(', ') || 'none'}; pit stops ${r.ai[i]!.state.pitStops}`));
// Crossover: after the wettest lap, the first lap slicks out-grip inters on the line's water / are quicker.
const peak = r.lapRows.reduce((b, x, k) => (x.onLine > r.lapRows[b]!.onLine ? k : b), 0);
const gripCross = r.lapRows.findIndex((x, k) => k > peak && compoundWaterGrip('medium' as Compound, x.onLine, ctx.strategy) >= compoundWaterGrip('inter' as Compound, x.onLine, ctx.strategy));
const timeCross = r.lapRows.findIndex((x, k) => k > peak && x.slick.length && x.inter.length && mean(x.slick) < mean(x.inter));
console.log(`\ncrossover after the wettest lap (${peak + 1}): by grip on the line's water lap ${gripCross < 0 ? '-' : gripCross + 1}, by lap times lap ${timeCross < 0 ? '-' : timeCross + 1}`);
console.log(`finished ${r.w.race!.phase === 'results'}; stuck ${r.ai.reduce((a, d) => a + d.state.stuckEvents, 0)}`);
