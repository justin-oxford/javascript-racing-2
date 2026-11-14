// Race noise probe (POLISH: Race noise card), live config, default track, Equal mode (the drivers decide).
// 10 AI with the roster, N laps, several seeds. Reports:
//  - mistakes per driver by kind, and the time each costs (that lap vs the driver's median lap)
//  - strict passes (two cars within 30 m on the line swapping order, as ai-run), RE-PASSES (the same pair
//    swapping back at least 10 s later), passes within 4 s of the passed car's mistake
//  - tyre wear per lap: laps spent mostly within 1 s of the car ahead vs laps in clean air
//  - contacts, contacts per pass, stuck events, and whether two runs of the same seed match
// Usage: npm run noise-probe [-- --laps 20 --seeds 3]
import aiJson from '../config/ai.json' with { type: 'json' };
import driversJson from '../config/drivers.json' with { type: 'json' };
import { aiInputSource, assignDrivers, buildRacingLine, createRaceWorld, driverPreset, step, type AiConfig, type CarBuild, type DriverDef, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';
import { contactLog } from './contact-split.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: number) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };
const laps = opt('laps', 20), seeds = opt('seeds', 3), first = opt('seed', 1);
const loaded = loadTrackNode(defaultTrackIdNode());
const ctx = simContextNode(loaded);
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const roster = (driversJson as { drivers: DriverDef[] }).drivers;

function race(seed: number) {
  const builds: CarBuild[] = Array.from({ length: 10 }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id, equalise: ctx.race.equalise }));
  let w: WorldState = createRaceWorld(ctx, builds, { laps, seed });
  const lineup = assignDrivers(roster, 10, seed);
  const presets = builds.map((_, i) => driverPreset(cfg.presets[cfg.defaultPreset]!, lineup[i], cfg.skill?.spread ?? 0));
  const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => presets[i]!, () => cfg, seed * 1000 + i));
  const n = builds.length;
  const mistakes: Array<Array<{ kind: string; tick: number; lap: number }>> = builds.map(() => []);
  const lapTimes: number[][] = builds.map(() => []);
  const order = new Map<number, number>();
  const passes: Array<{ tick: number; passer: number; passed: number }> = [];
  let contacts = 0, contactsAfterMistake = 0;
  const log = contactLog(ctx);
  const stuckSeen: number[] = [];
  // Wear per lap with the share of it spent within 1 s behind another car.
  const lapWear: Array<Array<{ wear: number; close: number; serviced: boolean }>> = builds.map(() => []);
  const lapStart = builds.map(() => ({ wear: 4, closeTicks: 0, ticks: 0, serviced: false }));
  const prog = (i: number) => w.race!.cars[i]!.progress;
  for (let t = 0; t < 60 * 60 * 40 && w.race!.phase !== 'results'; t++) {
    const prev = w;
    const prevActive = ai.map((d) => !!d.state.mistake?.active);
    w = step(w, ai.map((d) => d.read(w.tick)), ctx);
    log.tick(w);
    if (w.race!.phase !== 'racing') continue;
    // Counted when the mistake actually happens (armed ones wait for a braking zone / corner / slow exit).
    ai.forEach((d, i) => { if (d.state.mistake?.active && !prevActive[i]) mistakes[i]!.push({ kind: d.state.mistake.kind, tick: w.tick, lap: w.cars[i]!.timing.laps }); });
    if (process.env.STUCK) ai.forEach((d, i) => { if (d.state.stuckEvents > (stuckSeen[i] ?? 0)) { stuckSeen[i] = d.state.stuckEvents; console.log(`  stuck t=${(w.tick / 60).toFixed(1)} car ${i} ${d.state.mode} near ${d.state.near} last mistake ${mistakes[i]!.at(-1)?.kind ?? '-'} ${mistakes[i]!.length ? ((w.tick - mistakes[i]!.at(-1)!.tick) / 60).toFixed(1) + ' s ago' : ''} contact ${w.cars[i]!.carContact} wall ${w.cars[i]!.wallContact}`); } });
    w.cars.forEach((c, i) => {
      if (c.carContact && !prev.cars[i]!.carContact) {
        contacts++;
        // ...and whether it came within 3 s of a mistake by this car or the nearest other one.
        let near = -1, bd = Infinity;
        w.cars.forEach((o, j) => { if (j !== i) { const dd = Math.hypot(o.x - c.x, o.y - c.y); if (dd < bd) { bd = dd; near = j; } } });
        const recent = (k: number) => mistakes[k]!.some((m) => w.tick - m.tick >= 0 && w.tick - m.tick < 180);
        if (recent(i) || (near >= 0 && recent(near))) contactsAfterMistake++;
        if (process.env.HITS) console.log(`  hit t=${(w.tick / 60).toFixed(1)} car ${i} by ${near} near ${ai[i]!.state.near} ${ai[i]!.state.mode} lane ${c.inPitLane} other ${near >= 0 ? ai[near]!.state.mode + '@' + ai[near]!.state.near + ' lane ' + w.cars[near]!.inPitLane + ' v ' + Math.hypot(w.cars[near]!.vx, w.cars[near]!.vy).toFixed(1) : ''} mistake ${recent(i) ? ai[i]!.state.lastMistake : near >= 0 && recent(near) ? 'other:' + ai[near]!.state.lastMistake : '-'} v ${Math.hypot(c.vx, c.vy).toFixed(1)}`);
      }
      const ls = lapStart[i]!;
      ls.ticks++;
      if (c.servicing) ls.serviced = true;
      const v = Math.max(5, Math.hypot(c.vx, c.vy));
      if (w.cars.some((o, j) => j !== i && (prog(j) - prog(i)) * line.length > 0 && (prog(j) - prog(i)) * line.length < v * 1)) ls.closeTicks++;
    });
    for (const e of w.events) if (e.type === 'lap') {
      const i = e.car, c = w.cars[i]!, ls = lapStart[i]!;
      lapTimes[i]!.push(e.time);
      const wear = c.wheels.reduce((a, x) => a + x.wear, 0);
      lapWear[i]!.push({ wear: (ls.wear - wear) / 4, close: ls.closeTicks / Math.max(1, ls.ticks), serviced: ls.serviced });
      lapStart[i] = { wear, closeTicks: 0, ticks: 0, serviced: false };
    }
    // Strict passes: a pair within 30 m on the line swapping order (lapped cars count by race progress).
    if (w.tick % 6 === 0) for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      const d = (prog(a) - prog(b)) * line.length, key = a * 100 + b;
      if (Math.abs(d) > 30 || w.cars[a]!.inPitLane || w.cars[b]!.inPitLane) { order.delete(key); continue; } // on track only
      const s = Math.sign(d), was = order.get(key);
      if (was !== undefined && was !== s && s !== 0) passes.push({ tick: w.tick, passer: s > 0 ? a : b, passed: s > 0 ? b : a });
      if (s !== 0) order.set(key, s);
    }
  }
  // Re-passes: the same pair, the other way round, at least 10 s later.
  let repasses = 0;
  passes.forEach((p, k) => { if (passes.slice(k + 1).some((q) => q.passer === p.passed && q.passed === p.passer && q.tick - p.tick > 600)) repasses++; });
  const afterMistake = passes.filter((p) => mistakes[p.passed]!.some((m) => p.tick - m.tick >= 0 && p.tick - m.tick < 240)).length;
  log.finish();
  return { w, ai, lineup, mistakes, lapTimes, passes, repasses, afterMistake, contacts, taps: log.taps, heavy: log.heavy, contactsAfterMistake, lapWear, stuck: ai.reduce((a, d) => a + d.state.stuckEvents, 0), order: w.race!.order.join(',') };
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
const byKind: Record<string, { n: number; cost: number[] }> = {};
let tot = { passes: 0, repasses: 0, afterMistake: 0, contacts: 0, taps: 0, heavy: 0, stuck: 0 };
const wearClose: number[] = [], wearClean: number[] = [], closeCare: Array<{ tyres: number; wear: number }> = [];
const consMistakes: Array<{ cons: number; n: number }> = [];
for (let seed = first; seed < first + seeds; seed++) {
  const r = race(seed);
  tot = { passes: tot.passes + r.passes.length, repasses: tot.repasses + r.repasses, afterMistake: tot.afterMistake + r.afterMistake, contacts: tot.contacts + r.contacts, taps: tot.taps + r.taps, heavy: tot.heavy + r.heavy, stuck: tot.stuck + r.stuck };
  r.mistakes.forEach((ms, i) => {
    consMistakes.push({ cons: r.lineup[i]?.consistency ?? 50, n: ms.length });
    const med = median(r.lapTimes[i]!);
    for (const m of ms) {
      const lt = r.lapTimes[i]![m.lap]; // the lap the mistake happened on (laps completed before it = its index)
      (byKind[m.kind] ??= { n: 0, cost: [] }).n++;
      if (lt !== undefined && m.lap > 0) byKind[m.kind]!.cost.push(lt - med);
    }
  });
  r.lapWear.forEach((ls, i) => ls.forEach((l, k) => { if (k === 0 || l.serviced) return; (l.close > 0.5 ? wearClose : wearClean).push(l.wear); if (l.close > 0.5) closeCare.push({ tyres: r.lineup[i]?.tyres ?? 50, wear: l.wear }); }));
  const again = race(seed);
  console.log(`seed ${seed}: passes ${r.passes.length}, re-passes ${r.repasses}, after a mistake ${r.afterMistake}, mistakes ${r.mistakes.reduce((a, m) => a + m.length, 0)}, contact starts ${r.contacts} (${r.contactsAfterMistake} within 3 s of a mistake), incidents: taps ${r.taps}, heavy hits ${r.heavy}, stuck ${r.stuck}; deterministic ${again.order === r.order && again.w.tick === r.w.tick ? 'yes' : 'NO'}`);
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`\n${seeds} races, ${laps} laps, Equal mode: strict passes ${tot.passes}, re-passes ${tot.repasses}, passes after the passed car's mistake ${tot.afterMistake}, taps ${tot.taps}, heavy hits ${tot.heavy} (>= ${ctx.damage.thresholdMps} m/s, ${(tot.heavy / Math.max(1, tot.passes)).toFixed(2)} per pass), contact starts ${tot.contacts} (${(tot.contacts / Math.max(1, tot.passes)).toFixed(2)} per pass), stuck ${tot.stuck}`);
for (const [k, v] of Object.entries(byKind)) console.log(`  mistake ${k.padEnd(10)}: ${v.n}, lap time lost: median ${median(v.cost).toFixed(2)} s, mean ${mean(v.cost).toFixed(2)} s`);
const lo = consMistakes.filter((c) => c.cons < 60), hi = consMistakes.filter((c) => c.cons >= 75);
console.log(`  mistakes per race: CONSISTENCY < 60 ${mean(lo.map((c) => c.n)).toFixed(2)}, >= 75 ${mean(hi.map((c) => c.n)).toFixed(2)}`);
console.log(`  tyre wear per lap (life used): mostly within 1 s of the car ahead ${(mean(wearClose) * 100).toFixed(2)}% (${wearClose.length} laps), clean air ${(mean(wearClean) * 100).toFixed(2)}% (${wearClean.length} laps)`);
const careLo = closeCare.filter((c) => c.tyres < 50).map((c) => c.wear), careHi = closeCare.filter((c) => c.tyres >= 65).map((c) => c.wear);
console.log(`  following closely, wear per lap by TYRE MANAGEMENT: < 50 ${(mean(careLo) * 100).toFixed(2)}% (${careLo.length} laps), >= 65 ${(mean(careHi) * 100).toFixed(2)}% (${careHi.length} laps)`);
