// Race strategy probe (Race strategy card), live config, default track.
//  1. FUEL WEIGHT: one AI alone, a full tank vs nearly empty (topped up every tick so the load stays put):
//     best lap each. Target (Justin): about 0.5 s a lap. --k <x> tries another tyres.loadSensitivity.
//  2. STINTS: one AI alone on each compound, laps until the tyres are past the AI's pit threshold: lap time
//     and lowest wheel wear per lap (soft quicker first and off the cliff first; hard the reverse). Gives the
//     lifeLaps to put in config/strategy.json.
//  3. RACE: 10 AI, --laps (default 20), seeded start compounds and the AI's own stops: compounds each car used.
// Usage: npm run strategy-probe [-- --k 0.6 --laps 20 --seed 1 --matched --skip-stints --stops]
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, aiStartCompound, buildRacingLine, COMPOUNDS, consumableScale, createRaceWorld, createWorld, step, wearGrip, type AiConfig, type CarBuild, type Compound, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const loaded = loadTrackNode(defaultTrackIdNode());
const ctx = simContextNode(loaded);
if (args.includes('--k')) ctx.physics.tyres.loadSensitivity = Number(opt('k', '0'));
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const clean = { ...cfg.presets[cfg.defaultPreset]!, mistakesPerMin: 0, noise: 0 };
const minWear = cfg.pits?.minWear ?? 0.45;

/** Laps of one AI alone. fixFuel: hold the fuel at this (no burn effect on the load). */
function solo(build: CarBuild, maxLaps: number, fixFuel?: number, stopWhen?: (w: WorldState) => boolean) {
  let w: WorldState = createWorld(ctx, [build]);
  if (fixFuel !== undefined) w = { ...w, cars: [{ ...w.cars[0]!, fuelKg: fixFuel }] };
  const noPit = { ...cfg, pits: { ...cfg.pits!, minWear: 0, fuelLaps: 0 } };
  const ai = aiInputSource(0, () => ({ world: w, ctx, line }), () => clean, () => noPit, 7);
  const laps: { time: number; wear: number; grip: number }[] = [];
  for (let t = 0; t < 60 * 60 * 20 && laps.length < maxLaps; t++) {
    w = step(w, [ai.read(w.tick)], ctx);
    if (fixFuel !== undefined) w = { ...w, cars: [{ ...w.cars[0]!, fuelKg: fixFuel }] };
    for (const e of w.events) if (e.type === 'lap') {
      const min = Math.min(...w.cars[0]!.wheels.map((x) => x.wear));
      laps.push({ time: e.time, wear: min, grip: wearGrip(min) });
      if (stopWhen?.(w)) return laps;
    }
  }
  return laps;
}

// 1. Fuel weight.
{
  const tank = ctx.physics.fuel.tankKg;
  const best = (fuel: number) => Math.min(...solo({ ...ctx.physics.defaultCar, equalise: 1 }, 4, fuel).slice(1).map((l) => l.time));
  const full = best(tank), empty = best(3);
  console.log(`FUEL WEIGHT (tyres.loadSensitivity ${ctx.physics.tyres.loadSensitivity ?? 0}): best lap full ${full.toFixed(3)} s, empty ${empty.toFixed(3)} s -> ${(full - empty).toFixed(3)} s a lap (target ~0.5)`);
}

// 2. Stints.
if (!args.includes('--skip-stints')) {
  console.log(`\nSTINTS (one AI alone, half a tank held, until the lowest wheel is under the AI's pit threshold ${minWear}):`);
  for (const c of COMPOUNDS) {
    const laps = solo({ ...ctx.physics.defaultCar, equalise: 1, compound: c }, 40, ctx.physics.fuel.tankKg / 2, (w) => Math.min(...w.cars[0]!.wheels.map((x) => x.wear)) < minWear - 0.1);
    const life = laps.findIndex((l) => l.wear < minWear);
    console.log(`  ${c.padEnd(6)} life to the pit threshold ${life < 0 ? `>${laps.length}` : life} laps; laps: ${laps.map((l) => `${l.time.toFixed(2)}(${Math.round(l.wear * 100)}%)`).join(' ')}`);
  }
}

// 3. Race.
{
  const laps = Number(opt('laps', '20')), seed = Number(opt('seed', '1'));
  const settings = args.includes('--matched') ? { raceLength: 'matched' as const } : {};
  const scale = consumableScale(settings.raceLength, laps, ctx.strategy);
  let r = seed * 9301 + 49297;
  const rand = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  const builds: CarBuild[] = Array.from({ length: 10 }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id, compound: aiStartCompound(laps, scale, ctx.strategy, rand()) }));
  let w: WorldState = createRaceWorld(ctx, builds, { laps, seed, settings });
  const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => cfg.presets[cfg.defaultPreset]!, () => cfg, seed * 100 + i));
  const used: Compound[][] = builds.map((b) => [b.compound!]);
  for (let t = 0; t < 60 * 60 * 40 && w.race!.phase !== 'results'; t++) {
    const prev = w;
    w = step(w, ai.map((d) => d.read(w.tick)), ctx);
    w.cars.forEach((c, i) => { if (c.compound !== used[i]!.at(-1)) used[i]!.push(c.compound); });
    // --stops: each stop as it starts (why: fuel and the most worn tyre) and what it got.
    if (args.includes('--stops')) w.cars.forEach((c, i) => {
      const p = prev.cars[i]!;
      if (c.servicing && !p.servicing) console.log(`  car ${i} stops at ${w.race!.cars[i]!.progress.toFixed(2)} laps: fuel ${c.fuelKg.toFixed(1)} kg, worst tyre ${Math.round(Math.min(...c.wheels.map((x) => x.wear)) * 100)}% ${c.compound}, board ${c.pitPlan.compound}${c.pitPlan.tyres ? '' : ' (no tyres)'}`);
      if (!c.servicing && p.servicing && p.stop) console.log(`  car ${i} leaves: fuel ${c.fuelKg.toFixed(1)} kg (target ${p.stop.fuelToKg.toFixed(1)})`);
    });
  }
  const multi = used.filter((u) => new Set(u).size > 1).length;
  console.log(`\nRACE ${laps} laps, 10 AI${settings.raceLength ? ', race length matched (x' + scale.toFixed(2) + ')' : ''}: finished ${w.race!.phase === 'results'}; stops ${ai.map((d) => d.state.pitStops).join(' ')}`);
  console.log(`  compounds per car: ${used.map((u, i) => `${i}:${u.map((c) => ctx.strategy.compounds[c].letter).join('>')}`).join('  ')}`);
  console.log(`  cars that used more than one compound: ${multi}/10`);
}
