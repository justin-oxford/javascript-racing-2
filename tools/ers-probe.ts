// Engine modes + battery deploy probe (POLISH card), live config, default track.
// Usage: npm run ers-probe [-- --laps 18]
//  1. STRATEGY: two identical AI cars, an 18-lap race (the length where PUSH needs a stop on 110 kg and SAVE
//     doesn't, on the current tuning): one held in SAVE, one in PUSH. Stops, race time, pace.
//  2. AI USE: 10 AI, a 10-lap race: time in each engine mode and battery deployed per lap, per car.
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, createRaceWorld, raceResults, step, type AiConfig, type CarBuild, type EngineMode, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const laps = Number(opt('laps', '18'));
const loaded = loadTrackNode(defaultTrackIdNode());
const ctx = simContextNode(loaded);
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const preset = { ...cfg.presets[cfg.defaultPreset]!, mistakesPerMin: 0 };
const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`;
console.log(`modes: ${Object.entries(ctx.ers.modes).map(([m, v]) => `${m} power x${v.power} fuel x${v.fuel}`).join(', ')}; start fuel ${ctx.physics.fuel.startKg} kg`);

// 1. Strategy.
{
  const build: CarBuild = ctx.physics.defaultCar;
  const forced: EngineMode[] = ['save', 'push'];
  let w: WorldState = createRaceWorld(ctx, [build, build], { laps, seed: 4 });
  const ai = [0, 1].map((i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => preset, () => cfg, 300 + i));
  const fuelAt: number[][] = [[], []];
  for (let t = 0; t < 60 * 60 * 15 && w.race!.phase !== 'results'; t++) {
    const before = w.cars.map((c) => c.timing.laps);
    w = step(w, ai.map((d, i) => ({ ...d.read(w.tick), engineMode: forced[i], deploy: false })), ctx);
    w.cars.forEach((c, i) => { if (c.timing.laps > before[i]!) fuelAt[i]!.push(c.fuelKg); });
  }
  console.log(`\nSTRATEGY: ${laps} laps, two identical cars (no deploy)`);
  for (const r of raceResults(w.race!)) {
    const f = fuelAt[r.car]!, burns = f.slice(1).map((v, k) => f[k]! - v).filter((d) => d > 0).sort((a, b) => a - b), perLap = burns[Math.floor(burns.length / 2)] ?? 0;
    console.log(`  P${r.pos} car ${r.car} ${forced[r.car]!.toUpperCase().padEnd(5)} time ${r.finished ? fmt(r.time) : 'DNF'}  best ${fmt(r.bestLap)}  stops ${r.pitStops}  fuel at the flag ${w.cars[r.car]!.fuelKg.toFixed(1)} kg  ~${perLap.toFixed(2)} kg/lap`);
  }
}

// 2. AI use.
{
  const builds: CarBuild[] = Array.from({ length: 10 }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id }));
  let w: WorldState = createRaceWorld(ctx, builds, { laps: 10, seed: 1 });
  const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => cfg.presets[cfg.defaultPreset]!, () => cfg, 1000 + i));
  const deployed = builds.map(() => 0);
  for (let t = 0; t < 60 * 60 * 10 && w.race!.phase !== 'results'; t++) {
    const before = w.cars.map((c) => c.ers.batteryKJ);
    w = step(w, ai.map((d) => d.read(w.tick)), ctx);
    w.cars.forEach((c, i) => { if (c.ers.deploying) deployed[i]! += Math.max(0, before[i]! - c.ers.batteryKJ); });
  }
  console.log('\nAI USE: 10 AI, 10-lap race');
  console.log('car team          save%  std%  push%  deploy s  deployed kJ/lap  stops');
  ai.forEach((d, i) => {
    const m = d.state.modeTicks, tot = m.save + m.standard + m.push || 1;
    const team = catalog.teams.find((t) => t.id === w.cars[i]!.build.team)!.name;
    console.log(`${String(i).padStart(3)} ${team.padEnd(13)} ${((100 * m.save) / tot).toFixed(1).padStart(5)} ${((100 * m.standard) / tot).toFixed(1).padStart(5)} ${((100 * m.push) / tot).toFixed(1).padStart(5)}  ${(d.state.deployTicks / 60).toFixed(1).padStart(8)}  ${(deployed[i]! / 10).toFixed(0).padStart(15)}  ${d.state.pitStops}`);
  });
}
