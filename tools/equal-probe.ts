// Equal performance probe (POLISH card): each team ALONE on the default track (no traffic), best of N laps.
//  1. Team stats vs Equal (race.json equalise), driver skill spread 0: Equal should put every team, Motus
//     included, within ~0.1 s; Team stats keeps today's spread.
//  2. Equal cars with driver skill on (ai.json skill.spread): the field spreads by driver, seeded.
// Usage: npm run equal-probe [-- --laps 3 --seed 1 --spread 0.02]
import aiJson from '../config/ai.json' with { type: 'json' };
import driversJson from '../config/drivers.json' with { type: 'json' };
import { aiInputSource, assignDrivers, buildRacingLine, createWorld, driverPreset, step, type AiConfig, type CarBuild, type DriverDef, type DriverStats, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const laps = Number(opt('laps', '3')), seed = Number(opt('seed', '1'));
const loaded = loadTrackNode(defaultTrackIdNode());
const ctx = simContextNode(loaded);
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const base = { ...cfg.presets[cfg.defaultPreset]!, mistakesPerMin: 0 };
const spread = Number(opt('spread', String(cfg.skill?.spread ?? 0.02)));

/** Best clean lap of one car alone. */
function solo(build: CarBuild, driver: DriverStats | undefined): number {
  let w: WorldState = createWorld(ctx, [build]);
  const preset = driverPreset(base, driver, spread);
  const d = aiInputSource(0, () => ({ world: w, ctx, line }), () => preset, () => cfg, 7);
  let best = Infinity;
  for (let t = 0; t < 60 * 60 * 5 && w.cars[0]!.timing.laps < laps; t++) {
    w = step(w, [d.read(w.tick)], ctx);
    for (const e of w.events) if (e.type === 'lap' && !e.invalid) best = Math.min(best, e.time);
  }
  return best;
}
const fmt = (t: number) => (Number.isFinite(t) ? t.toFixed(3) : '  ---  ');
const range = (xs: number[]) => { const f = xs.filter(Number.isFinite); return Math.max(...f) - Math.min(...f); };

console.log(`${loaded.track.json.id}: best of ${laps} solo laps, ${cfg.defaultPreset} preset, no mistakes`);
console.log('team           team stats   equal');
const teamT: number[] = [], eqT: number[] = [];
for (const team of catalog.teams) {
  const b: CarBuild = { ...ctx.physics.defaultCar, team: team.id };
  const a = solo(b, undefined), e = solo({ ...b, equalise: ctx.race.equalise }, undefined);
  teamT.push(a); eqT.push(e);
  console.log(`${team.name.padEnd(13)}  ${fmt(a).padStart(9)}  ${fmt(e).padStart(9)}`);
}
console.log(`range (slowest - fastest): team stats ${range(teamT).toFixed(3)} s, equal ${range(eqT).toFixed(3)} s`);

console.log(`\nequal cars, roster drivers (pace spread +-${(spread * 100).toFixed(1)}%), seed ${seed}:`);
const roster = (driversJson as { drivers: DriverDef[] }).drivers;
const run = (s: number) => assignDrivers(roster, 10, s).map((d, k) => ({ car: k + 1, d, t: solo({ ...ctx.physics.defaultCar, team: catalog.teams[k]!.id, equalise: ctx.race.equalise }, d) }));
const r1 = run(seed);
for (const r of r1) console.log(`  car ${String(r.car).padStart(2)}  ${r.d.code} pace ${r.d.pace}  best ${fmt(r.t)}`);
const order = (rs: typeof r1) => [...rs].sort((a, b) => a.t - b.t).map((r) => r.car).join(' ');
console.log(`  range ${range(r1.map((r) => r.t)).toFixed(3)} s; order ${order(r1)}`);
const r2 = run(seed);
console.log(`  same seed again: order ${order(r2)} (${order(r2) === order(r1) ? 'repeats' : 'DIFFERENT'})`);
console.log(`  seed ${seed + 1}: order ${order(run(seed + 1))}`);
