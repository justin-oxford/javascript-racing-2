// Tyre wear probe: one AI car, N laps on the default track, live config. Splits each tyre's wear into
// its terms (cornering, braking, throttle) so a front/rear imbalance can be traced to its cause.
// Usage: npm run wear-probe [-- --laps 8]
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, createWorld, step, type AiConfig, type WorldState } from '../src/sim/index.ts';
import { defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const laps = Number(args[args.indexOf('--laps') + 1] ?? 8) || 8;
const loaded = loadTrackNode(defaultTrackIdNode());
const ctx = simContextNode(loaded);
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const p = ctx.physics, G = 9.81, dt = 1 / 60;
let w: WorldState = createWorld(ctx, 1);
const ai = aiInputSource(0, () => ({ world: w, ctx, line }), () => ({ ...cfg.presets[cfg.defaultPreset]!, mistakesPerMin: 0 }), () => cfg, 7);
const terms = [0, 1, 2, 3].map(() => ({ corner: 0, brake: 0, throttle: 0 }));
let slipping = 0, ticks = 0;
for (let t = 0; t < 60 * 60 * 10 && w.cars[0]!.timing.laps < laps; t++) {
  const before = w.cars[0]!;
  w = step(w, [ai.read(w.tick)], ctx);
  const c = w.cars[0]!;
  // Same terms as world.ts updateConsumables, recomputed from the state after the step.
  const kph = Math.abs(c.speed) * 3.6, v4 = (kph / p.wear.refSpeedKph) ** 4;
  const qw = ((p.car.dryMassKg + c.fuelKg) * G) / 4;
  c.wheels.forEach((wh, i) => {
    // Lateral force ~ grip x lateral slip share (slip angle / peak); an estimate, telemetry has no force.
    const lat = wh.gripN * p.tyres.lateralGrip * Math.min(1, Math.abs(wh.slipDeg) / p.tyres.peakSlipDeg);
    terms[i]!.corner += p.wear.cornerPerSec * v4 * (lat / qw) * dt;
    if (i < 2) terms[i]!.brake += p.wear.brakePerSec * c.controls.brake * v4 * dt;
  });
  if (c.wheels[2]!.slipDeg > 7 || c.wheels[3]!.slipDeg > 7) slipping++;
  ticks++;
  void before;
}
const c = w.cars[0]!;
// Throttle term = whatever rear wear the corner term doesn't explain.
for (const i of [2, 3]) terms[i]!.throttle = Math.max(0, 1 - c.wheels[i]!.wear - terms[i]!.corner);
for (const i of [0, 1]) terms[i]!.corner = Math.max(0, 1 - c.wheels[i]!.wear - terms[i]!.brake);
console.log(`${c.timing.laps} laps, ${(ticks / 60).toFixed(0)} s; wear left FL ${c.wheels[0]!.wear.toFixed(3)} FR ${c.wheels[1]!.wear.toFixed(3)} RL ${c.wheels[2]!.wear.toFixed(3)} RR ${c.wheels[3]!.wear.toFixed(3)}`);
console.log('wheel   corner  brake  throttle  (wear used; fronts: corner = the rest after braking; rears: throttle = the rest after cornering)');
['FL', 'FR', 'RL', 'RR'].forEach((n, i) => { const t = terms[i]!; console.log(`${n}     ${t.corner.toFixed(3)}  ${t.brake.toFixed(3)}  ${t.throttle.toFixed(3)}`); });
console.log(`rear slip > 7 deg: ${(100 * slipping / ticks).toFixed(1)}% of the time`);
