// Setup search (Car setup overhaul card): headless coordinate descent over the setup fields (real units,
// specs.json setup.fields), minimising a solo AI car's race-length stint on a track (live config): the mean
// of --laps laps after the first, from --fuel kg, fuel burning and tyres wearing as they go (Justin: score
// race-length stints, so low tyre pressure's extra wear shows). The result is the track's BASE SETUP
// (track.json baseSetup): what players and the AI load there.
// Usage: npm run setup-search [-- --track oxford --fuel 110 --laps 10 --from neutral --write]
//   --from neutral: start from the neutral setup instead of the track's current base.
//   --write: save the result as the track's baseSetup in tracks/<id>/track.json.
import { readFileSync, writeFileSync } from 'node:fs';
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, createWorld, neutralSetup, normalizeSetup, SETUP_FIELDS, snapSetupValue, step, type AiConfig, type CarSetup, type WorldState } from '../src/sim/index.ts';
import { defaultTrackIdNode, loadTrackNode, simContextNode, TRACKS_DIR } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const trackId = opt('track', defaultTrackIdNode());
const loaded = loadTrackNode(trackId);
const ctx = simContextNode(loaded);
const fuel = Number(opt('fuel', String(ctx.physics.fuel.startKg)));
const stint = Number(opt('laps', '10'));
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const preset = { ...cfg.presets[cfg.defaultPreset]!, mistakesPerMin: 0, noise: 0 };
const fields = ctx.catalog.specs.setup.fields;
const evolutionOff = { ...ctx, evolution: { ...ctx.evolution, enabled: false } }; // the same track every run
// No pit stops in the stint (it's about the setup, not the strategy).
const noPits = { ...cfg, pits: { ...cfg.pits!, fuelLaps: 0, minWear: 0 } };

/** Mean lap over laps 2..stint+1 (lap 1 starts from the spawn), solo, fuel burning, tyres wearing. */
function stintTime(setup: CarSetup): number {
  const c = evolutionOff;
  let w: WorldState = createWorld(c, [{ ...c.physics.defaultCar, setup }]);
  w = { ...w, cars: w.cars.map((car) => ({ ...car, fuelKg: fuel })) };
  const ai = aiInputSource(0, () => ({ world: w, ctx: c, line }), () => preset, () => noPits, 11);
  const laps: number[] = [];
  for (let t = 0; t < 60 * 60 * (stint + 2) && w.cars[0]!.timing.laps < stint + 1; t++) {
    w = step(w, [ai.read(w.tick)], c);
    for (const e of w.events) if (e.type === 'lap' && w.cars[0]!.timing.laps >= 2) laps.push(e.invalid ? e.time + 5 : e.time); // an invalid lap costs
  }
  return laps.length >= stint ? laps.reduce((a, x) => a + x, 0) / laps.length : Infinity;
}

const fmt = (s: CarSetup) => SETUP_FIELDS.map((k) => `${k} ${s[k]}`).join(', ');
const startFrom = opt('from', 'base') === 'neutral' || !loaded.track.json.baseSetup ? neutralSetup(ctx.catalog.specs.setup) : normalizeSetup(loaded.track.json.baseSetup, ctx.catalog.specs.setup);
let best = startFrom, bestT = stintTime(best);
console.log(`${trackId}, ${fuel} kg, ${stint}-lap stint: start ${bestT.toFixed(3)} s (${fmt(best)})`);
for (const mult of [4, 2, 1]) {
  let improved = true;
  for (let pass = 0; pass < 3 && improved; pass++) {
    improved = false;
    for (const k of SETUP_FIELDS) {
      for (const dir of [-1, 1]) {
        const f = fields[k], v = snapSetupValue(best[k] + dir * mult * f.step, f);
        if (v === best[k]) continue;
        const cand = { ...best, [k]: v }, t = stintTime(cand);
        if (t < bestT - 0.002) { best = cand; bestT = t; improved = true; console.log(`  ${k} ${v} ${f.unit}: ${t.toFixed(3)} s`); }
      }
    }
  }
}
console.log(`best ${bestT.toFixed(3)} s: ${fmt(best)}`);
// At the end of its range = maybe wants more (the range may be too narrow for this track).
const pinned = SETUP_FIELDS.filter((k) => best[k] === fields[k].min || best[k] === fields[k].max);
if (pinned.length) console.log(`at the end of the range: ${pinned.join(', ')}`);
if (args.includes('--write')) {
  const file = `${TRACKS_DIR}/${trackId}/track.json`;
  const text = readFileSync(file, 'utf8');
  const entry = `"baseSetup": { ${SETUP_FIELDS.map((k) => `"${k}": ${best[k]}`).join(', ')} }`;
  const next = /"baseSetup": \{[^}]*\}/.test(text) ? text.replace(/"baseSetup": \{[^}]*\}/, entry) : text.replace(/("pxPerMeter": [^,\n]*,\n)(\s*)/, `$1$2${entry},\n$2`);
  JSON.parse(next); // still valid
  writeFileSync(file, next);
  console.log(`saved as ${trackId}'s baseSetup in track.json`);
}
