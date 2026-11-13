// AI racecraft probe (POLISH card), live config, default track.
//  1. LINES: per EXIT corner, the speed profile's speed at the end of the following straight and the
//     minimum corner speed, EXIT vs NEUTRAL (EXIT should be faster onto the straight, slower in the corner).
//     How many corners get an INSIDE line.
//  2. RACE: 10 AI, N laps, racecraft on vs off (same seed): overtakes, car contacts, invalid laps, stuck,
//     time in each mode, line changes, determinism.
// Usage: npm run racecraft-probe [-- --laps 20 --seed 1 --equal]   (--equal: identical cars, the drivers decide)
import aiJson from '../config/ai.json' with { type: 'json' };
import driversJson from '../config/drivers.json' with { type: 'json' };
import { aiInputSource, assignDrivers, driverPreset, type DriverDef, buildRacingLine, buildStats, cornersOf, createRaceWorld, keepGoodExits, lineOffsets, offsetPath, offsetsFromPoints, speedProfile, step, type AiConfig, type CarBuild, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const laps = Number(opt('laps', '20')), seed = Number(opt('seed', '1'));
const loaded = loadTrackNode(defaultTrackIdNode());
const ctx = simContextNode(loaded);
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const rc = cfg.racecraft!;

// 1. Lines.
{
  // The track's stored EXIT line (npm run optimize-exit-line) when it has one, else the generated one.
  const gen = lineOffsets(line, rc, ctx.physics.car.widthM / 2), stored = loaded.track.json.racingLineExit, ppm = loaded.track.json.pxPerMeter;
  const raw = stored?.length ? { ...gen, exit: offsetsFromPoints(line, stored.map((p) => ({ x: p.x / ppm, y: p.y / ppm }))).map((v) => (Math.abs(v) < 0.05 ? 0 : v)) } : gen;
  console.log(`EXIT line: ${stored?.length ? 'track.json racingLineExit' : 'generated from curvature'}`);
  const corners = cornersOf(line);
  const stats = buildStats(ctx.physics.defaultCar, ctx.catalog);
  const prof = (x: Float64Array, y: Float64Array) => speedProfile(x, y, ctx.physics, stats, { cornerMargin: 1, brakeMargin: 1, fuelKg: ctx.physics.fuel.startKg / 2 });
  const neutral = prof(line.x, line.y), exRaw = offsetPath(line, raw.exit), exitRaw = prof(exRaw.x, exRaw.y);
  const off = keepGoodExits(line, raw, neutral, exitRaw, rc); // what the AI keeps
  const ex = offsetPath(line, raw.exit), exitP = exitRaw;
  void ex;
  console.log(`${loaded.track.json.id}: ${corners.length} corners; INSIDE line on ${corners.length}; EXIT candidates (before >= ${rc.exitStraightM} m of straight) and whether each is kept:`);
  corners.forEach((c, k) => {
    if (!Array.from({ length: ((c.to - c.from + line.n) % line.n) + 1 }, (_, j) => raw.exit[(c.from + j) % line.n]!).some((v) => v !== 0)) return;
    const kept = Array.from({ length: ((c.to - c.from + line.n) % line.n) + 1 }, (_, j) => off.exit[(c.from + j) % line.n]!).some((v) => v !== 0);
    const next = corners[(k + 1) % corners.length]!;
    let minN = Infinity, minE = Infinity;
    for (let j = c.from; j !== (c.to + 1) % line.n; j = (j + 1) % line.n) { minN = Math.min(minN, neutral[j]!); minE = Math.min(minE, exitP[j]!); }
    const into = (c.to + 15) % line.n;
    console.log(`  T${k + 1} -> straight of ${(((next.from - c.to + line.n) % line.n) * 2).toFixed(0)} m: 30 m in, NEUTRAL ${(neutral[into]! * 3.6).toFixed(1)} kph, EXIT ${(exitP[into]! * 3.6).toFixed(1)} kph (${((exitP[into]! - neutral[into]!) * 3.6).toFixed(1)}); min corner speed ${(minN * 3.6).toFixed(1)} vs ${(minE * 3.6).toFixed(1)} kph -> ${kept ? 'KEPT' : 'dropped'}`);
  });
}

// 2. Race, racecraft on vs off.
function race(on: boolean) {
  const c: AiConfig = { ...cfg, racecraft: { ...rc, enabled: on } };
  const equal = args.includes('--equal');
  const builds: CarBuild[] = Array.from({ length: 10 }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id, ...(equal ? { equalise: ctx.race.equalise } : {}) }));
  let w: WorldState = createRaceWorld(ctx, builds, { laps, seed });
  const lineup = assignDrivers((driversJson as { drivers: DriverDef[] }).drivers, 10, seed);
  const presets = builds.map((_, i) => driverPreset(cfg.presets[cfg.defaultPreset]!, lineup[i], cfg.skill?.spread ?? 0));
  const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => presets[i]!, () => c, seed * 1000 + i));
  let contacts = 0, invalid = 0, swaps = 0;
  let order = w.race!.order.join(',');
  for (let t = 0; t < 60 * 60 * 30 && w.race!.phase !== 'results'; t++) {
    const prev = w;
    w = step(w, ai.map((d) => d.read(w.tick)), ctx);
    w.cars.forEach((car, i) => { if (car.carContact && !prev.cars[i]!.carContact) contacts++; });
    for (const e of w.events) if (e.type === 'lap' && e.invalid) invalid++;
    if (w.race!.phase === 'racing') { const o = w.race!.order.join(','); if (o !== order) { const a = order.split(','), b = o.split(','); for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) { swaps++; break; } order = o; } }
  }
  const modes = ai.reduce((a, d) => ({ manage: a.manage + d.state.craftTicks.manage, attack: a.attack + d.state.craftTicks.attack, defend: a.defend + d.state.craftTicks.defend, nurse: a.nurse + d.state.craftTicks.nurse }), { manage: 0, attack: 0, defend: 0, nurse: 0 });
  const tot = modes.manage + modes.attack + modes.defend + modes.nurse || 1;
  const leader = w.race!.order[0]!;
  const lm = ai[leader]!.state.craftTicks, lt = lm.manage + lm.attack + lm.defend + lm.nurse || 1;
  return { w, contacts, invalid, swaps, stuck: ai.reduce((a, d) => a + d.state.stuckEvents, 0), modes, tot, lineChanges: ai.reduce((a, d) => a + d.state.lineChanges, 0), leaderManage: lm.manage / lt };
}
for (const on of [false, true]) {
  const r = race(on);
  const pct = (x: number) => `${((100 * x) / r.tot).toFixed(0)}%`;
  console.log(`\nRACE ${laps} laps, 10 AI, racecraft ${on ? 'ON ' : 'OFF'}: position changes ${r.swaps}, car contacts ${r.contacts}, invalid laps ${r.invalid}, stuck ${r.stuck}`);
  if (on) console.log(`  time in mode: manage ${pct(r.modes.manage)}, attack ${pct(r.modes.attack)}, defend ${pct(r.modes.defend)}, nurse ${pct(r.modes.nurse)}; line changes ${r.lineChanges}; the winner spent ${(r.leaderManage * 100).toFixed(0)}% in MANAGE`);
}
const a = race(true).w, b = race(true).w;
console.log(`\ndeterminism (racecraft on, two runs): ${JSON.stringify(a.race!.order) === JSON.stringify(b.race!.order) && a.tick === b.tick ? 'identical' : 'DIFFERENT'}`);
