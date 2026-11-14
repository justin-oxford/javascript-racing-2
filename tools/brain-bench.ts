// AI look-ahead brain card: the cost of each brain. A Team-stats race with N AI cars on the default track, timed
// over the racing phase (lap 2 on, when the look-ahead planner is active): ms per tick (sim + every AI) and x real time.
// Usage: npx tsx tools/brain-bench.ts [--cars 10] [--sec 120] [--seed 1]
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, createRaceWorld, step, type AiConfig, type CarBuild, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1]! : def; };
const cars = Number(opt('cars', '10')), sec = Number(opt('sec', '120')), seed = Number(opt('seed', '1'));
const loaded = loadTrackNode(defaultTrackIdNode());
const ctx = simContextNode(loaded);
const line = buildRacingLine(loaded.track)!;
for (const brain of ['rules', 'lookahead'] as const) {
  const cfg = { ...(structuredClone(aiJson) as unknown as AiConfig), brain };
  const builds: CarBuild[] = Array.from({ length: cars }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i % catalog.teams.length]!.id }));
  let w: WorldState = createRaceWorld(ctx, builds, { laps: 50, seed });
  const drivers = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => cfg.presets[cfg.defaultPreset]!, () => cfg, seed * 1000 + i));
  // Up to the end of lap one (untimed), then sec seconds timed.
  for (let t = 0; t < 60 * 120 && !(w.race!.phase === 'racing' && Math.min(...w.race!.cars.map((c) => c.progress)) > 1.05); t++) w = step(w, drivers.map((d) => d.read(w.tick)), ctx);
  const t0 = performance.now();
  let planned = 0;
  for (let t = 0; t < 60 * sec; t++) { w = step(w, drivers.map((d) => d.read(w.tick)), ctx); planned += drivers.filter((d) => d.state.plan).length; }
  const ms = performance.now() - t0;
  console.log(`${brain.padEnd(9)} ${cars} cars: ${(ms / (60 * sec)).toFixed(3)} ms per tick, ${((sec * 1000) / ms).toFixed(1)}x real time; planning ${((100 * planned) / (60 * sec * cars)).toFixed(0)}% of car-ticks`);
}
