// Turn probe ("Handling — low-speed maneuverability" card): can the car make the tightest corner, with turn to spare?
// Usage: npm run turn-probe [-- --physics other-physics.json]   (live config otherwise)
//  1. CORNERS: one AI alone on Oxford (no mistakes), laps 2-3: in each of the slowest corners its minimum speed,
//     path radius there, the steer it used (1 = all the lock the car allows right now), the lock available, and
//     how hard the front and rear tyres were working (slip / peak slip).
//  2. SKIDPAD: a big flat asphalt square; at each speed (held by throttle / brake) every steer input 0.1..1;
//     the tightest steady path radius, and what limits it: the steering LOCK (wheels at the limit, tyres under
//     their peak), the steering ASSIST (the limit cut below mechanical lock), or front GRIP (fronts at / past peak).
//  3. HEADROOM: in a steady corner at the AI's speed and radius in the slowest corner, what 1 s of lifting, of
//     adding full lock, and of both does to the path radius (how much tighter it goes) and the speed.
//  4. LANES: the AI driving 2.5 m inside / outside the racing line (as far as the track allows) at the speeds it
//     plans for the racing line itself, 3 laps each way: walls, off-track laps, stuck, its "trust" in the corner
//     speed (drops when it runs out of road).
import aiJson from '../config/ai.json' with { type: 'json' };
import rules from '../config/rules.json' with { type: 'json' };
import wallTracing from '../config/wall-tracing.json' with { type: 'json' };
import { readFileSync } from 'node:fs';
import { aiInputSource, buildRacingLine, cornersOf, mechLockRad, createSimTrack, createWorld, offsetPath, steerLimit, step, traceWalls, type AiConfig, type CarInput, type PhysicsConfig, type SimContext, type TrackJson, type WorldState } from '../src/sim/index.ts';
import { defaultTrackIdNode, loadTrackNode, simContextNode, surfaces } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const physFile = opt('physics');
const only = opt('only'); // corners | skidpad | headroom | lanes
const loaded = loadTrackNode(defaultTrackIdNode());
const ctx: SimContext = physFile ? simContextNode(loaded, JSON.parse(readFileSync(physFile, 'utf8')) as PhysicsConfig) : simContextNode(loaded);
const phys = ctx.physics;
const line = buildRacingLine(loaded.track)!;
const cfg0 = aiJson as unknown as AiConfig;
const preset = { ...cfg0.presets[cfg0.defaultPreset]!, mistakesPerMin: 0 };
const KPH = 1 / 3.6, DEG = 180 / Math.PI;
const peak = phys.tyres.peakSlipDeg;
const mechLock = (v: number) => mechLockRad(v, phys.steering) * DEG;
const course = (c: { vx: number; vy: number }) => Math.atan2(c.vx, -c.vy);
const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const frontSlip = (c: WorldState['cars'][number]) => Math.max(Math.abs(c.wheels[0]!.slipDeg), Math.abs(c.wheels[1]!.slipDeg)) / peak;
const rearSlip = (c: WorldState['cars'][number]) => Math.max(Math.abs(c.wheels[2]!.slipDeg), Math.abs(c.wheels[3]!.slipDeg)) / peak;
console.log(`physics: lock ${phys.steering.lockDeg} deg, falloff ${phys.steering.lockFalloffKph} kph, low-speed extra ${phys.steering.lowSpeedLockDeg ?? 0} deg fading by ${phys.steering.lowSpeedLockToKph ?? '-'} kph, assist ${phys.steering.assist ? `on (${phys.steering.assistFromKph}-${phys.steering.assistFullKph} kph, x${phys.steering.assistPeakPct} peak)` : 'off'}; tyres peak slip ${peak} deg, falloff ${phys.tyres.falloff} by ${phys.tyres.falloffSlip}x; wheelbase ${phys.car.wheelbaseM} m`);

// ---------- 1. CORNERS ----------
interface CornerStat { q: number; minV: number; R: number; steer: number; lockDeg: number; mechDeg: number; front: number; rear: number }
const cornerStats: CornerStat[] = [];
{
  let w: WorldState = createWorld(ctx, 1);
  const ai = aiInputSource(0, () => ({ world: w, ctx, line }), () => preset, () => cfg0, 5);
  const corners = cornersOf(line);
  const inCorner = (q: number) => corners.findIndex((c) => (c.from <= c.to ? q >= c.from && q <= c.to + 5 : q >= c.from || q <= c.to + 5));
  const best = corners.map(() => ({ minV: Infinity } as CornerStat));
  let lastCourse = course(w.cars[0]!);
  for (let t = 0; t < 60 * 120 && w.cars[0]!.timing.laps < 3; t++) {
    w = step(w, [ai.read(w.tick)], ctx);
    const c = w.cars[0]!, v = Math.hypot(c.vx, c.vy), cc = course(c), dpsi = wrapA(cc - lastCourse);
    lastCourse = cc;
    if (c.timing.laps < 1) continue;
    const k = inCorner(ai.state.near);
    if (k < 0 || v > best[k]!.minV) continue;
    const lim = steerLimit(c, c.controls.steer >= 0 ? 1 : -1, phys);
    best[k] = { q: ai.state.near, minV: v, R: Math.abs(dpsi) > 1e-6 ? (v / 60) / Math.abs(dpsi) : Infinity, steer: Math.abs(c.controls.steer), lockDeg: lim * DEG, mechDeg: mechLock(v), front: frontSlip(c), rear: rearSlip(c) };
  }
  // Also the most steer used anywhere, and how often it was at full lock.
  best.forEach((b) => b.minV < Infinity && cornerStats.push(b));
  cornerStats.sort((a, b) => a.minV - b.minV);
  if (!only || only === 'corners') {
    console.log(`\n1. CORNERS (AI alone, laps 2-3), slowest first: at the minimum speed`);
    console.log('  line pt   kph  path R  steer used  lock avail (mech)  kinematic R at that lock  front slip/peak  rear');
    for (const s of cornerStats.slice(0, 8)) console.log(`  ${String(s.q).padStart(6)}  ${(s.minV / KPH).toFixed(0).padStart(4)}  ${s.R.toFixed(1).padStart(5)} m  ${s.steer.toFixed(2).padStart(9)}  ${s.lockDeg.toFixed(1).padStart(6)} deg (${s.mechDeg.toFixed(1)})  ${(phys.car.wheelbaseM / Math.tan(s.lockDeg / DEG)).toFixed(1).padStart(14)} m  ${s.front.toFixed(2).padStart(15)}  ${s.rear.toFixed(2)}`);
  }
}

// ---------- 2. SKIDPAD ----------
const PPM = 4, W = 500, H = 500;
const idx = (id: string) => surfaces.findIndex((s) => s.id === id);
const data = new Uint8Array(W * PPM * H * PPM).fill(idx('asphalt'));
for (let y = 0; y < H * PPM; y++) for (let x = 0; x < W * PPM; x++) if (x < PPM || y < PPM || x >= (W - 1) * PPM || y >= (H - 1) * PPM) data[y * W * PPM + x] = idx('wall');
const pad: TrackJson = { id: 'skidpad', name: 'skidpad', pxPerMeter: PPM, files: { mask: 'mask.png' }, timingLines: {}, racingLine: [], grid: [], spawn: { x: 250 * PPM, y: 250 * PPM, heading: 0 } };
const padTrack = createSimTrack(pad, { width: W * PPM, height: H * PPM, data }, surfaces);
const arena: SimContext = { ...ctx, track: padTrack, walls: traceWalls(padTrack.mask, padTrack.index.wall, padTrack.index.tyreBarrier, wallTracing), rules };
const holdSpeed = (c: WorldState['cars'][number], vT: number, steer: number): CarInput => {
  const e = vT - Math.hypot(c.vx, c.vy);
  return { throttle: Math.max(0, Math.min(1, 0.25 + 0.5 * e)), brake: e < -0.5 ? Math.min(1, -0.3 * e) : 0, steer };
};
/** Drive `sec` from `w` with `input(car)`; path radius = distance / turned angle over the last `measureSec`. */
function drive(w: WorldState, sec: number, input: (c: WorldState['cars'][number]) => CarInput, measureSec = sec) {
  let dist = 0, turned = 0, last = course(w.cars[0]!), front = 0, rear = 0, n = 0;
  for (let t = 0; t < sec * 60; t++) {
    w = step(w, [input(w.cars[0]!)], arena);
    const c = w.cars[0]!, cc = course(c);
    if (t >= (sec - measureSec) * 60) { dist += Math.hypot(c.vx, c.vy) / 60; turned += wrapA(cc - last); front += frontSlip(c); rear += rearSlip(c); n++; }
    last = cc;
  }
  const c = w.cars[0]!;
  return { w, R: Math.abs(turned) > 1e-6 ? dist / Math.abs(turned) : Infinity, v: Math.hypot(c.vx, c.vy), front: front / Math.max(1, n), rear: rear / Math.max(1, n), wall: c.wallContact, lim: steerLimit(c, 1, phys) * DEG };
}
const startAt = (v: number): WorldState => { const w = createWorld(arena, 1); return { ...w, cars: [{ ...w.cars[0]!, x: 250, y: 250, heading: 0, vx: 0, vy: -v }] }; };
/** Steady circle: settle 6 s at speed v and steer s, measure the last 2 s. */
const steady = (v: number, s: number) => drive(startAt(v), 6, (c) => holdSpeed(c, v, s), 2);
if (!only || only === 'skidpad') {
  console.log(`\n2. SKIDPAD: tightest steady radius at each speed (steer 0.1..1, speed held)`);
  console.log('   kph  tightest R  at steer  speed held  lock avail (mech)  kinematic R  front slip/peak  rear  | full steer: R, front  limit');
  for (const kph of [30, 45, 60, 75, 90, 110, 130, 150]) {
    const v = kph * KPH;
    let bestR = { R: Infinity } as ReturnType<typeof steady> & { s: number };
    for (let s = 0.1; s <= 1.0001; s += 0.05) { const r = steady(v, s); if (!r.wall && r.R < bestR.R && r.v > v * 0.93) bestR = { ...r, s }; }
    const full = steady(v, 1);
    const kin = phys.car.wheelbaseM / Math.tan(bestR.lim / DEG);
    const limit = bestR.front >= 0.9 ? (bestR.s < 0.99 ? 'front GRIP (more steer = past peak, wider)' : 'front GRIP') : bestR.rear >= 0.9 ? 'rear grip (oversteer)' : bestR.lim < mechLock(v) - 1 ? 'steering ASSIST' : 'steering LOCK';
    console.log(`  ${String(kph).padStart(4)}  ${bestR.R.toFixed(1).padStart(8)} m  ${bestR.s.toFixed(2).padStart(8)}  ${(bestR.v / KPH).toFixed(0).padStart(7)} kph  ${bestR.lim.toFixed(1).padStart(6)} deg (${mechLock(v).toFixed(1)})  ${kin.toFixed(1).padStart(9)} m  ${bestR.front.toFixed(2).padStart(15)}  ${bestR.rear.toFixed(2)}  | ${full.R.toFixed(1)} m, ${full.front.toFixed(2)}${full.v < v * 0.93 ? ` (slowed to ${(full.v / KPH).toFixed(0)})` : ''}  ${limit}`);
  }
}

// ---------- 3. HEADROOM ----------
if ((!only || only === 'headroom') && cornerStats.length) {
  const slow = cornerStats[0]!;
  const v0 = slow.minV;
  // The steer that holds the AI's radius there at its speed (on the pad).
  let s0 = 0.1, r0 = steady(v0, 0.1);
  for (let s = 0.1; s <= 1.0001; s += 0.02) { const r = steady(v0, s); if (Math.abs(r.R - slow.R) < Math.abs(r0.R - slow.R)) { s0 = s; r0 = r; } }
  console.log(`\n3. HEADROOM at the slowest corner's AI speed ${(v0 / KPH).toFixed(0)} kph and radius ${slow.R.toFixed(1)} m (steady on the pad at steer ${s0.toFixed(2)}: R ${r0.R.toFixed(1)} m, front ${r0.front.toFixed(2)} of peak)`);
  const base = drive(startAt(v0), 6, (c) => holdSpeed(c, v0, s0));
  const thr = base.w.cars[0]!.controls.throttle;
  const trial = (name: string, f: (c: WorldState['cars'][number]) => CarInput) => {
    const r = drive(base.w, 1, f);
    console.log(`  ${name.padEnd(28)} path R over the 1 s ${r.R.toFixed(1).padStart(5)} m (${((1 - r.R / r0.R) * 100).toFixed(0)}% tighter), speed after ${(r.v / KPH).toFixed(0)} kph, front ${r.front.toFixed(2)} / rear ${r.rear.toFixed(2)} of peak`);
  };
  trial('hold (same inputs)', () => ({ throttle: thr, brake: 0, steer: s0 }));
  trial('lift (throttle off)', () => ({ throttle: 0, brake: 0, steer: s0 }));
  trial('add full lock', () => ({ throttle: thr, brake: 0, steer: 1 }));
  trial('lift + full lock', () => ({ throttle: 0, brake: 0, steer: 1 }));
  trial('brake 30% + full lock', () => ({ throttle: 0, brake: 0.3, steer: 1 }));
  // 20% slower: how tight can it go?
  const v1 = v0 * 0.8;
  let b1 = { R: Infinity } as ReturnType<typeof steady>;
  for (let s = 0.1; s <= 1.0001; s += 0.05) { const r = steady(v1, s); if (!r.wall && r.R < b1.R && r.v > v1 * 0.93) b1 = r; }
  console.log(`  20% slower (${(v1 / KPH).toFixed(0)} kph): tightest steady R ${b1.R.toFixed(1)} m (${((1 - b1.R / slow.R) * 100).toFixed(0)}% tighter than the AI's ${slow.R.toFixed(1)} m)`);
}

// ---------- 4. LANES ----------
if (!only || only === 'lanes') {
  console.log(`\n4. LANES: the AI 2.5 m off the racing line (track allowing), at the racing line's planned speeds, 3 laps`);
  const cfg = { ...cfg0, racecraft: { ...cfg0.racecraft!, enabled: false } } as AiConfig;
  for (const side of [-1, 1]) {
    const off = new Float64Array(line.n);
    for (let q = 0; q < line.n; q++) off[q] = side > 0 ? Math.min(2.5, Math.max(0, line.right[q]! - phys.car.widthM / 2 - 0.5)) : -Math.min(2.5, Math.max(0, line.left[q]! - phys.car.widthM / 2 - 0.5));
    const p = offsetPath(line, off);
    const left = new Float64Array(line.n), right = new Float64Array(line.n);
    for (let q = 0; q < line.n; q++) { left[q] = line.left[q]! + off[q]!; right[q] = line.right[q]! - off[q]!; }
    // Steer along the lane; plan speeds from the racing line's curvature (k).
    const lane = { ...line, x: p.x, y: p.y, k: line.k, left, right };
    let w: WorldState = createWorld(ctx, 1);
    const ai = aiInputSource(0, () => ({ world: w, ctx, line: lane }), () => preset, () => cfg, 9);
    let walls = 0, minTrust = 1, maxSteerSat = 0, invalid = 0;
    for (let t = 0; t < 60 * 150 && w.cars[0]!.timing.laps < 3; t++) {
      const prev = w;
      w = step(w, [ai.read(w.tick)], ctx);
      const c = w.cars[0]!;
      if (c.wallContact && !prev.cars[0]!.wallContact) { walls++; if (process.env.WALLS) console.log(`    wall at line pt ${ai.state.near}, ${(Math.hypot(c.vx, c.vy) / KPH).toFixed(0)} kph, steer ${c.controls.steer.toFixed(2)}, lane offset ${off[ai.state.near]?.toFixed(1)} m, room L/R ${line.left[ai.state.near]?.toFixed(1)}/${line.right[ai.state.near]?.toFixed(1)}`); }
      for (const e of w.events) if (e.type === 'lap' && e.invalid) invalid++;
      minTrust = Math.min(minTrust, ai.state.trust);
      if (Math.abs(c.controls.steer) > 0.98) maxSteerSat++;
    }
    const c = w.cars[0]!;
    console.log(`  ${side > 0 ? 'right' : 'left '} lane: laps ${c.timing.laps}, invalid laps ${invalid}, walls ${walls}, stuck ${ai.state.stuckEvents}, resets ${ai.state.resets}, lowest corner-speed trust ${minTrust.toFixed(3)}, ticks at full lock ${maxSteerSat}`);
  }
}
