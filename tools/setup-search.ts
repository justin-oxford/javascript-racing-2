// Setup search (Car setup overhaul card): headless coordinate descent over the setup notches, minimising a
// solo AI car's clean-lap time on a track (live config). The AI runs the result (config/ai-setups.json).
// Usage: npm run setup-search [-- --track oxford --fuel 110 --write]
//   --fuel: start fuel kg (try a light car vs a full one: the best notches move).
//   --write: save the result for the track into config/ai-setups.json (used by the AI in the client).
import { readFileSync, writeFileSync } from 'node:fs';
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, createWorld, NEUTRAL_SETUP, SETUP_SLOTS, step, type AiConfig, type CarSetup, type WorldState } from '../src/sim/index.ts';
import { defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const trackId = opt('track', defaultTrackIdNode());
const loaded = loadTrackNode(trackId);
const ctx = simContextNode(loaded);
const fuel = Number(opt('fuel', String(ctx.physics.fuel.startKg)));
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const preset = { ...cfg.presets[cfg.defaultPreset]!, mistakesPerMin: 0, noise: 0 };
const range = ctx.catalog.specs.setup.range;
const evolutionOff = { ...ctx, evolution: { ...ctx.evolution, enabled: false } }; // the same track every run

/** Mean clean lap over laps 2-5 (lap 1 starts from the spawn), solo: a short stint, so tyre wear counts. */
function lap(setup: CarSetup): number {
  const c = evolutionOff;
  let w: WorldState = createWorld(c, [{ ...c.physics.defaultCar, setup }]);
  w = { ...w, cars: w.cars.map((car) => ({ ...car, fuelKg: fuel })) };
  const ai = aiInputSource(0, () => ({ world: w, ctx: c, line }), () => preset, () => cfg, 11);
  const laps: number[] = [];
  for (let t = 0; t < 60 * 240 && w.cars[0]!.timing.laps < 5; t++) {
    w = step(w, [ai.read(w.tick)], c);
    for (const e of w.events) if (e.type === 'lap' && w.cars[0]!.timing.laps >= 2) laps.push(e.invalid ? e.time + 5 : e.time); // an invalid lap costs
  }
  return laps.length ? laps.reduce((a, x) => a + x, 0) / laps.length : Infinity;
}

let best: CarSetup = { ...NEUTRAL_SETUP }, bestT = lap(best);
console.log(`${trackId}, ${fuel} kg: neutral ${bestT.toFixed(3)} s`);
for (const stepSize of [2, 1]) {
  let improved = true;
  for (let pass = 0; pass < 3 && improved; pass++) {
    improved = false;
    for (const slot of SETUP_SLOTS) {
      for (const dir of [-1, 1]) {
        const v = best[slot] + dir * stepSize;
        if (v < -range || v > range) continue;
        const cand = { ...best, [slot]: v }, t = lap(cand);
        if (t < bestT - 0.002) { best = cand; bestT = t; improved = true; console.log(`  ${slot} ${v > 0 ? '+' : ''}${v}: ${t.toFixed(3)} s`); }
      }
    }
  }
}
console.log(`best ${bestT.toFixed(3)} s: ${SETUP_SLOTS.map((s) => `${s} ${best[s] > 0 ? '+' : ''}${best[s]}`).join(', ')}`);
if (args.includes('--write')) {
  const file = new URL('../config/ai-setups.json', import.meta.url);
  let all: Record<string, unknown> = {};
  try { all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { /* first one */ }
  all._comment ??= 'AI car setups per track (Car setup overhaul card), found by npm run setup-search -- --write. Notches -range..+range (specs.json setup).';
  all[trackId] = best;
  writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
  console.log(`saved to config/ai-setups.json for ${trackId}`);
}
