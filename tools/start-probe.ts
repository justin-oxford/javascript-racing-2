// Race-start probe: 10 AI cars, several seeds, lap one only. Live config, default track.
// Usage: npm run start-probe [-- --seeds 5]
// Reports per seed: how long the field takes to get the whole pack past turn 1 (all cars 300 m round),
// car-seconds spent nearly stopped (< 15 kph after the first 3 s), car-to-car contact ticks, off-tracks.
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, createRaceWorld, step, type AiConfig, type CarBuild, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const seeds = Number(args[args.indexOf('--seeds') + 1] ?? 3) || 3;
const loaded = loadTrackNode(defaultTrackIdNode());
const ctx = simContextNode(loaded);
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const ppm = loaded.track.json.pxPerMeter;
let tot = { clear: 0, slow: 0, contact: 0, off: 0 };
for (let seed = 1; seed <= seeds; seed++) {
  const builds: CarBuild[] = Array.from({ length: 10 }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id }));
  let w: WorldState = createRaceWorld(ctx, builds, { laps: 2, seed });
  const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => cfg.presets[cfg.defaultPreset]!, () => cfg, 1000 + i));
  let slow = 0, contact = 0, off = 0, clear = -1;
  const offAt: string[] = [];
  const wasOff = w.cars.map(() => false);
  for (let t = 0; t < 60 * 60; t++) {
    w = step(w, ai.map((d) => d.read(w.tick)), ctx);
    const r = w.race!;
    if (r.phase !== 'racing') continue;
    const since = w.tick / 60 - r.startTime;
    w.cars.forEach((c, i) => {
      if (since > 3 && Math.abs(c.speed) * 3.6 < 15) slow += 1 / 60;
      if (c.carContact) contact++;
      if (c.offTrack && !wasOff[i]) { off++; offAt.push(`(${Math.round((c.x * ppm) / 100)}00,${Math.round((c.y * ppm) / 100)}00)`); }
      wasOff[i] = c.offTrack;
    });
    // The whole pack 300 m round (progress in laps x line length).
    if (clear < 0 && r.cars.every((c) => c.progress * line.length > 300)) { clear = since; break; }
  }
  console.log(`seed ${seed}: pack past turn 1 in ${clear < 0 ? '>60' : clear.toFixed(1)} s; car-seconds under 15 kph ${slow.toFixed(1)}; contact ticks ${contact}; off-tracks ${off} ${offAt.join(' ')}`);
  tot = { clear: tot.clear + (clear < 0 ? 60 : clear), slow: tot.slow + slow, contact: tot.contact + contact, off: tot.off + off };
}
console.log(`mean: pack clear ${(tot.clear / seeds).toFixed(1)} s; slow ${(tot.slow / seeds).toFixed(1)} car-s; contact ${(tot.contact / seeds).toFixed(0)} ticks; off ${(tot.off / seeds).toFixed(1)}`);
