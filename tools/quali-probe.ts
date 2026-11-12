// Qualifying probe (race weekend card): 10 AI cars through a whole session, live config, default track.
// Usage: npm run quali-probe [-- --sec 120 --seed 1 --fuel 30]   (--fuel: try another qualiFuelKg)
// Reports: when each car left the pit lane, timed laps, best lap, stuck events, car contact while in the
// pit lane, the flag -> results timing, and the grid it produces.
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, createQualiWorld, pitQueuePoses, qualiResults, step, type AiConfig, type CarBuild, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const loaded = loadTrackNode(defaultTrackIdNode());
const base = simContextNode(loaded);
const ctx = { ...base, race: { ...base.race, qualiSec: Number(opt('sec', String(base.race.qualiSec))), qualiFuelKg: Number(opt('fuel', String(base.race.qualiFuelKg))) } };
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const ppm = loaded.track.json.pxPerMeter;
const builds: CarBuild[] = Array.from({ length: 10 }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id }));
const poses = pitQueuePoses(line, builds.length, ppm);
if (!poses) throw new Error('no pit path');
let w: WorldState = createQualiWorld(ctx, builds, Number(opt('seed', '1')), poses);
const w0Fuel = w.cars[0]!.fuelKg;
const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => cfg.presets[cfg.defaultPreset]!, () => cfg, 1000 + i));
const leftPits = builds.map(() => -1);
let pitContact = 0, flagAt = -1, dry = 0;
const stops = builds.map(() => 0), wasServicing = builds.map(() => false), burned = builds.map(() => 0);
const prevFuel = w.cars.map((c) => c.fuelKg);
for (let t = 0; t < 60 * (ctx.race.qualiSec + 120) && w.quali!.phase !== 'results'; t++) {
  w = step(w, ai.map((d) => d.read(w.tick)), ctx);
  w.cars.forEach((c, i) => {
    if (leftPits[i]! < 0 && !c.inPitLane && w.tick > 5) leftPits[i] = w.tick / 60;
    if (c.inPitLane && c.carContact) pitContact++;
    if (c.servicing && !wasServicing[i]) stops[i]!++;
    wasServicing[i] = c.servicing;
    burned[i]! += Math.max(0, prevFuel[i]! - c.fuelKg);
    prevFuel[i] = c.fuelKg;
    if (c.fuelKg <= 0) dry++;
  });
  if (flagAt < 0 && w.quali!.phase === 'flag') flagAt = w.tick / 60;
}
const q = w.quali!;
console.log(`session ${ctx.race.qualiSec} s: flag at ${flagAt.toFixed(1)} s, results at ${(w.tick / 60).toFixed(1)} s (${q.phase}); pit-lane contact ticks ${pitContact}; start fuel ${w0Fuel.toFixed(1)} kg; car-ticks out of fuel ${dry}`);
console.log('pos car team         left pits  laps  best      gap   stuck  stops  kg/lap');
for (const r of qualiResults(q)) {
  const team = catalog.teams.find((t) => t.id === w.cars[r.car]!.build.team)!.name;
  console.log(`${String(r.pos).padStart(3)} ${String(r.car).padStart(3)} ${team.padEnd(12)} ${leftPits[r.car]! < 0 ? '  never' : `${leftPits[r.car]!.toFixed(1).padStart(6)} s`}  ${String(r.laps).padStart(4)}  ${r.bestLap ? r.bestLap.toFixed(3) : '  ---  '}  ${r.gap ? `+${r.gap.toFixed(3)}` : '      '}  ${ai[r.car]!.state.stuckEvents}      ${stops[r.car]}   ${(burned[r.car]! / Math.max(1, w.cars[r.car]!.timing.laps)).toFixed(1)}`);
}
