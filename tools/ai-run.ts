// Headless AI race check (card 05): N AI cars, L laps, no rendering, faster than real time.
// Usage: npm run ai-run -- [--track id] [--cars 10] [--laps 20] [--preset hard] [--seed 1] [--race]
// --race: a real race (card 06): grid, start lights, own pit boxes, chequered flag; prints the classification.
// Reports per car: laps, best/median lap, spread, invalid laps, wall hits, stuck events, car contacts.
// Uses live config (physics, ai). Rerun after every AI change; regressions show up as numbers.
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, buildStats, createRaceWorld, createWorld, raceResults, step, type AiConfig, type CarBuild, type WorldState } from '../src/sim/index.ts';
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
const race = args.includes('--race');
let world: WorldState = race ? createRaceWorld(ctx, builds, { laps, seed }) : createWorld(ctx, builds);
if (race && world.race?.sharedBoxes) console.warn(`warning: ${ctx.track.boxes.length} pit box(es) for ${cars} cars: shared round-robin`);
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
// Race checks: progress never jumps; at each crossing the car shown ahead really is ahead; every service is in the car's own box.
let progressJumps = 0, orderErrors = 0, wrongBox = 0;
const prevProgress: number[] = [], prevCross: number[] = [];
for (; tick < maxTicks; tick++) {
  const prev = world;
  const before = process.env.PITDBG ? drivers.map((d) => ({ mode: d.state.mode, serviced: d.state.serviced, stuck: d.state.stuckEvents, stops: d.state.pitStops })) : [];
  world = step(world, drivers.map((d) => d.read(world.tick)), ctx);
  if (process.env.PITDBG) drivers.forEach((d, i) => {
    const b = before[i]!, st = d.state, c = world.cars[i]!, ppm = ctx.track.json.pxPerMeter, at = `(${(c.x * ppm).toFixed(0)},${(c.y * ppm).toFixed(0)})`;
    if (st.mode !== b.mode) console.log(`pit t=${(tick / 60).toFixed(1)} car ${i} ${b.mode} -> ${st.mode} ${at} fuel ${c.fuelKg.toFixed(1)}`);
    if (st.serviced && !b.serviced) console.log(`pit t=${(tick / 60).toFixed(1)} car ${i} ${st.pitStops > b.stops ? 'SERVICED' : 'GAVE UP'} ${at} box ${c.pitBox} own ${world.race?.cars[i]?.box} near ${st.near} servicing ${c.servicing}`);
    if (st.stuckEvents > b.stuck) console.log(`stuck t=${(tick / 60).toFixed(1)} car ${i} mode ${st.mode} ${at} near ${st.near}`);
  });
  world.cars.forEach((c, i) => {
    const p = prev.cars[i]!, s = stats[i]!;
    if (c.wallContact && !p.wallContact) s.walls++;
    if (c.barrierContact && !p.barrierContact) s.barriers++;
    if (c.carContact && !p.carContact) s.contacts++;
  });
  if (race && (world.race!.phase === 'racing' || world.race!.phase === 'finishing')) {
    const r = world.race!;
    // Progress must move smoothly (a jump = mis-tracking, e.g. in the pit lane or at the line).
    r.cars.forEach((c, i) => { const was = prevProgress[i]; if (was !== undefined && !c.finished && Math.abs(c.progress - was) > 0.05) { progressJumps++; if (process.env.GAPDBG) console.log(`jump t=${(tick / 60).toFixed(2)} car ${i} ${was.toFixed(3)} -> ${c.progress.toFixed(3)} mode ${drivers[i]!.state.mode}`); } prevProgress[i] = c.progress; });
    // At a crossing, the car shown ahead must already have crossed that line (unless they're level).
    r.cars.forEach((c, i) => {
      if (c.crossings.length === (prevCross[i] ?? 0)) return;
      prevCross[i] = c.crossings.length;
      const at = r.order.indexOf(i);
      if (at <= 0) return;
      const a = r.cars[r.order[at - 1]!]!;
      if (!a.finished && a.crossings.length < c.crossings.length && a.progress - c.progress > 0.003) {
        orderErrors++;
        if (process.env.GAPDBG) console.log(`order t=${(tick / 60).toFixed(2)} car ${i} crossed #${c.crossings.length} but car ${r.order[at - 1]} (crossed ${a.crossings.length}, prog ${a.progress.toFixed(3)} vs ${c.progress.toFixed(3)}) is shown ahead`);
      }
    });
    world.cars.forEach((c, i) => { if (c.servicing && c.pitBox !== r.cars[i]!.box) wrongBox++; });
  }
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
  if (race ? world.race!.phase === 'results' : world.cars.every((c) => c.timing.laps >= laps)) break;
}
const wall = (performance.now() - t0) / 1000;

const fmt = (t: number | undefined) => (t === undefined ? '   -   ' : `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`);
const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : undefined; };
console.log(`${trackId}, ${cars} AI cars (${presetName}), target ${laps} laps: ${(tick / 60).toFixed(0)} s simulated in ${wall.toFixed(1)} s (${(tick / 60 / wall).toFixed(0)}x real time)\n`);
console.log('car team          engine  laps valid  best      median    spread   invalid walls barrier contacts stuck mistakes pits resets');
const rows = world.cars.map((c, i) => {
  const s = stats[i]!, d = drivers[i]!.state, team = catalog.teams.find((t) => t.id === c.build.team)!;
  const best = s.laps.length ? Math.min(...s.laps) : undefined, med = median(s.laps);
  const sd = s.laps.length > 1 ? Math.sqrt(s.laps.reduce((a, x) => a + (x - (med ?? 0)) ** 2, 0) / s.laps.length) : 0;
  return { i, best, line: `${String(i).padStart(3)} ${team.name.padEnd(13)} ${buildStats(c.build, catalog).engine.toFixed(2).padStart(6)}  ${String(c.timing.laps).padStart(4)} ${String(s.laps.length).padStart(5)}  ${fmt(best)}  ${fmt(med)}  ${sd.toFixed(2).padStart(6)}s ${String(s.invalid).padStart(7)} ${String(s.walls).padStart(5)} ${String(s.barriers).padStart(7)} ${String(s.contacts).padStart(8)} ${String(d.stuckEvents).padStart(5)} ${String(d.mistakes).padStart(8)} ${String(d.pitStops).padStart(4)} ${String(d.resets).padStart(6)}` };
});
for (const r of rows) console.log(r.line);
const stuck = drivers.reduce((a, d) => a + d.state.stuckEvents, 0);
const unfinished = world.cars.filter((c) => c.timing.laps < laps).length;
console.log(`\nstuck events ${stuck}; cars short of ${laps} laps: ${unfinished}; overtakes ${overtakes}`);
console.log('pace order (best lap): ' + rows.filter((r) => r.best !== undefined).sort((a, b) => a.best! - b.best!).map((r) => catalog.teams.find((t) => t.id === world.cars[r.i]!.build.team)!.name).join(' > '));
// A stuck car = one that never finished; stuck *events* (beached, reversed out) are recovery working.
if (!race && unfinished) process.exitCode = 1;

if (race) {
  const r = world.race!;
  const fmtGap = (g: { seconds: number; laps: number } | undefined) => (!g ? '' : g.laps ? `+${g.laps} lap${g.laps > 1 ? 's' : ''}` : `+${g.seconds.toFixed(3)}s`);
  console.log(`
RACE: ${r.laps} laps, phase ${r.phase}, lights out at ${r.startTime.toFixed(2)} s (hold ${(r.holdTicks / 60).toFixed(2)} s)`);
  console.log('pos car team          laps  time       gap          best      pits box jump');
  for (const row of raceResults(r)) {
    const team = catalog.teams.find((t) => t.id === world.cars[row.car]!.build.team)!.name;
    console.log(`${String(row.pos).padStart(3)} ${String(row.car).padStart(3)} ${team.padEnd(13)} ${String(row.laps).padStart(4)}  ${row.finished ? fmt(row.time) : '  DNF   '}  ${fmtGap(row.gap).padEnd(11)}  ${row.bestLap ? fmt(row.bestLap) : '   -   '}  ${String(row.pitStops).padStart(4)} ${String(r.cars[row.car]!.box + 1).padStart(3)} ${row.jumpStart ? 'JUMP' : ''}`);
  }
  console.log(`checks: progress jumps ${progressJumps}; order wrong at a line crossing ${orderErrors}; services outside the car's own box ${wrongBox}`);
  if (r.phase !== 'results' || raceResults(r).some((x) => !x.finished) || progressJumps || orderErrors || wrongBox) process.exitCode = 1;
}
