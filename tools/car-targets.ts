// Game-scale car card: score the car against its behaviour targets 1-7, the same way before and after a change.
// Usage: npm run car-targets [-- --car v1] [--physics file.json] [--json out.json] [--only 1,2,5]
//   --car v1: the old car (config/car-v1.json over the live config), as ?car=v1 does in the browser.
// Oxford, the track's base setup, the default car, no AI mistakes. Thresholds (the card's words made numbers):
//   1 HAIRPIN (Oxford v2 middle-right): at the AI's speed there, steer used <= 0.9 and fronts <= 1.0 of peak, the
//     car's tightest steady radius at that speed >= 10% under the line's radius, lifting tightens >= 10%; at 2/3
//     of that speed the tightest radius is >= 35% under the line's radius.
//   2 KEYBOARD: from 80 m before the hairpin at the AI's speed, bang-bang throttle / brake to the AI's planned
//     speed, FULL steer at once from turn-in until the car points down the exit: no wall, never all four wheels
//     off, no spin (body slip < 45 deg).
//   3 DOWNFORCE: the speed it can corner at (from the tightest steady radius on a skidpad) with vs without
//     downforce: >= +8% at 100 kph (medium) and >= +15% at 160 kph (fast).
//   4 BALANCE: rear / front slip angle on a steer that holds 1.15x the tightest radius (1 = neutral, < 1 understeer):
//     at 45 and 60 kph >= 0.65 (not tight at low speed); at 100 and 160 kph between 0.6 and 1.05 (mild understeer); full throttle (keyboard,
//     assist on) out of a steady 60 kph corner: body slip < 20 deg, no spin.
//   5 WEAR: 10 AI laps: front wear per lap / rear wear per lap between 1.00 and 1.05.
//   6 SETUPS: on the same steer near the limit, some setting turns >= 5% tighter and some >= 5% wider than the base
//     setup, at 60 and 130 kph (anti-roll bars and wings at their ends).
//   7 PACE: reported only (AI best lap, laps 2-3).
import aiJson from '../config/ai.json' with { type: 'json' };
import carV1 from '../config/car-v1.json' with { type: 'json' };
import rules from '../config/rules.json' with { type: 'json' };
import wallTracing from '../config/wall-tracing.json' with { type: 'json' };
import { readFileSync, writeFileSync } from 'node:fs';
import {
  aiInputSource, buildRacingLine, buildStats, cornersOf, createSimTrack, createWorld, normalizeSetup, speedProfile, step, surfaceAt, traceWalls,
  type AiConfig, type CarBuild, type CarInput, type CarSetup, type PhysicsConfig, type SimContext, type TrackJson, type WorldState,
} from '../src/sim/index.ts';
import { catalog, loadTrackNode, simContextNode, surfaces } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const only = new Set((opt('only') ?? '1,2,3,4,5,6,7').split(',').map(Number));
const loaded = loadTrackNode('oxford');
let physics = structuredClone(simContextNode(loaded).physics) as PhysicsConfig;
if (opt('physics')) physics = JSON.parse(readFileSync(opt('physics')!, 'utf8')) as PhysicsConfig;
let baseRaw: unknown = loaded.track.json.baseSetup;
if (opt('car') === 'v1') {
  const snap = carV1 as unknown as { physics: Record<string, unknown>; specs: Record<string, unknown>; baseSetup: Record<string, unknown> };
  for (const [k, v] of Object.entries(snap.physics)) (physics as unknown as Record<string, unknown>)[k] = structuredClone(v);
  for (const [k, v] of Object.entries(snap.specs)) (catalog.specs as unknown as Record<string, unknown>)[k] = structuredClone(v);
  baseRaw = snap.baseSetup.oxford ?? baseRaw;
}
const ctx: SimContext = simContextNode(loaded, physics);
const baseSetup: CarSetup = normalizeSetup(baseRaw ?? physics.defaultCar.setup, catalog.specs.setup);
const build = (setup: CarSetup = baseSetup): CarBuild => ({ ...physics.defaultCar, setup });
const line = buildRacingLine(loaded.track)!;
const cfg0 = aiJson as unknown as AiConfig;
const preset = { ...cfg0.presets[cfg0.defaultPreset]!, mistakesPerMin: 0 };
const KPH = 1 / 3.6, DEG = 180 / Math.PI, peak = physics.tyres.peakSlipDeg;
const course = (c: { vx: number; vy: number }) => Math.atan2(c.vx, -c.vy);
const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
type Car = WorldState['cars'][number];
const frontUse = (c: Car) => Math.max(c.wheels[0]!.usage, c.wheels[1]!.usage);
const rearUse = (c: Car) => Math.max(c.wheels[2]!.usage, c.wheels[3]!.usage);
const frontSlip = (c: Car) => Math.max(Math.abs(c.wheels[0]!.slipDeg), Math.abs(c.wheels[1]!.slipDeg)) / peak;
const rearSlip = (c: Car) => Math.max(Math.abs(c.wheels[2]!.slipDeg), Math.abs(c.wheels[3]!.slipDeg)) / peak;
const out: Record<string, unknown> = { car: opt('car') ?? (opt('physics') ? `physics ${opt('physics')}` : 'live') };
const verdict = (ok: boolean) => (ok ? 'PASS' : 'MISS');
const say = (s: string) => console.log(s);

// ---------- skidpad ----------
const PPM = 4, W = 600, H = 600;
const idx = (id: string) => surfaces.findIndex((s) => s.id === id);
const data = new Uint8Array(W * PPM * H * PPM).fill(idx('asphalt'));
for (let y = 0; y < H * PPM; y++) for (let x = 0; x < W * PPM; x++) if (x < PPM || y < PPM || x >= (W - 1) * PPM || y >= (H - 1) * PPM) data[y * W * PPM + x] = idx('wall');
const pad: TrackJson = { id: 'skidpad', name: 'skidpad', pxPerMeter: PPM, files: { mask: 'mask.png' }, timingLines: {}, racingLine: [], grid: [], spawn: { x: 300 * PPM, y: 300 * PPM, heading: 0 } };
const padTrack = createSimTrack(pad, { width: W * PPM, height: H * PPM, data }, surfaces);
const arena = (p: PhysicsConfig = physics): SimContext => ({ ...ctx, physics: p, track: padTrack, walls: traceWalls(padTrack.mask, padTrack.index.wall, padTrack.index.tyreBarrier, wallTracing), rules });
const ARENA = arena();
const hold = (c: Car, vT: number, steer: number): CarInput => { const e = vT - Math.hypot(c.vx, c.vy); return { throttle: Math.max(0, Math.min(1, 0.25 + 0.5 * e)), brake: e < -0.5 ? Math.min(1, -0.3 * e) : 0, steer }; };
function drive(w: WorldState, sec: number, input: (c: Car) => CarInput, a: SimContext, measureSec = sec) {
  let dist = 0, turned = 0, last = course(w.cars[0]!), front = 0, rear = 0, fu = 0, ru = 0, n = 0, maxBody = 0;
  for (let t = 0; t < sec * 60; t++) {
    w = step(w, [input(w.cars[0]!)], a);
    const c = w.cars[0]!, cc = course(c);
    if (t >= (sec - measureSec) * 60) { dist += Math.hypot(c.vx, c.vy) / 60; turned += wrapA(cc - last); front += frontSlip(c); rear += rearSlip(c); fu += Math.min(2, frontUse(c)); ru += Math.min(2, rearUse(c)); n++; }
    if (Math.hypot(c.vx, c.vy) > 3) maxBody = Math.max(maxBody, Math.abs(wrapA(c.heading - cc)) * DEG);
    last = cc;
  }
  const c = w.cars[0]!;
  return { w, R: Math.abs(turned) > 1e-6 ? dist / Math.abs(turned) : Infinity, v: Math.hypot(c.vx, c.vy), front: front / Math.max(1, n), rear: rear / Math.max(1, n), fUse: fu / Math.max(1, n), rUse: ru / Math.max(1, n), maxBody };
}
const startAt = (v: number, a: SimContext, b: CarBuild): WorldState => { const w = createWorld(a, [b]); return { ...w, cars: [{ ...w.cars[0]!, x: 300, y: 300, heading: 0, vx: 0, vy: -v }] }; };
const steady = (v: number, s: number, a = ARENA, b = build()) => drive(startAt(v, a, b), 6, (c) => hold(c, v, s), a, 2);
/** Tightest steady radius at speed v (steer 0.1..1). */
function tightest(v: number, a = ARENA, b = build()) {
  let best = { R: Infinity, s: 0, front: 0, rear: 0, v: 0 };
  for (let s = 0.1; s <= 1.0001; s += 0.05) { const r = steady(v, s, a, b); if (r.R < best.R && r.v > v * 0.93) best = { R: r.R, s, front: r.front, rear: r.rear, v: r.v }; }
  return best;
}
/**
 * Balance at speed v, open loop like a driver holding the wheel: the steer that puts the base car on 1.15x its
 * tightest radius (near the limit, still holdable), then each car on that same steer. balance = rear slip angle /
 * front slip angle (1 = neutral, under 1 = understeer); R = the radius it holds on that steer (a looser car turns
 * tighter on the same input).
 */
const refSteer = new Map<number, number>();
function balanceAt(kph: number, b = build(), a = ARENA) {
  const v = kph * KPH;
  if (!refSteer.has(kph)) {
    const R = tightest(v).R * 1.15;
    let bs = 0.1, bd = Infinity;
    for (let s = 0.06; s <= 1.0001; s += 0.02) { const r = steady(v, s); if (r.v >= v * 0.93 && Math.abs(r.R - R) < bd) { bd = Math.abs(r.R - R); bs = s; } }
    refSteer.set(kph, bs);
  }
  const r = steady(v, refSteer.get(kph)!, a, b);
  return { kph, R: r.R, steer: refSteer.get(kph)!, front: r.front, rear: r.rear, balance: r.front > 0 ? r.rear / r.front : 0, held: r.v >= v * 0.93 };
}

// ---------- the hairpin: the AI alone on Oxford ----------
const hairpinXY = { x: 1440 / loaded.track.json.pxPerMeter, y: 990 / loaded.track.json.pxPerMeter };
const corners = cornersOf(line);
const hairpin = corners.map((c) => { let best = Infinity, q = c.from; for (let k = c.from; k !== (c.to + 1) % line.n; k = (k + 1) % line.n) { const d = (line.x[k]! - hairpinXY.x) ** 2 + (line.y[k]! - hairpinXY.y) ** 2; if (d < best) { best = d; q = k; } } return { c, d: best, q }; }).sort((a, b) => a.d - b.d)[0]!;
const inHairpin = (q: number) => { const { from, to } = hairpin.c; const t2 = (to + 6) % line.n; return from <= t2 ? q >= from && q <= t2 : q >= from || q <= t2; };
let ai = { minV: Infinity, R: 0, steer: 0, front: 0, rear: 0, q: 0, bestLap: Infinity };
{
  let w: WorldState = createWorld(ctx, [build()]);
  const d = aiInputSource(0, () => ({ world: w, ctx, line }), () => preset, () => cfg0, 5);
  let last = course(w.cars[0]!);
  for (let t = 0; t < 60 * 150 && w.cars[0]!.timing.laps < 3; t++) {
    w = step(w, [d.read(w.tick)], ctx);
    for (const e of w.events) if (e.type === 'lap' && !e.invalid && w.cars[0]!.timing.laps >= 2) ai.bestLap = Math.min(ai.bestLap, e.time);
    const c = w.cars[0]!, v = Math.hypot(c.vx, c.vy), cc = course(c), dpsi = wrapA(cc - last);
    last = cc;
    if (c.timing.laps < 1 || !inHairpin(d.state.near) || v > ai.minV) continue;
    ai = { ...ai, minV: v, R: Math.abs(dpsi) > 1e-6 ? v / 60 / Math.abs(dpsi) : Infinity, steer: Math.abs(c.controls.steer), front: frontSlip(c), rear: rearSlip(c), q: d.state.near };
  }
}

if (only.has(1)) {
  const vH = ai.minV;
  const t = tightest(vH);
  // The steer that holds the AI's radius on the pad, then 1 s of lifting.
  let s0 = 0.1, r0 = steady(vH, 0.1);
  for (let s = 0.1; s <= 1.0001; s += 0.02) { const r = steady(vH, s); if (Math.abs(r.R - ai.R) < Math.abs(r0.R - ai.R)) { s0 = s; r0 = r; } }
  const base = drive(startAt(vH, ARENA, build()), 6, (c) => hold(c, vH, s0), ARENA);
  const lift = drive(base.w, 1, () => ({ throttle: 0, brake: 0, steer: s0 }), ARENA);
  const t23 = tightest(vH * 2 / 3);
  let v9 = 0;
  for (let kph = 30; kph <= 100; kph += 2.5) { const r = tightest(kph * KPH); if (r.R <= 9) v9 = kph; else if (v9) break; }
  const spare = 1 - t.R / ai.R, lifted = 1 - lift.R / r0.R, slower = 1 - t23.R / ai.R;
  const ok = ai.steer <= 0.9 && ai.front <= 1.0 && spare >= 0.1 && lifted >= 0.1 && slower >= 0.35;
  out.t1 = { line: ai.q, kph: vH / KPH, pathR: ai.R, steer: ai.steer, front: ai.front, rear: ai.rear, tightestR: t.R, spare, lifted, kph23: (vH * 2) / 3 / KPH, tightest23: t23.R, slower, kph9m: v9, pass: ok };
  say(`1 HAIRPIN (line point ${ai.q}): AI ${(vH / KPH).toFixed(0)} kph on a ${ai.R.toFixed(1)} m path, steer ${ai.steer.toFixed(2)}, fronts ${ai.front.toFixed(2)} / rears ${ai.rear.toFixed(2)} of peak; tightest at that speed ${t.R.toFixed(1)} m (${(spare * 100).toFixed(0)}% spare); lift 1 s: ${(lifted * 100).toFixed(0)}% tighter; at 2/3 speed (${((vH * 2) / 3 / KPH).toFixed(0)} kph) ${t23.R.toFixed(1)} m (${(slower * 100).toFixed(0)}% tighter); holds a 9 m circle up to ${v9} kph  ${verdict(ok)}`);
}

if (only.has(2)) {
  const ppm = loaded.track.json.pxPerMeter;
  const stats = buildStats(build(), catalog);
  const vPlan = speedProfile(line.x, line.y, physics, stats, { cornerMargin: preset.cornerMargin, brakeMargin: preset.brakeMargin, fuelKg: physics.fuel.startKg / 2 });
  const n = line.n, wrap = (q: number) => ((q % n) + n) % n;
  // Turn-in: where the hairpin's line radius first gets under twice its tightest (a keyboard player's turn-in).
  let kMax = 0; for (let q = hairpin.c.from; q !== hairpin.c.to; q = wrap(q + 1)) kMax = Math.max(kMax, Math.abs(line.k[q]!));
  let qIn = hairpin.c.from; while (Math.abs(line.k[qIn]!) < kMax / 2 && qIn !== hairpin.q) qIn = wrap(qIn + 1);
  const exitQ = wrap(hairpin.c.to + 3);
  const sign = Math.sign(line.k[hairpin.q]!) || 1;
  const q0 = wrap(qIn - 40);
  void q0;
  const tan = (q: number) => Math.atan2(line.x[wrap(q + 1)]! - line.x[q]!, -(line.y[wrap(q + 1)]! - line.y[q]!));
  let w: WorldState = createWorld(ctx, [build()]);
  const v0 = vPlan[q0]!;
  w = { ...w, cars: [{ ...w.cars[0]!, x: line.x[q0]!, y: line.y[q0]!, heading: tan(q0), vx: Math.sin(tan(q0)) * v0, vy: -Math.cos(tan(q0)) * v0 }] };
  let near = q0, phase: 'approach' | 'turn' | 'exit' = 'approach', walls = 0, offAll = 0, wheelsOff = 0, maxBody = 0, done = false, steerTicks = 0;
  const nearest = (c: Car) => { let b = near, bd = Infinity; for (let d = -5; d <= 15; d++) { const q = wrap(near + d), e = (line.x[q]! - c.x) ** 2 + (line.y[q]! - c.y) ** 2; if (e < bd) { bd = e; b = q; } } return b; };
  const ahead = (a: number, b: number) => wrap(b - a);
  for (let t = 0; t < 60 * 20 && !done; t++) {
    const c = w.cars[0]!;
    near = nearest(c);
    const v = Math.hypot(c.vx, c.vy), target = vPlan[near]!;
    // Keyboard throttle / brake: all or nothing.
    const thr = v < target - 0.5 ? 1 : 0, brk = v > target + 1 ? 1 : 0;
    let steer = 0;
    if (phase === 'approach' && ahead(near, qIn) <= 0 || (phase === 'approach' && ahead(near, qIn) > n / 2)) phase = 'turn';
    if (phase === 'approach') { const e = wrapA(tan(wrap(near + 4)) - c.heading); steer = Math.max(-1, Math.min(1, e * 3)); }
    else if (phase === 'turn') { steer = sign; steerTicks++; if (ahead(near, exitQ) < n / 2 && Math.abs(wrapA(tan(exitQ) - c.heading)) < 10 / DEG) phase = 'exit'; if (ahead(hairpin.q, near) > 6 && ahead(hairpin.q, near) < n / 2 && Math.abs(wrapA(tan(wrap(near + 4)) - c.heading)) < 8 / DEG) phase = 'exit'; }
    else { const e = wrapA(tan(wrap(near + 4)) - c.heading); steer = Math.max(-1, Math.min(1, e * 3)); if (ahead(exitQ, near) > 15 && ahead(exitQ, near) < n / 2) done = true; }
    w = step(w, [{ throttle: thr, brake: brk, steer }], ctx);
    const c2 = w.cars[0]!;
    if (c2.wallContact) walls++;
    if (c2.offTrack) offAll++;
    wheelsOff += c2.wheels.filter((wh) => !['asphalt', 'kerb'].includes(ctx.track.surfaces[wh.surface]!.id)).length > 0 ? 1 : 0;
    if (Math.hypot(c2.vx, c2.vy) > 3) maxBody = Math.max(maxBody, Math.abs(wrapA(c2.heading - course(c2))) * DEG);
  }
  void surfaceAt; void ppm;
  const ok = done && walls === 0 && offAll === 0 && maxBody < 45;
  out.t2 = { entryKph: vPlan[qIn]! / KPH, made: done, walls, offAllTicks: offAll, wheelOffTicks: wheelsOff, maxBodySlipDeg: maxBody, fullSteerSec: steerTicks / 60, pass: ok };
  say(`2 KEYBOARD: entry ${(vPlan[qIn]! / KPH).toFixed(0)} kph (AI plan), full steer ${(steerTicks / 60).toFixed(1)} s: ${done ? 'made it' : 'did NOT get round'}, wall ticks ${walls}, all-wheels-off ticks ${offAll}, ticks with a wheel off the road ${wheelsOff}, max body slip ${maxBody.toFixed(0)} deg  ${verdict(ok)}`);
}

if (only.has(3)) {
  const noAero = arena({ ...physics, aero: { ...physics.aero, downforceCoef: 0 } });
  const res = [100, 160].map((kph) => {
    const a = tightest(kph * KPH), b = tightest(kph * KPH, noAero);
    return { kph, R: a.R, Rno: b.R, gain: Math.sqrt(b.R / a.R) - 1 };
  });
  const ok = res[0]!.gain >= 0.08 && res[1]!.gain >= 0.15;
  out.t3 = { res, pass: ok };
  say(`3 DOWNFORCE: corner speed gain vs no downforce: ${res.map((r) => `${r.kph} kph R ${r.R.toFixed(1)} vs ${r.Rno.toFixed(1)} m -> +${(r.gain * 100).toFixed(0)}%`).join('; ')}  ${verdict(ok)}`);
}

if (only.has(4)) {
  const low = [45, 60].map((k) => balanceAt(k));
  const high = [100, 160].map((k) => balanceAt(k));
  // Full throttle out of a steady 60 kph corner at 1.3x its tightest radius (keyboard: all or nothing, assist on).
  const v = 60 * KPH, tR = tightest(60 * KPH).R;
  let s0 = 0.1, r0 = steady(v, 0.1);
  for (let s = 0.1; s <= 1.0001; s += 0.02) { const r = steady(v, s); if (Math.abs(r.R - tR * 1.3) < Math.abs(r0.R - tR * 1.3)) { s0 = s; r0 = r; } }
  const settled = drive(startAt(v, ARENA, build()), 6, (c) => hold(c, v, s0), ARENA);
  const gas = drive(settled.w, 2, () => ({ throttle: 1, brake: 0, steer: s0 }), ARENA);
  const noAssist = arena({ ...physics, traction: { ...physics.traction, assist: false } });
  const settled2 = drive(startAt(v, noAssist, build()), 6, (c) => hold(c, v, s0), noAssist);
  const gas2 = drive(settled2.w, 2, () => ({ throttle: 1, brake: 0, steer: s0 }), noAssist);
  const ok = low.every((r) => r.balance >= 0.65) && high.every((r) => r.balance >= 0.6 && r.balance <= 1.05) && gas.maxBody < 20;
  out.t4 = { low, high, throttle: { maxBodySlipDeg: gas.maxBody, rearPeak: gas.rear, noAssistBodySlipDeg: gas2.maxBody }, pass: ok };
  say(`4 BALANCE (rear/front slip at the limit, 1 = neutral): ${[...low, ...high].map((r) => `${r.kph} kph ${r.balance.toFixed(2)} (slip F ${r.front.toFixed(2)} R ${r.rear.toFixed(2)} of peak, ${r.R.toFixed(1)} m at steer ${r.steer.toFixed(2)})`).join(', ')}; full throttle out of 60 kph: body slip ${gas.maxBody.toFixed(0)} deg (assist off: ${gas2.maxBody.toFixed(0)} deg)  ${verdict(ok)}`);
}

if (only.has(5)) {
  let w: WorldState = createWorld(ctx, [build()]);
  const d = aiInputSource(0, () => ({ world: w, ctx, line }), () => preset, () => cfg0, 9);
  const LAPS = 10;
  for (let t = 0; t < 60 * 60 * 10 && w.cars[0]!.timing.laps < LAPS + 1; t++) w = step(w, [d.read(w.tick)], ctx);
  const c = w.cars[0]!, laps = Math.max(1, c.timing.laps);
  const used = c.wheels.map((wh) => 1 - wh.wear);
  const f = (used[0]! + used[1]!) / 2 / laps, r = (used[2]! + used[3]!) / 2 / laps;
  const ratio = f / r;
  const ok = ratio >= 1.0 && ratio <= 1.05;
  out.t5 = { laps, frontPerLap: f, rearPerLap: r, ratio, wear: c.wheels.map((wh) => wh.wear), pass: ok };
  say(`5 WEAR (${laps} laps): fronts ${(f * 100).toFixed(2)}% / rears ${(r * 100).toFixed(2)}% a lap, front/rear ${ratio.toFixed(2)}; left FL ${c.wheels[0]!.wear.toFixed(3)} FR ${c.wheels[1]!.wear.toFixed(3)} RL ${c.wheels[2]!.wear.toFixed(3)} RR ${c.wheels[3]!.wear.toFixed(3)}  ${verdict(ok)}`);
}

if (only.has(6)) {
  const f = catalog.specs.setup.fields;
  const variants: Array<[string, Partial<CarSetup>]> = [
    ['ARB front soft', { arbFront: f.arbFront!.min }], ['ARB front stiff', { arbFront: f.arbFront!.max }],
    ['ARB rear soft', { arbRear: f.arbRear!.min }], ['ARB rear stiff', { arbRear: f.arbRear!.max }],
    ['front wing min', { frontWingDeg: f.frontWingDeg!.min }], ['front wing max', { frontWingDeg: f.frontWingDeg!.max }],
    ['rear wing min', { rearWingDeg: f.rearWingDeg!.min }], ['rear wing max', { rearWingDeg: f.rearWingDeg!.max }],
  ];
  const res = [60, 130].map((kph) => {
    const base = balanceAt(kph);
    const vs = variants.map(([name, ch]) => { const r = balanceAt(kph, build({ ...baseSetup, ...ch } as CarSetup)); return { name, R: r.R, change: r.R / base.R - 1, balance: r.balance }; });
    const tighter = Math.min(...vs.map((x) => x.change)), wider = Math.max(...vs.map((x) => x.change));
    return { kph, baseR: base.R, baseBalance: base.balance, tighter, wider, vs, ok: tighter <= -0.05 && wider >= 0.05 };
  });
  const ok = res.every((r) => r.ok);
  out.t6 = { res, pass: ok };
  for (const r of res) say(`6 SETUPS at ${r.kph} kph, same steer: base ${r.baseR.toFixed(1)} m; ${(r.tighter * 100).toFixed(0)}% .. +${(r.wider * 100).toFixed(0)}% (${r.vs.map((v) => `${v.name} ${v.change >= 0 ? '+' : ''}${(v.change * 100).toFixed(0)}%`).join(', ')})  ${verdict(r.ok)}`);
}

if (only.has(7)) {
  out.t7 = { bestLap: ai.bestLap };
  say(`7 PACE: AI best lap (laps 2-3) ${ai.bestLap.toFixed(2)} s (reported only)`);
}
if (opt('json')) writeFileSync(opt('json')!, JSON.stringify(out, null, 1));
