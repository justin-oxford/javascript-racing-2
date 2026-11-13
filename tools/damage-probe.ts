// Damage probe (POLISH card): the contact closing speeds behind car damage, with live config, so
// config/damage.json thresholdMps / perMps have numbers to go with the feel test.
// Usage: npm run damage-probe
//   Scripted: a rub and a punt (as contact-probe), nose-first wall hits at several speeds, a glancing wall
//   hit, and a car pinned against a wall at full throttle. Then 10 AI x 5 laps of racing.
// Reports the biggest closing speed and the damage it leaves (damage set to Visual: recorded, no effect).
import aiJson from '../config/ai.json' with { type: 'json' };
import rules from '../config/rules.json' with { type: 'json' };
import wallTracing from '../config/wall-tracing.json' with { type: 'json' };
import { aiInputSource, bodyOffsetM, buildRacingLine, createRaceWorld, createSimTrack, createWorld, step, traceWalls, type AiConfig, type CarInput, type DamageState, type SimContext, type TrackJson, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode, surfaces } from './load-track-node.ts';

const loaded = loadTrackNode(defaultTrackIdNode());
const ctx = simContextNode(loaded);
const visual = { damage: 'visual' as const };
const dmgText = (d: DamageState) => `front wing ${(d.frontWing * 100).toFixed(0)}%, rear wing ${(d.rearWing * 100).toFixed(0)}%, left ${(d.left * 100).toFixed(0)}%, right ${(d.right * 100).toFixed(0)}%`;
console.log(`thresholdMps ${ctx.damage.thresholdMps}, perMps ${ctx.damage.perMps}, strength ${ctx.damage.strength}; wall x${ctx.damage.wallMult}, barrier x${ctx.damage.barrierMult}, car x${ctx.damage.carMult}\n`);

/** Run `w` for `sec`, tracking the largest single-tick impulse on car 0 (and on any car). */
function run(c: SimContext, w: WorldState, inputs: CarInput[], sec: number): { w: WorldState; peak0: number; peak: number; carPeak: number; wallPeak: number } {
  let peak0 = 0, peak = 0, carPeak = 0, wallPeak = 0;
  for (let t = 0; t < sec * 60; t++) {
    w = step(w, inputs, c);
    for (const h of c.cache.hits) {
      peak = Math.max(peak, h.speed);
      if (h.car === 0) peak0 = Math.max(peak0, h.speed);
      if (h.kind === 'car') carPeak = Math.max(carPeak, h.speed); else wallPeak = Math.max(wallPeak, h.speed);
    }
  }
  return { w, peak0, peak, carPeak, wallPeak };
}

// Car contacts on Oxford's start straight (same geometry as contact-probe).
{
  const { spawn, pxPerMeter: ppm } = ctx.track.json;
  const f = { x: Math.sin(spawn.heading), y: -Math.cos(spawn.heading) }, r = { x: Math.cos(spawn.heading), y: Math.sin(spawn.heading) };
  const scenario = (b: { along: number; across: number; speed: number; headingOff: number }, aSpeed: number): WorldState => {
    const w = createWorld(ctx, 2, visual);
    const place = (car: WorldState['cars'][number], along: number, across: number, v: number, dh: number) => ({
      ...car,
      x: spawn.x / ppm + f.x * along + r.x * across - Math.sin(spawn.heading + dh) * bodyOffsetM(ctx.physics),
      y: spawn.y / ppm + f.y * along + r.y * across + Math.cos(spawn.heading + dh) * bodyOffsetM(ctx.physics),
      heading: spawn.heading + dh, vx: Math.sin(spawn.heading + dh) * v, vy: -Math.cos(spawn.heading + dh) * v,
    });
    return { ...w, cars: [place(w.cars[0]!, 0, 0, aSpeed, 0), place(w.cars[1]!, b.along, b.across, b.speed, b.headingOff)] };
  };
  const cruise: CarInput = { throttle: 0.6, brake: 0, steer: 0 };
  const rub = run(ctx, scenario({ along: 0, across: 2.2, speed: 42, headingOff: -0.04 }, 42), [cruise, { throttle: 0.6, brake: 0, steer: -0.15 }], 1.5);
  console.log(`RUB  (150 kph, side by side): car-to-car ${rub.carPeak.toFixed(1)} m/s (then a wall ${rub.wallPeak.toFixed(1)}) -> car 0 ${dmgText(rub.w.cars[0]!.damage)}; car 1 ${dmgText(rub.w.cars[1]!.damage)}`);
  const punt = run(ctx, scenario({ along: -ctx.physics.car.lengthM + 0.5, across: 2.4, speed: 38, headingOff: -0.3 }, 30), [cruise, { throttle: 1, brake: 0, steer: 0 }], 2);
  console.log(`PUNT (8 m/s faster, rear quarter): car-to-car ${punt.carPeak.toFixed(1)} m/s (then a wall ${punt.wallPeak.toFixed(1)}) -> hit car ${dmgText(punt.w.cars[0]!.damage)}; hitter ${dmgText(punt.w.cars[1]!.damage)}`);
}

// Wall hits in a walled box arena (asphalt inside a 1 m wall), car driving up toward the top wall.
{
  const PPM = 10, W = 60, H = 400;
  const idx = (id: string) => surfaces.findIndex((s) => s.id === id);
  const data = new Uint8Array(W * PPM * H * PPM);
  for (let y = 0; y < H * PPM; y++) for (let x = 0; x < W * PPM; x++) data[y * W * PPM + x] = idx(x < PPM || y < PPM || x >= (W - 1) * PPM || y >= (H - 1) * PPM ? 'wall' : 'asphalt');
  const json: TrackJson = { id: 'arena', name: 'arena', pxPerMeter: PPM, files: { mask: 'mask.png' }, timingLines: {}, racingLine: [], grid: [], spawn: { x: 30 * PPM, y: 395 * PPM, heading: 0 } };
  const track = createSimTrack(json, { width: W * PPM, height: H * PPM, data }, surfaces);
  const arena: SimContext = { ...ctx, track, walls: traceWalls(track.mask, track.index.wall, track.index.tyreBarrier, wallTracing), rules };
  const hit = (kph: number, angleDeg: number) => {
    let w = createWorld(arena, 1, visual);
    const h = (angleDeg * Math.PI) / 180, v = kph / 3.6;
    // 8 m from the top wall's face, heading up (0) or angled toward it, moving at v.
    w = { ...w, cars: [{ ...w.cars[0]!, x: 30, y: 1 + 8 + 3, heading: h, vx: Math.sin(h) * v, vy: -Math.cos(h) * v }] };
    return run(arena, w, [{ throttle: 0, brake: 0, steer: 0 }], 1.5);
  };
  for (const kph of [30, 60, 100, 150, 200]) { const r = hit(kph, 0); console.log(`WALL nose-first ${String(kph).padStart(3)} kph: peak ${r.peak0.toFixed(1).padStart(5)} m/s -> ${dmgText(r.w.cars[0]!.damage)}`); }
  { const r = hit(150, 70); console.log(`WALL glancing 150 kph, 20 deg: peak ${r.peak0.toFixed(1)} m/s -> ${dmgText(r.w.cars[0]!.damage)}`); }
  {
    let w = createWorld(arena, 1, visual);
    w = { ...w, cars: [{ ...w.cars[0]!, x: 30, y: 1 + 2.6 + 0.3, heading: 0 }] };
    const r = run(arena, w, [{ throttle: 1, brake: 0, steer: 0 }], 4);
    console.log(`PINNED against a wall, full throttle 4 s: peak ${r.peak0.toFixed(1)} m/s -> ${dmgText(r.w.cars[0]!.damage)}`);
  }
}

// Racing: 10 AI, 5 laps, damage recorded (Visual) to see what normal racing does.
{
  const line = buildRacingLine(loaded.track)!;
  const cfg = aiJson as unknown as AiConfig;
  const builds = Array.from({ length: 10 }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id }));
  let w = createRaceWorld(ctx, builds, { laps: 5, seed: 1, settings: visual });
  const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => cfg.presets[cfg.defaultPreset]!, () => cfg, 100 + i));
  const peaks = { car: 0, wall: 0, barrier: 0 };
  let over = 0;
  for (let t = 0; t < 60 * 400 && w.race!.phase !== 'results'; t++) {
    w = step(w, ai.map((d) => d.read(w.tick)), ctx);
    for (const h of ctx.cache.hits) { peaks[h.kind] = Math.max(peaks[h.kind], h.speed); if (h.speed > ctx.damage.thresholdMps) over++; }
  }
  const worst = Math.max(...w.cars.map((c) => Math.max(c.damage.frontWing, c.damage.rearWing, c.damage.left, c.damage.right)));
  console.log(`\nRACE 10 AI x 5 laps: peak closing speed car ${peaks.car.toFixed(0)}, wall ${peaks.wall.toFixed(0)}, barrier ${peaks.barrier.toFixed(1)} m/s; hits over threshold ${over}; worst zone damage ${(worst * 100).toFixed(0)}%`);
}
