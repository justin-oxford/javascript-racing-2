// Headless AI race check (card 05): N AI cars, L laps, no rendering, faster than real time.
// Usage: npm run ai-run -- [--track id] [--cars 10] [--laps 20] [--preset hard] [--seed 1]
// Reports per car: laps, best/median lap, spread, invalid laps, wall hits, stuck events, car contacts.
// Uses live config (physics, ai). Rerun after every AI change; regressions show up as numbers.
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, buildStats, createWorld, step, type AiConfig, type CarBuild, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : def;
};
const trackId = opt('track', defaultTrackIdNode());
const cars = Number(opt('cars', '10'));
const laps = Number(opt('laps', '20'));
const cfg = aiJson as unknown as AiConfig;
const presetName = opt('preset', cfg.defaultPreset);
const preset = cfg.presets[presetName];
if (!preset) throw new Error(`no preset "${presetName}"`);
const seed = Number(opt('seed', '1'));

const loaded = loadTrackNode(trackId);
const ctx = simContextNode(loaded);
const line = buildRacingLine(loaded.track);
console.log(line?.pit ? `pit path: ${line.pit.n} points, leaves the line at ${line.pit.entry}, rejoins at ${line.pit.exit}, box at path point ${line.pit.box}` : 'no pit path');
if (!line) throw new Error(`${trackId} has no racing line (npm run suggest-racing-line -- ${trackId} --write)`);

// One car per team (cycling if more cars than teams), default spec/setup.
const builds: CarBuild[] = Array.from({ length: cars }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i % catalog.teams.length]!.id }));
let world: WorldState = createWorld(ctx, builds);
const drivers = builds.map((_, i) => aiInputSource(i, () => ({ world, ctx, line }), () => preset, () => cfg, seed * 1000 + i));

interface Stat { laps: number[]; invalid: number; walls: number; contacts: number; barriers: number }
const stats: Stat[] = builds.map(() => ({ laps: [], invalid: 0, walls: 0, contacts: 0, barriers: 0 }));
const maxTicks = 60 * 60 * 30; // 30 simulated minutes safety cap
const t0 = performance.now();
let tick = 0;
// Overtakes: two cars swap order on the road while close together (laps x line length + line index).
// Positions are in 2 m steps, so remember each pair's last non-level order and count a flip of that.
const progress = (i: number) => world.cars[i]!.timing.laps * line.n + (drivers[i]!.state.mode === 'race' ? drivers[i]!.state.near : -1e6);
const order = new Map<number, number>();
let overtakes = 0;
for (; tick < maxTicks; tick++) {
  const prev = world;
  world = step(world, drivers.map((d) => d.read(world.tick)), ctx);
  world.cars.forEach((c, i) => {
    const p = prev.cars[i]!, s = stats[i]!;
    if (c.wallContact && !p.wallContact) s.walls++;
    if (c.barrierContact && !p.barrierContact) s.barriers++;
    if (c.carContact && !p.carContact) s.contacts++;
  });
  if (tick > 600)
    for (let a = 0; a < builds.length; a++)
      for (let b = a + 1; b < builds.length; b++) {
        const na = progress(a), nb = progress(b), key = a * 100 + b;
        if (na < 0 || nb < 0 || na === nb) continue;
        if (Math.abs(na - nb) > 15) { order.delete(key); continue; } // not close: no pass in progress
        const sgn = Math.sign(na - nb), was = order.get(key);
        if (was !== undefined && was !== sgn) overtakes++;
        order.set(key, sgn);
      }
  for (const e of world.events) {
    if (e.type !== 'lap') continue;
    const s = stats[e.car]!;
    if (e.invalid) s.invalid++;
    else s.laps.push(e.time);
  }
  if (world.cars.every((c) => c.timing.laps >= laps)) break;
}
const wall = (performance.now() - t0) / 1000;

const fmt = (t: number | undefined) => (t === undefined ? '   -   ' : `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`);
const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : undefined; };
console.log(`${trackId}, ${cars} AI cars (${presetName}), target ${laps} laps: ${(tick / 60).toFixed(0)} s simulated in ${wall.toFixed(1)} s (${(tick / 60 / wall).toFixed(0)}x real time)\n`);
console.log('car team          engine  laps valid  best      median    spread   invalid walls barrier contacts stuck mistakes pits');
const rows = world.cars.map((c, i) => {
  const s = stats[i]!, d = drivers[i]!.state, team = catalog.teams.find((t) => t.id === c.build.team)!;
  const best = s.laps.length ? Math.min(...s.laps) : undefined, med = median(s.laps);
  const sd = s.laps.length > 1 ? Math.sqrt(s.laps.reduce((a, x) => a + (x - (med ?? 0)) ** 2, 0) / s.laps.length) : 0;
  return { i, best, line: `${String(i).padStart(3)} ${team.name.padEnd(13)} ${buildStats(c.build, catalog).engine.toFixed(2).padStart(6)}  ${String(c.timing.laps).padStart(4)} ${String(s.laps.length).padStart(5)}  ${fmt(best)}  ${fmt(med)}  ${sd.toFixed(2).padStart(6)}s ${String(s.invalid).padStart(7)} ${String(s.walls).padStart(5)} ${String(s.barriers).padStart(7)} ${String(s.contacts).padStart(8)} ${String(d.stuckEvents).padStart(5)} ${String(d.mistakes).padStart(8)} ${String(d.pitStops).padStart(4)}` };
});
for (const r of rows) console.log(r.line);
const stuck = drivers.reduce((a, d) => a + d.state.stuckEvents, 0);
const unfinished = world.cars.filter((c) => c.timing.laps < laps).length;
console.log(`\nstuck events ${stuck}; cars short of ${laps} laps: ${unfinished}; overtakes ${overtakes}`);
console.log('pace order (best lap): ' + rows.filter((r) => r.best !== undefined).sort((a, b) => a.best! - b.best!).map((r) => catalog.teams.find((t) => t.id === world.cars[r.i]!.build.team)!.name).join(' > '));
// A stuck car = one that never finished; stuck *events* (beached, reversed out) are recovery working.
if (unfinished) process.exitCode = 1;
