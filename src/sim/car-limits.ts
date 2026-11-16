// The car's MEASURED cornering limits (card "AI speed plan from the car's measured limits"). The analytic speed plan
// assumed both axles reach their limit together; on this car the fronts saturate first, so it planned the tight
// hairpins ~15% too fast. Instead: drive the real car model on a flat pad and record, at each speed, the tightest
// steady circle it holds (steer refined, speed held on the throttle). Whichever axle, the steering lock or the assist
// limits it, the table says so. The plan reads corner speed (and the cornering grip left for braking) from it.
// Pure and deterministic (same physics -> same table on every client); cached per car build + physics.
import { buildStats } from './car-config';
import { carTurnRadiusM, type CornerTable } from './line-optimizer';
export type { CornerTable } from './line-optimizer';
import { createPhysicsCache } from './planck-cache';
import { createSimTrack, type SurfaceDef, type TrackJson } from './track';
import type { CarBuild, CarState, WorldState } from './types';
import { createWorld, step, type SimContext } from './world';


/** Speeds the table is measured at, kph. */
const KPH = [25, 40, 55, 70, 85, 105, 130, 160, 200, 250, 300];
const SIZE_M = 600;
const tables = new Map<string, CornerTable>();
let padCache: { key: string; track: ReturnType<typeof createSimTrack> } | undefined;

function padTrack(surfaces: readonly SurfaceDef[]) {
  const key = surfaces.map((s) => s.id).join(',');
  if (padCache?.key === key) return padCache.track;
  const asphalt = surfaces.findIndex((s) => s.id === 'asphalt');
  const data = new Uint8Array(SIZE_M * SIZE_M).fill(asphalt);
  const json: TrackJson = { id: '_pad', name: '_pad', pxPerMeter: 1, files: { mask: '' }, timingLines: {}, racingLine: [], grid: [], spawn: { x: SIZE_M / 2, y: SIZE_M / 2, heading: 0 } };
  const track = createSimTrack(json, { width: SIZE_M, height: SIZE_M, data }, surfaces);
  padCache = { key, track };
  return track;
}

/** The cache key: everything about the car the table depends on. */
function keyOf(ctx: Pick<SimContext, 'physics' | 'catalog'>, ref: CarBuild): string {
  const p = ctx.physics;
  return JSON.stringify([ref, p.car, p.engine, p.brakes, p.aero, p.tyres, p.steering, p.traction, p.input, p.fuel.startKg, ctx.catalog.specs.setup, ctx.catalog.specs.specs[ref.spec] ?? null, ctx.catalog.teams.find((t) => t.id === ref.team) ?? null]);
}
/** The car the table is measured on: this build's spec, setup and Equal flag on the default car's team (other teams'
 *  grip and downforce multipliers scale through the model). */
const refBuild = (ctx: Pick<SimContext, 'physics'>, build: CarBuild): CarBuild => ({ ...build, team: ctx.physics.defaultCar.team });

/** One steady run: start at speed v heading up, hold v on the throttle at steer s; radius over the last second. */
function steady(pad: SimContext, build: CarBuild, v: number, s: number): { R: number; v: number } {
  let w: WorldState = createWorld(pad, [build]);
  const c0 = w.cars[0]!;
  w = { ...w, cars: [{ ...c0, x: SIZE_M / 2, y: SIZE_M / 2, heading: 0, vx: 0, vy: -v } as CarState] };
  const course = (c: { vx: number; vy: number }) => Math.atan2(c.vx, -c.vy);
  let last = course(w.cars[0]!), dist = 0, turned = 0;
  const SETTLE = 120, MEASURE = 45;
  for (let t = 0; t < SETTLE + MEASURE; t++) {
    const c = w.cars[0]!, e = v - Math.hypot(c.vx, c.vy);
    w = step(w, [{ throttle: Math.max(0, Math.min(1, 0.25 + 0.5 * e)), brake: e < -0.5 ? Math.min(1, -0.3 * e) : 0, steer: s }], pad);
    const c2 = w.cars[0]!, cc = course(c2);
    if (t >= SETTLE) { dist += Math.hypot(c2.vx, c2.vy) / 60; let d = cc - last; d = Math.atan2(Math.sin(d), Math.cos(d)); turned += d; }
    last = cc;
  }
  const c = w.cars[0]!;
  return { R: Math.abs(turned) > 1e-6 ? dist / Math.abs(turned) : Infinity, v: Math.hypot(c.vx, c.vy) };
}

/** Measure (or fetch the cached) corner table for this car build in this context's physics. */
export function cornerTable(ctx: Pick<SimContext, 'physics' | 'catalog' | 'track'> & Partial<SimContext>, buildIn: CarBuild): CornerTable {
  const build = refBuild(ctx, buildIn);
  const key = keyOf(ctx, build);
  const hit = tables.get(key);
  if (hit) return hit;
  const track = padTrack(ctx.track.surfaces);
  const pad = { ...(ctx as SimContext), track, walls: [], cache: createPhysicsCache(), evolution: { ...(ctx as SimContext).evolution, enabled: false } } as SimContext;
  const vTop = (ctx.physics.engine.topSpeedKph / 3.6) * buildStats(build, ctx.catalog).topSpeed;
  const stats = buildStats(build, ctx.catalog);
  const v: number[] = [], r: number[] = [];
  for (const kph of KPH) {
    const sp = kph / 3.6;
    if (sp > vTop * 0.97) break;
    // The radius falls with steer until the fronts pass their peak (or the lock runs out), then flattens or widens:
    // a coarse scan, then a golden-section refine round the best.
    const at = (s: number) => { const o = steady(pad, build, sp, s); return o.v > sp * 0.93 ? o.R : Infinity; };
    let bestS = 1, bestR = Infinity;
    for (const s of [0.35, 0.6, 0.8, 1]) { const R = at(s); if (R < bestR) { bestR = R; bestS = s; } }
    let lo = Math.max(0.05, bestS - 0.2), hi = Math.min(1, bestS + 0.2);
    for (let k = 0; k < 4; k++) {
      const a = hi - (hi - lo) * 0.618, b = lo + (hi - lo) * 0.618, ra = at(a), rb = at(b);
      if (ra < bestR) { bestR = ra; bestS = a; }
      if (rb < bestR) { bestR = rb; bestS = b; }
      if (ra < rb) hi = b; else lo = a;
    }
    if (!Number.isFinite(bestR)) continue;
    v.push(sp); r.push(bestR);
  }
  // Monotone (a faster speed never turns tighter than a slower one): a running max.
  for (let i = 1; i < r.length; i++) r[i] = Math.max(r[i]!, r[i - 1]!);
  const ratio = v.map((sp, i) => r[i]! / carTurnRadiusM(sp, ctx.physics, stats).radiusM);
  const table = { v, r, ratio };
  if (tables.size > 64) tables.clear();
  tables.set(key, table);
  return table;
}

