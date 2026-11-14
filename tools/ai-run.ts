// Headless AI race check (card 05): N AI cars, L laps, no rendering, faster than real time.
// Usage: npm run ai-run -- [--track id] [--cars 10] [--laps 20] [--preset hard] [--seed 1] [--race]
// --race: a real race (card 06): grid, start lights, own pit boxes, chequered flag; prints the classification.
// Reports per car: laps, best/median lap, spread, invalid laps, wall hits, stuck events, car contacts.
// Uses live config (physics, ai). Rerun after every AI change; regressions show up as numbers.
import aiJson from '../config/ai.json' with { type: 'json' };
import driversJson from '../config/drivers.json' with { type: 'json' };
import { aiInputSource, assignDrivers, driverPreset, type DriverDef, buildRacingLine, buildStats, createRaceWorld, createWorld, raceResults, step, type AiConfig, type CarBuild, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';
import { contactLog, histogram } from './contact-split.ts';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : def;
};
const trackId = opt('track', defaultTrackIdNode());
const cars = Number(opt('cars', '10'));
const laps = Number(opt('laps', '20'));
const cfg = structuredClone(aiJson) as unknown as AiConfig;
// --set section.path=value (repeatable): override a live config number for this run, e.g.
// --set ai.overtaking.closeUntilBrakeSec=0 or --set slipstream.dirtyAir.maxDownforceLoss=0.
const overrides = args.flatMap((a, i) => (a === '--set' ? [args[i + 1]!] : []));
const setPath = (root: Record<string, unknown>, path: string[], value: number) => {
  let o = root;
  for (const k of path.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
  o[path.at(-1)!] = value;
};
const presetName = opt('preset', cfg.defaultPreset);
const preset = cfg.presets[presetName];
if (!preset) throw new Error(`no preset "${presetName}"`);
const seed = Number(opt('seed', '1'));

const loaded = loadTrackNode(trackId);
const ctx = simContextNode(loaded);
for (const o of overrides) {
  const [path, v] = o.split('=') as [string, string];
  const [sec, ...rest] = path.split('.');
  if (sec === 'ai') setPath(cfg as unknown as Record<string, unknown>, rest, Number(v));
  else setPath((ctx as unknown as Record<string, Record<string, unknown>>)[sec!]!, rest, Number(v));
  console.log(`override ${path} = ${v}`);
}
const line = buildRacingLine(loaded.track);
console.log(line?.pit ? `pit path: ${line.pit.n} points, leaves the line at ${line.pit.entry}, rejoins at ${line.pit.exit}, box at path point ${line.pit.box}` : 'no pit path');
if (!line) throw new Error(`${trackId} has no racing line (npm run suggest-racing-line -- ${trackId} --write)`);

// One car per team (cycling if more cars than teams), default spec/setup.
// --equal: Equal performance mode (identical cars; the drivers decide). --no-roster: anonymous drivers.
const equal = args.includes('--equal');
const builds: CarBuild[] = Array.from({ length: cars }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i % catalog.teams.length]!.id, ...(equal ? { equalise: ctx.race.equalise } : {}) }));
const lineup = args.includes('--no-roster') ? [] : assignDrivers((driversJson as { drivers: DriverDef[] }).drivers, cars, seed);
const race = args.includes('--race');
// --damage visual|realistic: the race setup's Damage setting (default Off); prints the damage each car ends with.
const damage = opt('damage', 'off') as 'off' | 'visual' | 'realistic';
let world: WorldState = race ? createRaceWorld(ctx, builds, { laps, seed, settings: { damage } }) : createWorld(ctx, builds);
if (race && world.race?.sharedBoxes) console.warn(`warning: ${ctx.track.boxes.length} pit box(es) for ${cars} cars: shared round-robin`);
const presets = builds.map((_, i) => driverPreset(preset, lineup[i], cfg.skill?.spread ?? 0));
const drivers = builds.map((_, i) => aiInputSource(i, () => ({ world, ctx, line }), () => presets[i]!, () => cfg, seed * 1000 + i));

// --catches: each car's solo pace (alone on track, 3 laps, its own driver), then every CATCH in the race: a car at
// least catchPaceSec a lap quicker solo gets within 1 s of the car directly ahead (lap 2 on, neither in the pit lane).
// Time to pass = from the catch until it's ahead on race progress; or lost touch (over 2.5 s back), a pit stop,
// the race ending, or another car getting between them (traffic).
const catchesOn = race && args.includes('--catches');
const catchPaceSec = Number(opt('catch-pace', '0.5'));
const soloBest: number[] = [];
if (catchesOn) {
  for (let i = 0; i < builds.length; i++) {
    let w: WorldState = createWorld(ctx, [builds[i]!]);
    const d = aiInputSource(0, () => ({ world: w, ctx, line }), () => ({ ...presets[i]!, mistakesPerMin: 0 }), () => cfg, seed * 1000 + i);
    let best = Infinity;
    for (let t = 0; t < 60 * 150 && w.cars[0]!.timing.laps < 3; t++) { w = step(w, [d.read(w.tick)], ctx); for (const e of w.events) if (e.type === 'lap' && !e.invalid && w.cars[0]!.timing.laps > 1) best = Math.min(best, e.time); }
    soloBest.push(best);
  }
  console.log(`solo pace (best of laps 2-3): ${soloBest.map((b, i) => `${i}:${b.toFixed(2)}`).join(' ')}`);
}
interface Catch { a: number; b: number; atSec: number; atLap: number; paceGap: number; outcome?: string; tookSec?: number; tookLaps?: number }
const catches: Catch[] = [];
const openCatch = new Map<number, Catch>();
interface Stat { laps: number[]; invalid: number; walls: number; contacts: number; barriers: number }
const stats: Stat[] = builds.map(() => ({ laps: [], invalid: 0, walls: 0, contacts: 0, barriers: 0 }));
const contactsLog = contactLog(ctx);
const mistakeSeen: number[] = [], mistakeAt: number[] = [], stuckSeen: number[] = [];
const maxTicks = 60 * 60 * 30; // 30 simulated minutes safety cap
const t0 = performance.now();
let tick = 0;
// Overtakes: two cars swap order on the road while close together (laps x line length + line index).
// Positions are in 2 m steps, so remember each pair's last non-level order and count a flip of that.
const progress = (i: number) => world.cars[i]!.timing.laps * line.n + (drivers[i]!.state.mode === 'race' ? drivers[i]!.state.near : -1e6);
const order = new Map<number, number>();
let overtakes = 0, swapsBack = 0;
const lastFlip = new Map<number, number>();
// Race checks: progress never jumps; at each crossing the car shown ahead really is ahead; every service is in the car's own box.
let progressJumps = 0, orderErrors = 0, wrongBox = 0;
const prevProgress: number[] = [], prevCross: number[] = [];
for (; tick < maxTicks; tick++) {
  const prev = world;
  const before = process.env.PITDBG ? drivers.map((d) => ({ mode: d.state.mode, serviced: d.state.serviced, stuck: d.state.stuckEvents, stops: d.state.pitStops })) : [];
  world = step(world, drivers.map((d) => d.read(world.tick)), ctx);
  contactsLog.tick(world);
  // TRACEAT=from,to,lo,hi: every car between line pts lo..hi every 0.25 s from `from` to `to` seconds.
  if (process.env.TRACEAT && tick % 15 === 0) {
    const [f, to, lo, hi] = process.env.TRACEAT.split(',').map(Number) as [number, number, number, number];
    if (tick / 60 >= f && tick / 60 <= to) console.log(`at t=${(tick / 60).toFixed(2)} ` + drivers.map((d, k) => ({ d, k })).filter(({ d }) => d.state.near >= lo && d.state.near <= hi).map(({ d, k }) => { const c = world.cars[k]!; return `[${k} n${d.state.near} v${Math.hypot(c.vx, c.vy).toFixed(1)} ${d.state.craft}${d.state.passTarget >= 0 ? '/pt' + d.state.passTarget : ''} off${d.state.offset.toFixed(1)} thr${c.controls.throttle.toFixed(1)} brk${c.controls.brake.toFixed(1)} st${c.controls.steer.toFixed(2)}${c.carContact ? ' C' : ''}${c.wallContact ? ' W' : ''} lap${world.race?.cars[k]?.progress.toFixed(2)}${d.state.blueYield ? ' BLUE' : ''}]`; }).join(' '));
  }
  // TRACEPAIR=a,b: the chaser a and the car ahead b every 0.5 s (gap on the line, speeds, a's racecraft and pass state).
  if (process.env.TRACEPAIR && tick % 30 === 0 && world.race?.phase === 'racing') {
    const [pa, pb] = process.env.TRACEPAIR.split(',').map(Number) as [number, number];
    const A = world.cars[pa]!, B = world.cars[pb]!, sa = drivers[pa]!.state, sb = drivers[pb]!.state, gapM = (world.race.cars[pb]!.progress - world.race.cars[pa]!.progress) * line.length;
    if (Math.abs(gapM) < 80) console.log(`pair t=${(tick / 60).toFixed(1)} lap ${(world.race.cars[pa]!.progress + 1).toFixed(2)} near ${sa.near} gap ${gapM.toFixed(1)} m v ${Math.hypot(A.vx, A.vy).toFixed(1)}/${Math.hypot(B.vx, B.vy).toFixed(1)} A ${sa.craft}/pt${sa.passTarget}/side${sa.passSide}/off${sa.offset.toFixed(1)}/tries${sa.passTries}/tow${A.tow.toFixed(2)}/dirty${A.dirtyAir.toFixed(2)}/brkIn${sa.brakeInSec === Infinity ? '-' : sa.brakeInSec.toFixed(1)} B ${sb.craft}/${sb.defence}/off${sb.offset.toFixed(1)}`);
  }
  // STUCK=1: each stuck event with its lap, where, and the car's last mistake (how long before).
  if (process.env.STUCK) drivers.forEach((d, i) => {
    const st = d.state, c = world.cars[i]!;
    if (st.mistakes > (mistakeSeen[i] ?? 0)) { mistakeSeen[i] = st.mistakes; mistakeAt[i] = tick; }
    if (st.stuckEvents > (stuckSeen[i] ?? 0)) { stuckSeen[i] = st.stuckEvents; console.log(`stuck t=${(tick / 60).toFixed(1)} car ${i} lap ${c.timing.laps + 1} near ${st.near} mode ${st.mode} last mistake ${mistakeAt[i] !== undefined ? `${st.lastMistake} ${((tick - mistakeAt[i]!) / 60).toFixed(1)} s before` : 'none'} wall ${c.wallContact} carContact ${c.carContact} fuel ${c.fuelKg.toFixed(1)} kg tyres ${c.wheels.map((x) => x.wear.toFixed(2)).join("/")} pits ${st.pitStops}`); }
  });
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
    if (c.carContact && !p.carContact) {
      s.contacts++;
      // HITS=1: who with (nearest car), where in its frame, and both drivers' racecraft state.
      if (process.env.HITS) {
        let j = -1, bd = Infinity;
        world.cars.forEach((o, k) => { const d = Math.hypot(o.x - c.x, o.y - c.y); if (k !== i && d < bd) { bd = d; j = k; } });
        const o = world.cars[j]!, fx = Math.sin(c.heading), fy = -Math.cos(c.heading), lon = (o.x - c.x) * fx + (o.y - c.y) * fy, lat = -(o.x - c.x) * fy + (o.y - c.y) * fx;
        const st = (k: number) => { const a = drivers[k]!.state; return `${a.craft}/${a.defence}/w${a.lineW.map((x) => x.toFixed(1)).join(',')}/off${a.offset.toFixed(1)}/pt${a.passTarget}/${a.mode}${world.cars[k]!.inPitLane ? "-lane" : ""}/m${a.lastMistake}${a.mistake ? "!" : ""}/v${Math.hypot(world.cars[k]!.vx, world.cars[k]!.vy).toFixed(0)}`; };
        console.log(`hit t=${(tick / 60).toFixed(1)} car ${i} [${st(i)}] with ${j} [${st(j)}] near ${drivers[i]!.state.near} lon ${lon.toFixed(1)} lat ${lat.toFixed(1)}`);
      }
    }
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
  if (catchesOn && (world.race!.phase === 'racing' || world.race!.phase === 'finishing')) {
    const rc = world.race!.cars, t = tick / 60;
    for (let a = 0; a < builds.length; a++) for (let b = 0; b < builds.length; b++) {
      if (a === b) continue;
      const key = a * 100 + b, o = openCatch.get(key), lapA = soloBest[a]!, gapSec = (rc[b]!.progress - rc[a]!.progress) * lapA;
      const between = rc.some((c, k) => k !== a && k !== b && c.progress > rc[a]!.progress && c.progress < rc[b]!.progress);
      if (o) {
        const end = (outcome: string) => { o.outcome = outcome; o.tookSec = t - o.atSec; o.tookLaps = o.tookSec / lapA; openCatch.delete(key); };
        if (gapSec < 0) end('passed');
        else if (gapSec > 2.5) end('lost touch');
        else if (rc[a]!.finished || rc[b]!.finished || world.race!.phase === 'finishing') end('race ended');
        else if (world.cars[a]!.inPitLane || world.cars[b]!.inPitLane) end('pit');
        else if (between) end('traffic');
        continue;
      }
      if (world.race!.phase !== 'racing' || rc[a]!.progress < 1 || gapSec <= 0 || gapSec > 1 || between) continue;
      if (soloBest[b]! - lapA < catchPaceSec || world.cars[a]!.inPitLane || world.cars[b]!.inPitLane || rc[a]!.finished || rc[b]!.finished) continue;
      // Already caught this car and lost touch / passed: a new catch only after being properly apart (handled by the 2.5 s rule).
      const c: Catch = { a, b, atSec: t, atLap: rc[a]!.progress, paceGap: soloBest[b]! - lapA };
      catches.push(c); openCatch.set(key, c);
    }
  }
  if (tick > 600)
    for (let a = 0; a < builds.length; a++)
      for (let b = a + 1; b < builds.length; b++) {
        const na = progress(a), nb = progress(b), key = a * 100 + b;
        if (na < 0 || nb < 0 || na === nb) continue;
        if (Math.abs(na - nb) > 15) { order.delete(key); continue; } // not close: no pass in progress
        const sgn = Math.sign(na - nb), was = order.get(key);
        if (was !== undefined && was !== sgn) { overtakes++; const lf = lastFlip.get(key); if (lf !== undefined && tick - lf < 60 * 60) swapsBack++; lastFlip.set(key, tick); }
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
console.log('car team          drv pace agg con engine  laps valid  best      median    spread   invalid walls barrier contacts stuck mistakes pits resets');
const rows = world.cars.map((c, i) => {
  const s = stats[i]!, d = drivers[i]!.state, team = catalog.teams.find((t) => t.id === c.build.team)!;
  const best = s.laps.length ? Math.min(...s.laps) : undefined, med = median(s.laps);
  const sd = s.laps.length > 1 ? Math.sqrt(s.laps.reduce((a, x) => a + (x - (med ?? 0)) ** 2, 0) / s.laps.length) : 0;
  const dv = lineup[i];
  return { i, best, line: `${String(i).padStart(3)} ${team.name.padEnd(13)} ${dv ? `${dv.code} ${String(dv.pace).padStart(4)} ${String(dv.aggression).padStart(3)} ${String(dv.consistency).padStart(3)}` : '  -    -   -   -'} ${buildStats(c.build, catalog).engine.toFixed(2).padStart(6)}  ${String(c.timing.laps).padStart(4)} ${String(s.laps.length).padStart(5)}  ${fmt(best)}  ${fmt(med)}  ${sd.toFixed(2).padStart(6)}s ${String(s.invalid).padStart(7)} ${String(s.walls).padStart(5)} ${String(s.barriers).padStart(7)} ${String(s.contacts).padStart(8)} ${String(d.stuckEvents).padStart(5)} ${String(d.mistakes).padStart(8)} ${String(d.pitStops).padStart(4)} ${String(d.resets).padStart(6)}` };
});
for (const r of rows) console.log(r.line);
const stuck = drivers.reduce((a, d) => a + d.state.stuckEvents, 0);
const unfinished = world.cars.filter((c) => c.timing.laps < laps).length;
contactsLog.finish();
console.log(`car ${contactsLog.summary()}`);
if (damage !== 'off') console.log(`damage (${damage}): ${world.cars.map((c, i) => { const d = c.damage; const tot = d.frontWing + d.rearWing + d.left + d.right; return tot > 0 ? `car ${i} F${(d.frontWing * 100).toFixed(0)} R${(d.rearWing * 100).toFixed(0)} L${(d.left * 100).toFixed(0)} R${(d.right * 100).toFixed(0)}%` : ''; }).filter(Boolean).join('; ') || 'none'}; repair stops ${drivers.reduce((a, d) => a + d.state.pitStops, 0)}`);
if (process.env.INCIDENTS) for (const i of contactsLog.incidents) console.log(`incident t=${(i.startTick / 60).toFixed(1)} cars ${i.a}-${i.b} peak ${i.peakMps.toFixed(1)} m/s; b at lon ${i.lon.toFixed(1)} lat ${i.lat.toFixed(1)} in a's frame, speeds ${i.va.toFixed(1)}/${i.vb.toFixed(1)}, heading diff ${i.angDeg.toFixed(0)} deg`);
if (process.env.CONTACTHIST) console.log(`car contact peaks (m/s): ${histogram(contactsLog.incidents.map((i) => i.peakMps))}\nwall/barrier hit peaks (m/s): ${histogram(contactsLog.wallPeaks)}\nRAW ${JSON.stringify(contactsLog.incidents.map((i) => +i.peakMps.toFixed(2)))}\nWALLRAW ${JSON.stringify(contactsLog.wallPeaks.map((p) => +p.toFixed(2)))}`);
console.log(`\nstuck events ${stuck}; cars short of ${laps} laps: ${unfinished}; overtakes ${overtakes} (swapped back within 60 s ${swapsBack})`);
// AI overtaking round 3: the defenders' choices into braking zones, and how often each lost the place there.
{
  const sum = (k: 'defCovers' | 'defCoverLost' | 'defHolds' | 'defHoldLost') => drivers.reduce((x, d) => x + d.state[k], 0);
  console.log(`defence: covered ${sum('defCovers')} (lost the place ${sum('defCoverLost')}), held the line ${sum('defHolds')} (lost the place ${sum('defHoldLost')})`);
}
if (catchesOn) {
  for (const o of openCatch.values()) { o.outcome = 'race ended'; o.tookSec = tick / 60 - o.atSec; o.tookLaps = o.tookSec / soloBest[o.a]!; }
  for (const c of catches) console.log(`catch: car ${c.a} (${c.paceGap.toFixed(2)} s/lap quicker solo) on car ${c.b}, lap ${(c.atLap + 1).toFixed(1)}: ${c.outcome} after ${c.tookLaps!.toFixed(1)} laps`);
  const passed = catches.filter((c) => c.outcome === 'passed'), within3 = passed.filter((c) => c.tookLaps! <= 3);
  console.log(`CATCHES ${catches.length}: passed ${passed.length} (within 3 laps ${within3.length}), lost touch ${catches.filter((c) => c.outcome === 'lost touch').length}, pit ${catches.filter((c) => c.outcome === 'pit').length}, race ended ${catches.filter((c) => c.outcome === 'race ended').length}, traffic ${catches.filter((c) => c.outcome === 'traffic').length}; median laps to pass ${passed.length ? [...passed].sort((x, y) => x.tookLaps! - y.tookLaps!)[Math.floor(passed.length / 2)]!.tookLaps!.toFixed(1) : '-'}`);
}
if (race && lineup.length) {
  // How well the finishing order follows PACE (Spearman rank correlation, 1 = exactly).
  const fin = world.race!.order, n = fin.length;
  const byPace = [...fin].sort((a, b) => lineup[b]!.pace - lineup[a]!.pace);
  const d2 = fin.reduce((acc, car, k) => acc + (k - byPace.indexOf(car)) ** 2, 0);
  console.log(`finishing order vs driver PACE: Spearman ${(1 - (6 * d2) / (n * (n * n - 1))).toFixed(2)}${equal ? ' (Equal mode: identical cars)' : ''}`);
  // Best laps vs PACE (the driver's speed, without the grid and traffic deciding).
  const timed = rows.filter((r) => r.best !== undefined);
  const byLap = [...timed].sort((a, b) => a.best! - b.best!).map((r) => r.i), byP = [...byLap].sort((a, b) => lineup[b]!.pace - lineup[a]!.pace), m = byLap.length;
  const e2 = byLap.reduce((acc, car, k) => acc + (k - byP.indexOf(car)) ** 2, 0);
  console.log(`best lap vs driver PACE: Spearman ${(1 - (6 * e2) / (m * (m * m - 1))).toFixed(2)}`);
}
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
