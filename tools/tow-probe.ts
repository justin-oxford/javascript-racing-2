// Slipstream probe (card "Slipstream + dirty air"), live config, default track (Oxford).
// Usage: npm run tow-probe [-- --tow 0.45 --dirty 0.1 --eager 1]
//  1. TOW: two identical cars flat out down the main straight, the follower 12 m back, vs the same
//     car alone: the follower's speed gain from the tow (and how the gap closes).
//  2. PASS: two identical AI cars from a rolling start at the start of the main straight, follower 6-10 m back:
//     is it past by the end of the turn after the straight? With the tow vs without.
//  3. AI USE: a 10-car race, share of racing time AI cars spend in a tow, overtakes, tow on vs off.
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, createRaceWorld, createWorld, step, type AiConfig, type CarBuild, type SimContext, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const loaded = loadTrackNode(defaultTrackIdNode());
const base0 = simContextNode(loaded);
const argNum = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : undefined; };
// --tow / --dirty / --eager: try other values without touching config.
const ss = base0.slipstream;
const base: SimContext = { ...base0, slipstream: {
  ...ss,
  tow: { ...ss.tow, maxDragReduction: argNum('tow') ?? ss.tow.maxDragReduction },
  dirtyAir: { ...ss.dirtyAir, maxDownforceLoss: argNum('dirty') ?? ss.dirtyAir.maxDownforceLoss },
  aiTowEagerness: argNum('eager') === undefined ? ss.aiTowEagerness : Object.fromEntries(Object.keys(ss.aiTowEagerness).map((k) => [k, argNum('eager')!])),
} };
const noTow = (ctx: SimContext): SimContext => ({ ...ctx, slipstream: { ...ctx.slipstream, tow: { ...ctx.slipstream.tow, maxDragReduction: 0 } } });
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const preset = cfg.presets[cfg.defaultPreset]!;
const { spawn, pxPerMeter: ppm } = loaded.track.json;
const f = { x: Math.sin(spawn.heading), y: -Math.cos(spawn.heading) };
const build: CarBuild = base.physics.defaultCar;

/** Two cars on the main straight: car 0 leads `lead` m before the spawn, car 1 `gap` m behind it, both at `v` m/s. */
function rolling(ctx: SimContext, gap: number, v: number, lead = 0): WorldState {
  const w = createWorld(ctx, [build, build]);
  const place = (c: WorldState['cars'][number], back: number) => ({ ...c, x: spawn.x / ppm - f.x * back, y: spawn.y / ppm - f.y * back, heading: spawn.heading, vx: f.x * v, vy: f.y * v });
  return { ...w, cars: [place(w.cars[0]!, lead), place(w.cars[1]!, lead + gap)] };
}

// 1. Speed gain.
for (const [name, ctx] of [['tow on ', base], ['tow off', noTow(base)]] as const) {
  let w = rolling(ctx, 12, 30, 50);
  let maxTow = 0;
  for (let t = 0; t < 60 * 2; t++) { w = step(w, [{ throttle: 1, brake: 0, steer: 0 }, { throttle: 1, brake: 0, steer: 0 }], ctx); maxTow = Math.max(maxTow, w.cars[1]!.tow); }
  const [a, b] = w.cars as [WorldState['cars'][number], WorldState['cars'][number]];
  const gap = (a.x - b.x) * f.x + (a.y - b.y) * f.y;
  console.log(`TOW  ${name}: after 2 s flat out, leader ${(a.speed * 3.6).toFixed(1)} kph, follower ${(b.speed * 3.6).toFixed(1)} kph (+${((b.speed - a.speed) * 3.6).toFixed(1)}), gap 12.0 -> ${gap.toFixed(1)} m, peak tow ${(maxTow * 100).toFixed(0)}% less drag`);
}

// 2. A pass into the turn after the main straight.
const t1End = (() => {
  // The first point after the straight where the line has turned through 90 degrees: past turn 1.
  let q = 0, best = Infinity;
  for (let i = 0; i < line.n; i++) { const d = (line.x[i]! - spawn.x / ppm) ** 2 + (line.y[i]! - spawn.y / ppm) ** 2; if (d < best) { best = d; q = i; } }
  let turned = 0;
  for (let k = 0; k < line.n && turned < Math.PI / 2; k++, q = (q + 1) % line.n) turned += Math.abs(line.k[q]!) * 2;
  return { x: line.x[q]!, y: line.y[q]! };
})();
for (const [name, ctx] of [['tow on ', base], ['tow off', noTow(base)]] as const) {
  let passes = 0, runs = 0;
  for (const gap of [7, 9, 11]) for (const v of [28, 33]) {
    let w = rolling(ctx, gap, v, 70); // out of the previous corner: the whole straight ahead
    const ai = [0, 1].map((i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => ({ ...preset, mistakesPerMin: 0 }), () => cfg, 7 + i));
    for (let t = 0; t < 60 * 12; t++) {
      w = step(w, ai.map((d) => d.read(w.tick)), ctx);
      const dist = (c: WorldState['cars'][number]) => Math.hypot(c.x - t1End.x, c.y - t1End.y);
      if (dist(w.cars[0]!) < 6 || dist(w.cars[1]!) < 6) { if (dist(w.cars[1]!) < dist(w.cars[0]!)) passes++; break; }
    }
    runs++;
  }
  console.log(`PASS ${name}: follower ahead by the end of turn 1 in ${passes}/${runs} rolling starts from the start of the straight (gaps 7/9/11 m, 101/119 kph)`);
}

// 3. AI use in a race.
for (const [name, ctx] of [['tow on ', base], ['tow off', noTow(base)]] as const) {
  const builds: CarBuild[] = Array.from({ length: 10 }, (_, i) => ({ ...build, team: catalog.teams[i]!.id }));
  let w = createRaceWorld(ctx, builds, { laps: 5, seed: 1 });
  const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => preset, () => cfg, 1000 + i));
  let racing = 0, towed = 0, dirty = 0, swaps = 0;
  let order = w.race!.order.join(',');
  for (let t = 0; t < 60 * 60 * 5 && w.race!.phase !== 'results'; t++) {
    w = step(w, ai.map((d) => d.read(w.tick)), ctx);
    if (w.race!.phase !== 'racing') continue;
    for (const c of w.cars) { racing++; if (c.tow > 0.05) towed++; if (c.dirtyAir > 0.01) dirty++; }
    const o = w.race!.order.join(',');
    if (o !== order) { const a = order.split(','), b = o.split(','); for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) { swaps++; break; } order = o; }
  }
  console.log(`AI   ${name}: 5-lap race, cars in a tow (>5%) ${((100 * towed) / racing).toFixed(1)}% of racing time, dirty air ${((100 * dirty) / racing).toFixed(1)}%, position changes ${swaps}`);
}
