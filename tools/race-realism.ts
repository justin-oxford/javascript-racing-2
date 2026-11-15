// AI race realism test suite (card "AI race realism test suite"): judge the AI by how real racing behaves, not by pass
// counts. One command runs every test, each seed as its own process in parallel, and prints one table: each test's
// target and result (median and spread), PASS / MISS (INFO for the counts with no target).
//
// Usage: npm run race-realism -- [--brain rules|lookahead|rules,lookahead] [--seeds 20] [--quick] [--jobs 15]
//          [--tests reverse,pacegrid,long,ladder,defence,split,start] [--set ai.lookahead.x=1 ...] [--out file.json]
//   --quick: fewer seeds and laps (for a fast look while working; the report uses the full run).
//   --set: as ai-run (a config number or word for this run, every worker; "unset" removes the key).
// Worker mode (internal): --worker '<job json>' prints one RESULT line.
// Debug (worker mode): RRTRACE=1 (duel attacker every 0.25 s, laps RRFROM..RRTO), RRLAP=1 (lap times, wear, modes), RRFORM=1 (formation lap).
//
// "Pace" = each car's solo lap (alone, its own driver, no mistakes, best of laps 2-3), measured headless, so it is team
// stats x driver PACE x setup. Targets are the card's proposals: report against them, don't tune blindly to hit them.
import aiJson from '../config/ai.json' with { type: 'json' };
import driversJson from '../config/drivers.json' with { type: 'json' };
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  aiInputSource, assignDrivers, buildRacingLine, createRaceWorld, createWorld, driverPreset, gridOrder, raceResults, resetCar, step,
  type AiConfig, type AiPreset, type CarBuild, type DriverDef, type RacingLine, type SimContext, type WorldState,
} from '../src/sim/index.ts';
import { contactLog } from './contact-split.ts';
import { catalog, loadTrackNode, simContextNode } from './load-track-node.ts';

const ARGS = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = ARGS.indexOf(`--${name}`); return i >= 0 ? ARGS[i + 1]! : def; };
const SETS = ARGS.flatMap((a, i) => (a === '--set' ? [ARGS[i + 1]!] : []));
const ROSTER = (driversJson as { drivers: DriverDef[] }).drivers;

// ---------------------------------------------------------------------------------------------------------------
// Statistics

const sorted = (a: readonly number[]) => [...a].sort((x, y) => x - y);
const quant = (a: readonly number[], p: number) => { const b = sorted(a); if (!b.length) return NaN; const x = (b.length - 1) * p, lo = Math.floor(x); return b[lo]! + (b[Math.min(b.length - 1, lo + 1)]! - b[lo]!) * (x - lo); };
const median = (a: readonly number[]) => quant(a, 0.5);
const mean = (a: readonly number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
/** Spearman rank correlation of two equal-length lists (average ranks for ties). */
function spearman(x: readonly number[], y: readonly number[]): number {
  const rank = (v: readonly number[]) => { const idx = v.map((_, i) => i).sort((a, b) => v[a]! - v[b]!), r = new Array<number>(v.length); for (let k = 0; k < idx.length;) { let j = k; while (j + 1 < idx.length && v[idx[j + 1]!] === v[idx[k]!]) j++; for (let m = k; m <= j; m++) r[idx[m]!] = (k + j) / 2; k = j + 1; } return r; };
  const rx = rank(x), ry = rank(y), mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { num += (rx[i]! - mx) * (ry[i]! - my); dx += (rx[i]! - mx) ** 2; dy += (ry[i]! - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Worker: the sim harness

interface Job { test: string; seed: number; brain: string; track: string; laps: number; cars: number; p?: Record<string, number> }

const TICK = 60;
let ctxCache: { id: string; ctx: SimContext; line: RacingLine; cfg: AiConfig } | undefined;
function setup(job: Job) {
  if (ctxCache?.id === job.track) return ctxCache;
  const loaded = loadTrackNode(job.track), ctx = simContextNode(loaded), cfg = structuredClone(aiJson) as unknown as AiConfig;
  // (value "unset" removes the key: a round-6 switch back to off.)
  const setPath = (root: Record<string, unknown>, path: string[], value: number | string) => { let o = root; for (const k of path.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>; if (value === 'unset') delete o[path.at(-1)!]; else o[path.at(-1)!] = value; };
  for (const s of SETS) {
    const [path, v] = s.split('=') as [string, string];
    const [sec, ...rest] = path.split('.');
    const val = v !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
    if (sec === 'ai') setPath(cfg as unknown as Record<string, unknown>, rest, val);
    else setPath((ctx as unknown as Record<string, Record<string, unknown>>)[sec!]!, rest, val);
  }
  cfg.brain = job.brain as 'rules' | 'lookahead';
  const line = buildRacingLine(loaded.track);
  if (!line) throw new Error(`${job.track}: no racing line`);
  ctxCache = { id: job.track, ctx, line, cfg };
  return ctxCache;
}

/** Signed lateral offset of (x, y) from the line at point q (+ right), metres. */
function latOf(line: RacingLine, q: number, x: number, y: number): number {
  const a = ((q % line.n) + line.n) % line.n, b = (a + 1) % line.n;
  const tx = line.x[b]! - line.x[a]!, ty = line.y[b]! - line.y[a]!, l = Math.hypot(tx, ty) || 1;
  return ((x - line.x[a]!) * -ty + (y - line.y[a]!) * tx) / l;
}
/** The next corner's direction from each line point (+1 right, -1 left), within ~160 m. */
function turnDirs(line: RacingLine): Int8Array {
  const out = new Int8Array(line.n);
  for (let q = 0; q < line.n; q++) for (let d = 0; d < 80; d++) { const k = line.k[(q + d) % line.n]!; if (Math.abs(k) > 0.02) { out[q] = Math.sign(k); break; } }
  return out;
}

/** A car's solo pace: alone, its own driver, no mistakes, best valid lap of laps 2-3 (and its brake onsets, line points). */
function soloPace(ctx: SimContext, line: RacingLine, cfg: AiConfig, build: CarBuild, preset: AiPreset, seed: number, laps = 3): { best: number; laps: number[]; onsets: number[] } {
  let w: WorldState = createWorld(ctx, [build]);
  const d = aiInputSource(0, () => ({ world: w, ctx, line }), () => preset, () => cfg, seed);
  let best = Infinity, was = true;
  const lapTimes: number[] = [], onsets: number[] = [];
  for (let t = 0; t < TICK * 60 * laps && w.cars[0]!.timing.laps < laps; t++) {
    w = step(w, [d.read(w.tick)], ctx);
    for (const e of w.events) if (e.type === 'lap' && !e.invalid && w.cars[0]!.timing.laps > 1) { best = Math.min(best, e.time); lapTimes.push(e.time); }
    const braking = w.cars[0]!.controls.brake > 0.3;
    if (braking && !was && w.cars[0]!.timing.laps >= 1 && d.state.mode === 'race') onsets.push(d.state.near);
    was = braking;
  }
  return { best, laps: lapTimes, onsets };
}

type Drivers = ReturnType<typeof aiInputSource>[];
interface PassEv { tick: number; winner: number; loser: number; lap: number; cause: 'clean' | 'mistake' | 'pit' | 'lap1'; cluster: number; cutback: boolean }
interface StuckEv { car: number; tick: number; cause: string }

/**
 * Run a race and record what every test needs. grid[slot] = car. presets per car. Returns the race's events.
 */
function runRace(job: Job, builds: CarBuild[], presets: AiPreset[], grid: number[] | undefined, o: { maxSec?: number; stopWhen?: (w: WorldState) => boolean; duel?: { attacker: number; defender: number; defOnsets: number[]; formation?: boolean } } = {}) {
  const { ctx, line, cfg } = setup(job);
  const L = line.length, n = builds.length, turn = turnDirs(line);
  let w: WorldState = createRaceWorld(ctx, builds, { laps: job.laps, seed: job.seed, ...(grid ? { grid } : {}) });
  // Rolling start (test 5): lap one is a formation lap behind the defender at a safety-car speed (margins x 0.55,
  // throttle 0.6); the attacker follows in line on the rules (no pass offset, no mistakes). The duel starts at the line.
  const fm = o.duel?.formation ? o.duel : undefined, form = () => !!fm && (w.race?.cars[fm.defender]?.progress ?? 1) < 1;
  // (The grid is 2-wide: the attacker starts beside the defender, so it holds back at half throttle until it's in line
  // behind, a car length and more.)
  const fPre = presets.map((p, i) => (!fm ? p : i === fm.defender ? { ...p, cornerMargin: p.cornerMargin * 0.55, brakeMargin: p.brakeMargin * 0.55, throttleCap: 0.6, mistakesPerMin: 0 } : { ...p, overtakeOffsetM: 0, mistakesPerMin: 0 }));
  const fBack = fm ? { ...fPre[fm.attacker]!, throttleCap: 0.4 } : undefined;
  let fInLine = false;
  const formPre = (i: number) => { if (!fm || i !== fm.attacker) return fPre[i]!; if (!fInLine && ((w.race?.cars[fm.defender]?.progress ?? 0) - (w.race?.cars[fm.attacker]?.progress ?? 0)) * line.length > ctx.physics.car.lengthM + 1.5) fInLine = true; return fInLine ? fPre[i]! : fBack!; };
  const fCfg: AiConfig = { ...cfg, brain: 'rules' };
  // (No dirty-air tyre wear on the formation lap: behind a safety car it costs nothing; at 13x wear, one lap in line
  // took 7% off the follower's rears before the duel began.)
  const fCtx: SimContext = { ...ctx, slipstream: { ...ctx.slipstream, dirtyAir: { ...ctx.slipstream.dirtyAir, wearMul: 0 } } };
  const drivers: Drivers = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => (form() ? formPre(i) : presets[i]!), () => (form() && i === fm!.attacker ? fCfg : cfg), job.seed * 1000 + i));
  const log = contactLog(ctx);
  const passes: PassEv[] = [], stuck: StuckEv[] = [], lapping: { lapper: number; tick: number; lap: number }[] = [];
  const pairSign = new Map<number, number>(), lapSign = new Map<number, number>();
  const lastMistakeTick = new Array<number>(n).fill(-1e9), mistakesSeen = new Array<number>(n).fill(0), stuckSeen = new Array<number>(n).fill(0);
  const lastPitTick = new Array<number>(n).fill(-1e9), contactTick = new Array<number>(n).fill(-1e9);
  /** Per car, lap index -> {time, pit lap?, lapping events}. */
  const laps: { time: number; lap: number; pit: boolean; lapped: number }[][] = builds.map(() => []);
  const pitThisLap = new Array<boolean>(n).fill(false), lappedThisLap = new Array<number>(n).fill(0);
  const posAtLap1: number[] = new Array<number>(n).fill(-1);
  // History at 10 Hz for the cutback check: lateral offset, turn direction, covering.
  const hist: { lat: number; turn: number; cover: boolean }[][] = builds.map(() => []);
  // Progress snapshots at 10 Hz (for clusters around heavy hits).
  const snaps: { tick: number; p: number[] }[] = [];
  let t1Abreast = 0;
  // Turn one: the first corner after the start line, its apex (tightest point).
  let t1q = 0; while (t1q < line.n && Math.abs(line.k[t1q]!) <= 0.02) t1q++;
  let t1apex = t1q, km = 0; for (let q = t1q; q < t1q + 40 && Math.abs(line.k[q % line.n]!) > 0.01; q++) if (Math.abs(line.k[q % line.n]!) > km) { km = Math.abs(line.k[q % line.n]!); t1apex = q; }
  const t1M = (t1apex * L) / line.n;
  // Duel (defence quality): the defender's lateral moves away from the line per straight, early brakes.
  const dq = { straights: 0, multiMove: 0, unthreatMoves: 0, threatMoves: 0, earlyBrakes: 0, earlyBrakeHits: 0, defLapsClose: [] as number[], defLapsAll: [] as number[], closeLaps: 0, lapsCounted: 0, zoneGaps: [] as number[], zoneMin: [] as number[] };
  let aLastBrake = -1e9, zMin = Infinity, zOpen = false;
  let dMoves = 0, dAnchor = 0, dDir = 0, dLastBrake = -1e9, dEarlyAt = -1e9, dThreat = false;
  let closeLaps = 0, lapsCounted = 0;
  const maxTicks = TICK * (o.maxSec ?? job.laps * 60 + 300);
  for (let tick = 0; tick < maxTicks; tick++) {
    w = step(w, drivers.map((d) => d.read(w.tick)), form() ? fCtx : ctx);
    log.tick(w);
    const r = w.race!, r0 = r;
    for (const e of w.events) if (e.type === 'lap' && o.duel && e.car === o.duel.defender && e.lap > 1) {
      const A = o.duel.attacker, gapM = (r0.cars[e.car]!.progress - r0.cars[A]!.progress) * L, v = Math.max(5, Math.hypot(w.cars[e.car]!.vx, w.cars[e.car]!.vy));
      lapsCounted++; if (gapM > 0 && gapM / v < 1) closeLaps++;
      if (process.env.RRLAP) console.log(`lap ${e.lap} gapM ${gapM.toFixed(1)} v ${v.toFixed(1)} pD ${r0.cars[e.car]!.progress.toFixed(3)} pA ${r0.cars[A]!.progress.toFixed(3)}`);
    }
    for (const e of w.events) if (e.type === 'lap') {
      if (process.env.RRLAP) { const st = drivers[e.car]!.state; console.log(`LAP car ${e.car} lap ${e.lap} ${e.time.toFixed(3)} wear ${w.cars[e.car]!.wheels.map((x) => x.wear.toFixed(3)).join(",")} craft ${JSON.stringify(st.craftTicks)} lineChanges ${st.lineChanges} mistakes ${st.mistakes}`); }
      laps[e.car]!.push({ time: e.invalid ? NaN : e.time, lap: e.lap, pit: pitThisLap[e.car]!, lapped: lappedThisLap[e.car]! });
      pitThisLap[e.car] = false; lappedThisLap[e.car] = 0;
    }
    const prog = r.cars.map((c) => c.progress);
    if (process.env.RRFORM && fm && tick % 60 === 0 && prog[fm.defender]! < 1.3) console.log(`form t ${tick / TICK} pD ${prog[fm.defender]!.toFixed(3)} gap ${((prog[fm.defender]! - prog[fm.attacker]!) * L).toFixed(1)} vD ${Math.hypot(w.cars[fm.defender]!.vx, w.cars[fm.defender]!.vy).toFixed(1)} vA ${Math.hypot(w.cars[fm.attacker]!.vx, w.cars[fm.attacker]!.vy).toFixed(1)} inLine ${fInLine} phase ${r.phase}`);
    for (let i = 0; i < n; i++) {
      const st = drivers[i]!.state, c = w.cars[i]!;
      if (st.mistakes > mistakesSeen[i]!) { mistakesSeen[i] = st.mistakes; lastMistakeTick[i] = tick; }
      if (st.mistake?.active || st.recoverTicks > 0) lastMistakeTick[i] = Math.max(lastMistakeTick[i]!, tick);
      if (c.inPitLane) { lastPitTick[i] = tick; pitThisLap[i] = true; }
      if (c.carContact) contactTick[i] = tick;
      if (st.stuckEvents > stuckSeen[i]!) {
        stuckSeen[i] = st.stuckEvents;
        const cause = prog[i]! < 1 ? 'lap 1' : tick - lastMistakeTick[i]! < TICK * 8 ? `after ${st.lastMistake || 'a recovery'}` : tick - contactTick[i]! < TICK * 3 ? 'car contact' : c.wallContact ? 'wall' : 'none';
        stuck.push({ car: i, tick, cause });
      }
      if (posAtLap1[i]! < 0 && prog[i]! >= 1) posAtLap1[i] = r.order.indexOf(i);
    }
    if (tick % 6 === 0) {
      snaps.push({ tick, p: prog });
      for (let i = 0; i < n; i++) {
        const st = drivers[i]!.state, c = w.cars[i]!, q = Math.max(0, st.near);
        const h = hist[i]!; h.push({ lat: st.mode === 'race' ? latOf(line, q, c.x, c.y) : 0, turn: turn[q]!, cover: st.defence === 'cover' || ((st as { defPlan?: { cover: boolean } }).defPlan?.cover ?? false) });
        if (h.length > 50) h.shift();
      }
    }
    // Lap one: the most cars abreast (within a car length along the line) in the run to turn one's apex.
    if (r.phase === 'racing' && Math.min(...prog) < 1) {
      // (Moving cars past the start line only: the grid itself is 2-wide.)
      const into = prog.map((p, c) => (Math.hypot(w.cars[c]!.vx, w.cars[c]!.vy) > 8 && p > 0 ? p * L : -1e9)).filter((m) => m > t1M - 50 && m < t1M);
      const s = sorted(into);
      for (let a = 0; a < s.length; a++) { let b = a; while (b + 1 < s.length && s[b + 1]! - s[a]! < ctx.physics.car.lengthM) b++; t1Abreast = Math.max(t1Abreast, b - a + 1); }
    }
    if (r.phase === 'racing' || r.phase === 'finishing') {
      for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
        if (r.cars[a]!.finished || r.cars[b]!.finished) continue;
        const dd = prog[a]! - prog[b]!, key = a * 100 + b, k = Math.round(dd);
        if (k === 0) {
          const dM = dd * L;
          if (Math.abs(dM) > 25) { pairSign.delete(key); continue; }
          if (Math.abs(dM) < 0.5) continue;
          const sg = Math.sign(dM), was = pairSign.get(key);
          pairSign.set(key, sg);
          if (was !== undefined && was !== sg) {
            const winner = sg > 0 ? a : b, loser = sg > 0 ? b : a;
            const pit = [a, b].some((c) => tick - lastPitTick[c]! < TICK * 15);
            const cause = prog[winner]! < 1 ? 'lap1' : pit ? 'pit' : tick - lastMistakeTick[loser]! < TICK * 5 ? 'mistake' : 'clean';
            const cluster = prog.filter((p, c) => !r.cars[c]!.finished && Math.abs(p - prog[winner]!) * L < 15).length;
            // Cutback: the loser covering the inside, the winner on the outside of that corner, in the last 4 s.
            const hw = hist[winner]!, hl = hist[loser]!, m = Math.min(hw.length, hl.length, 40);
            let cutback = false;
            for (let s = 1; s <= m; s++) { const x = hw[hw.length - s]!, y = hl[hl.length - s]!; if (y.cover && x.turn !== 0 && x.lat * x.turn < -0.8) { cutback = true; break; } }
            passes.push({ tick, winner, loser, lap: Math.floor(prog[winner]!), cause, cluster, cutback });
          }
        } else if (Math.abs(k) >= 1) {
          // Lapping: the road order of two cars a lap (or more) apart flips.
          const dM = (dd - k) * L, lk = key + 50000;
          if (Math.abs(dM) > 25) { lapSign.delete(lk); continue; }
          if (Math.abs(dM) < 0.5) continue;
          const sg = Math.sign(dM), was = lapSign.get(lk);
          lapSign.set(lk, sg);
          if (was !== undefined && was !== sg) {
            const lapper = dd > 0 ? a : b, back = lapper === a ? b : a;
            if ((dd > 0 ? sg > 0 : sg < 0) && tick - lastPitTick[back]! > TICK * 5) { lapping.push({ lapper, tick, lap: Math.floor(prog[lapper]!) }); lappedThisLap[lapper]!++; }
          }
        }
      }
      // Duel: the defender's moves away from the line on each straight (segment between its brake onsets).
      if (o.duel && prog[o.duel.defender]! >= 1) {
        const D = o.duel.defender, A = o.duel.attacker, st = drivers[D]!.state, c = w.cars[D]!;
        const gapM = (prog[D]! - prog[A]!) * L, v = Math.max(5, Math.hypot(c.vx, c.vy)), threat = gapM > 0 && gapM / v < 1.5;
        const lat = latOf(line, Math.max(0, st.near), c.x, c.y);
        const braking = c.controls.brake > 0.3;
        // A new braking zone: braking again after at least 1.5 s off the brakes (trail braking flickers).
        if (braking && tick - dLastBrake > TICK * 1.5) {
          // A new braking zone: close the straight.
          if (dThreat) { dq.straights++; if (dMoves >= 2) dq.multiMove++; }
          dMoves = 0; dAnchor = lat; dDir = 0; dThreat = false;
          // Earlier than its own solo onset into this zone by more than 5 m, with the attacker within 1 s.
          const p = st.near, solo = o.duel.defOnsets.map((q) => { let d = p - q; d = ((d % line.n) + line.n) % line.n; return d > line.n / 2 ? d - line.n : d; }).filter((d) => Math.abs(d) < 15).sort((x, y) => Math.abs(x) - Math.abs(y))[0];
          if (solo !== undefined && solo * 2 < -5 && gapM > 0 && gapM / v < 1) { dq.earlyBrakes++; dEarlyAt = tick; }
        }
        if (braking) dLastBrake = tick;
        if (threat) dThreat = true;
        // A move: 1 m further from the line than where this one started, in a new direction.
        const away = Math.abs(lat) - Math.abs(dAnchor), dir = Math.sign(lat - dAnchor);
        // (Only where the road is straight: through a corner the car cuts in and out of the line by itself.)
        const straightHere = [0, 3, 6].every((d) => Math.abs(line.k[(Math.max(0, st.near) + d) % line.n]!) < 0.01);
        if (!straightHere) dAnchor = lat;
        else if (away > 1 && dir !== dDir) { dMoves++; dDir = dir; dAnchor = lat; if (threat) dq.threatMoves++; else dq.unthreatMoves++; }
        else if (Math.abs(lat) < Math.abs(dAnchor)) dAnchor = lat; // back toward the line: re-anchor
        if (c.carContact && tick - dEarlyAt < TICK * 2) { dq.earlyBrakeHits++; dEarlyAt = -1e9; }
        // The attacker's gap into each braking zone (bumper to bumper, along the line) at its brake onset, following in
        // line (within 40 m, less than a car width + 0.2 m across).
        // (In the attacker's own frame: along its heading and across it; the line's projection is metres out in corners.)
        const ca = w.cars[A]!, aBrake = ca.controls.brake > 0.3, hx = Math.sin(ca.heading), hy = -Math.cos(ca.heading);
        const lonA = (c.x - ca.x) * hx + (c.y - ca.y) * hy, latAD = -(c.x - ca.x) * hy + (c.y - ca.y) * hx, inLineA = lonA > 0 && Math.abs(latAD) < ctx.physics.car.widthM + 0.2;
        if (aBrake && tick - aLastBrake > TICK * 1.5 && prog[A]! >= 1 && lonA > 0 && lonA < 40) {
          if (inLineA) { dq.zoneGaps.push(lonA - ctx.physics.car.lengthM); zOpen = true; zMin = Infinity; }
        }
        // ...and the closest it gets through that zone (onset to back on the throttle), still behind and in line.
        if (zOpen) {
          if (inLineA) zMin = Math.min(zMin, lonA - ctx.physics.car.lengthM);
          if ((ca.controls.throttle > 0.5 && !aBrake) || lonA <= 0) { if (Number.isFinite(zMin)) dq.zoneMin.push(zMin); zOpen = false; }
        }
        if (aBrake) aLastBrake = tick;
        if (process.env.RRTRACE && tick % 15 === 0 && prog[A]! >= Number(process.env.RRFROM ?? 1) && prog[A]! < Number(process.env.RRTO ?? 4)) { const sa = drivers[A]!.state, dg = sa.diag; console.log(`t ${(tick / TICK).toFixed(2)} q ${sa.near} gap ${(gapM - ctx.physics.car.lengthM).toFixed(1)} vA ${Math.hypot(ca.vx, ca.vy).toFixed(1)} vD ${v.toFixed(1)} prof ${dg.profileV.toFixed(1)} traf ${dg.trafficV.toFixed(1)} late ${dg.late.toFixed(2)} craft ${sa.craft}/${drivers[D]!.state.craft} ers ${ca.ers.deploying ? 'A' : '-'}${c.ers.deploying ? 'D' : '-'} tow ${ca.tow.toFixed(2)} mode ${dg.engineMode}/${drivers[D]!.state.diag.engineMode} brIn ${sa.brakeInSec.toFixed(2)} thr ${ca.controls.throttle.toFixed(2)} brk ${ca.controls.brake.toFixed(2)} dirty ${ca.dirtyAir.toFixed(3)} trust ${sa.trust.toFixed(3)} lat ${(latOf(line, Math.max(0, sa.near), ca.x, ca.y) - lat).toFixed(1)} off ${sa.offset.toFixed(2)} latA ${latOf(line, Math.max(0, sa.near), ca.x, ca.y).toFixed(2)} mk ${sa.mistake?.kind ?? "-"} plan ${sa.passTarget}`); }
      }
    }
    if (o.stopWhen?.(w)) break;
    if (r.phase === 'results') break;
  }
  log.finish();
  // Heavy hits inside a cluster of 3+ cars.
  const heavyInc = log.incidents.filter((i) => i.peakMps >= log.thresholdMps);
  const clusterHeavy = heavyInc.filter((inc) => { const s = snaps.reduce((b, x) => (Math.abs(x.tick - inc.startTick) < Math.abs(b.tick - inc.startTick) ? x : b), snaps[0]!); const pa = s.p[inc.a]!; return s.p.filter((p) => Math.abs(p - pa) * L < 15).length >= 3; }).length;
  return { w, drivers, passes, stuck, lapping, laps, posAtLap1, t1Abreast, closeLaps, lapsCounted, heavy: heavyInc.length, taps: log.taps, clusterHeavy, incidents: log.incidents, dq };
}

/** Race metrics every test reports. */
function common(res: ReturnType<typeof runRace>) {
  const clean = res.passes.filter((p) => p.cause === 'clean');
  // Back markers: each lapping lap's time vs the lapper's median clean lap (no pit, no lapping, valid).
  const lapLoss: number[] = [];
  res.laps.forEach((ls) => {
    const base = median(ls.filter((l) => !l.pit && !l.lapped && Number.isFinite(l.time) && l.lap > 1).map((l) => l.time));
    for (const l of ls) if (l.lapped && !l.pit && Number.isFinite(l.time) && Number.isFinite(base)) lapLoss.push((l.time - base) / l.lapped);
  });
  return {
    heavy: res.heavy, taps: res.taps, stuck: res.stuck.length, stuckCauses: res.stuck.map((s) => s.cause),
    passesClean: clean.length, passesAll: res.passes.length, passesMistake: res.passes.filter((p) => p.cause === 'mistake').length,
    multiPasses: clean.filter((p) => p.cluster >= 3).length, clusterHeavy: res.clusterHeavy, cutbacks: clean.filter((p) => p.cutback).length,
    lapLoss, stops: mean(res.drivers.map((d) => d.state.pitStops)),
  };
}

/** Team-stats field: one car per team, roster drivers by seed (as ai-run). */
function teamField(job: Job) {
  const { ctx, cfg } = setup(job);
  const builds: CarBuild[] = Array.from({ length: job.cars }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i % catalog.teams.length]!.id }));
  const lineup = assignDrivers(ROSTER, job.cars, job.seed);
  const base = cfg.presets[cfg.defaultPreset]!;
  const presets = builds.map((_, i) => driverPreset(base, lineup[i], cfg.skill?.spread ?? 0));
  return { builds, lineup, presets };
}
function paces(job: Job, builds: CarBuild[], presets: AiPreset[]) {
  const { ctx, line, cfg } = setup(job);
  return builds.map((b, i) => soloPace(ctx, line, cfg, b, { ...presets[i]!, mistakesPerMin: 0 }, job.seed * 1000 + i).best);
}

function runJob(job: Job): Record<string, unknown> {
  const { ctx, line, cfg } = setup(job);
  switch (job.test) {
    case 'reverse': case 'pacegrid': case 'long': {
      const { builds, presets, lineup } = teamField(job);
      const pace = paces(job, builds, presets);
      const byPace = pace.map((_, i) => i).sort((a, b) => pace[a]! - pace[b]!);
      const fastest = byPace[0]!;
      const grid = job.test === 'reverse' ? [...gridOrder(job.cars, job.seed).filter((c) => c !== fastest), fastest] : job.test === 'pacegrid' ? byPace : gridOrder(job.cars, job.seed);
      const res = runRace(job, builds, presets, grid);
      const fin = raceResults(res.w.race!).map((x) => x.car);
      if (process.env.RRDBG) for (const row of raceResults(res.w.race!)) console.log(`pos ${row.pos} car ${row.car} ${lineup[row.car]!.code} pace ${pace[row.car]!.toFixed(2)} (rank ${byPace.indexOf(row.car) + 1}) grid ${grid.indexOf(row.car) + 1} laps ${row.laps} fin ${row.finished} stops ${row.pitStops} stuck ${res.drivers[row.car]!.state.stuckEvents} mistakes ${res.drivers[row.car]!.state.mistakes} resets ${row.resets} raceBest ${Math.min(...res.laps[row.car]!.map((l) => l.time).filter(Number.isFinite)).toFixed(2)} raceMed ${median(res.laps[row.car]!.map((l) => l.time).filter(Number.isFinite)).toFixed(2)} pitlaps ${res.laps[row.car]!.filter((l) => l.pit).map((l) => l.lap).join(",")}`);
      const startPos = (c: number) => grid.indexOf(c);
      return {
        ...common(res), soloMean: mean(pace.filter(Number.isFinite)), fastestFinish: fin.indexOf(fastest) + 1,
        spearmanStart: spearman(fin.map((_, k) => k), fin.map(startPos)), spearmanPace: spearman(fin.map((_, k) => k), fin.map((c) => byPace.indexOf(c))),
        lap1: lap1Stats(res, grid, lineup.map((d) => d.aggression)),
      };
    }
    case 'start': {
      const { builds, presets, lineup } = teamField(job);
      const grid = gridOrder(job.cars, job.seed);
      const res = runRace(job, builds, presets, grid, { stopWhen: (w) => Math.min(...w.race!.cars.map((c) => c.progress)) > 1.2, maxSec: 200 });
      return { ...common(res), lap1: lap1Stats(res, grid, lineup.map((d) => d.aggression)) };
    }
    case 'ladder': case 'defence': {
      // Two identical cars, same team, no roster: the defender slowed by gap s a lap (its margins scaled down).
      const build: CarBuild = { ...ctx.physics.defaultCar, team: catalog.teams[0]!.id };
      const base = cfg.presets[cfg.defaultPreset]!;
      const gap = job.p?.gap ?? 0;
      const slow = (f: number): AiPreset => ({ ...base, cornerMargin: base.cornerMargin * f, brakeMargin: base.brakeMargin * f });
      const lap = (f: number) => soloPace(ctx, line, cfg, build, { ...slow(f), mistakesPerMin: 0 }, 7).best;
      const l0 = lap(1);
      let f = 1;
      if (gap > 0) { let lo = 0.6, hi = 1; for (let k = 0; k < 9; k++) { const mid = (lo + hi) / 2; if (lap(mid) - l0 > gap) lo = mid; else hi = mid; } f = (lo + hi) / 2; }
      const realGap = lap(f) - l0;
      const defPreset = slow(f), defSolo = soloPace(ctx, line, cfg, build, defPreset, job.seed * 1000 + 1, job.laps);
      // Car 0 attacker (slot 2), car 1 defender (pole).
      const res = runRace(job, [build, build], [base, defPreset], [1, 0], { duel: { attacker: 0, defender: 1, defOnsets: defSolo.onsets, formation: job.test === 'defence' } });
      const prog = (k: number) => res.w.race!.cars[k]!.progress;
      const after1 = res.passes.filter((p) => p.lap >= 1 && p.lap < 6 && p.winner === 0);
      const startSwap = res.posAtLap1[0] === 0;
      const defLaps = res.laps[1]!.filter((l) => l.lap > 1 && Number.isFinite(l.time)).map((l) => l.time);
      const closeShare = res.closeLaps / Math.max(1, res.lapsCounted);
      return {
        ...common(res), gap: realGap, f, startSwap,
        passedIn5: !startSwap && after1.length > 0, passes: res.passes.filter((p) => p.lap >= 1).length,
        passCauses: res.passes.filter((p) => p.lap >= 1).map((p) => p.cause),
        closeShare, defCost: median(defLaps) - median(defSolo.laps.filter((_, k) => k >= 0)), finalAhead: prog(0) > prog(1),
        dq: res.dq,
      };
    }
    case 'split': {
      return splitScenario(job);
    }
    case 'determinism': {
      const { builds, presets } = teamField(job);
      const once = () => { const r = runRace({ ...job, laps: 3 }, builds, presets, undefined); return JSON.stringify({ c: r.w.cars, o: r.w.race!.order, t: r.w.tick }); };
      return { same: once() === once() };
    }
    case 'bench': {
      const out: Record<string, number> = {};
      for (const cars of [10, 20]) {
        const j = { ...job, cars, laps: 50 }, { builds, presets } = teamField(j);
        let w: WorldState = createRaceWorld(ctx, builds, { laps: 50, seed: job.seed });
        const ds = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => presets[i]!, () => cfg, job.seed * 1000 + i));
        for (let t = 0; t < TICK * 120 && !(w.race!.phase === 'racing' && Math.min(...w.race!.cars.map((c) => c.progress)) > 1.05); t++) w = step(w, ds.map((d) => d.read(w.tick)), ctx);
        const sec = 60, t0 = performance.now();
        for (let t = 0; t < TICK * sec; t++) w = step(w, ds.map((d) => d.read(w.tick)), ctx);
        const ms = performance.now() - t0;
        out[`x${cars}`] = (sec * 1000) / ms; out[`ms${cars}`] = ms / (TICK * sec);
      }
      return out;
    }
  }
  throw new Error(`unknown test ${job.test}`);
}

/** Lap one: places gained by the end of lap 1 (grid slot - position), turn one abreast, contacts per car on lap 1. */
function lap1Stats(res: ReturnType<typeof runRace>, grid: number[], aggression: number[]) {
  const gained = res.posAtLap1.map((p, c) => (p < 0 ? 0 : grid.indexOf(c) - p));
  const lap1Ticks = res.w.race ? res.w.race.startTime * TICK + 60 * 40 : 0;
  const contacts = gained.map((_, c) => res.incidents.filter((i) => (i.a === c || i.b === c) && i.startTick < lap1Ticks).length);
  const heavy = res.incidents.filter((i) => i.peakMps >= 12 && i.startTick < lap1Ticks).length;
  return { gained, aggression, contacts, abreast: res.t1Abreast, heavy, stuck: res.stuck.filter((s) => s.cause === 'lap 1').length };
}

/**
 * SPLIT: car A (AI) behind B and C, which run side by side (3 m apart, centres) at a capped speed down Oxford's main
 * straight. With A within 15 m, B moves right: wide (the middle gap a car width + 1.5 m) or narrow (1.6 m, under a
 * car width). Did A go through the middle, round the outside, or stay behind; any heavy hit.
 */
function splitScenario(job: Job) {
  const { ctx, line, cfg } = setup(job);
  const wide = (job.p?.wide ?? 1) > 0;
  const ppm = ctx.track.json.pxPerMeter, phys = ctx.physics;
  const build: CarBuild = { ...phys.defaultCar, team: catalog.teams[0]!.id };
  const slow: CarBuild = { ...phys.defaultCar, team: catalog.teams[1]!.id };
  const base = cfg.presets[cfg.defaultPreset]!;
  // The longest straight (start of it).
  let bestS = 0, bestLen = 0, s = -1;
  for (let q = 0; q < line.n * 2; q++) { const k = Math.abs(line.k[q % line.n]!); if (k < 0.006) { if (s < 0) s = q; if (q - s > bestLen) { bestLen = q - s; bestS = s % line.n; } } else s = -1; }
  const pose = (q: number, lat: number) => {
    const a = ((q % line.n) + line.n) % line.n, b = (a + 1) % line.n, tx = line.x[b]! - line.x[a]!, ty = line.y[b]! - line.y[a]!, l = Math.hypot(tx, ty) || 1;
    const nx = -ty / l, ny = tx / l;
    return { x: (line.x[a]! + nx * lat) * ppm, y: (line.y[a]! + ny * lat) * ppm, heading: Math.atan2(tx, -ty) };
  };
  const [r1] = [((job.seed * 2654435761) >>> 0) / 4294967296];
  const sep0 = 3.0, sepFinal = wide ? phys.car.widthM + phys.car.widthM + 1.5 : phys.car.widthM + 1.6;
  const cap = 15 + r1 * 3;
  let w: WorldState = createWorld(ctx, [build, slow, slow]);
  const startB = bestS + 4, startA = bestS - 22;
  w = resetCar(w, 0, pose(startA, 0), ctx);
  w = resetCar(w, 1, pose(startB, sep0 / 2), ctx);
  w = resetCar(w, 2, pose(startB, -sep0 / 2), ctx);
  const ds = [0, 1, 2].map((i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => (i === 0 ? base : { ...base, mistakesPerMin: 0 }), () => cfg, job.seed * 1000 + i));
  const log = contactLog(ctx);
  let cued = false, offB = sep0 / 2;
  let outcome = 'behind', latAtPass: number | undefined;
  const along = (i: number, j: number) => { const ci = w.cars[i]!, cj = w.cars[j]!, q = Math.max(0, ds[i]!.state.near), a = q % line.n, b = (a + 1) % line.n, tx = line.x[b]! - line.x[a]!, ty = line.y[b]! - line.y[a]!, l = Math.hypot(tx, ty) || 1; return ((cj.x - ci.x) * tx + (cj.y - ci.y) * ty) / l; };
  for (let t = 0; t < TICK * 25; t++) {
    // B and C hold their lanes (B moves on cue) at the capped speed.
    if (!cued && t > 30 && along(0, 1) < 15) cued = true;
    if (cued) offB = Math.min(sepFinal - sep0 / 2, offB + 3 / TICK);
    ds[1]!.state.offset = offB; ds[2]!.state.offset = -sep0 / 2;
    const inputs = ds.map((d, i) => {
      const inp = d.read(w.tick), c = w.cars[i]!, v = Math.hypot(c.vx, c.vy);
      return i > 0 && v > cap ? { ...inp, throttle: 0, brake: Math.min(0.5, (v - cap) * 0.2) } : inp;
    });
    w = step(w, inputs, ctx);
    log.tick(w);
    const aB = along(0, 1), aC = along(0, 2);
    if (latAtPass === undefined && Math.max(aB, aC) < phys.car.lengthM * 0.5 && Math.min(aB, aC) > -phys.car.lengthM) {
      const lat = (k: number) => latOf(line, Math.max(0, ds[k]!.state.near), w.cars[k]!.x, w.cars[k]!.y), la = lat(0), lb = lat(1), lc = lat(2);
      latAtPass = (la - lb) * (la - lc) < 0 ? 0 : 1;
    }
    if (process.env.SPLITDBG && t % 15 === 0) console.log(`t ${(t / TICK).toFixed(2)} aB ${aB.toFixed(1)} aC ${aC.toFixed(1)} vA ${Math.hypot(w.cars[0]!.vx, w.cars[0]!.vy).toFixed(1)} vB ${Math.hypot(w.cars[1]!.vx, w.cars[1]!.vy).toFixed(1)} latA ${latOf(line, Math.max(0, ds[0]!.state.near), w.cars[0]!.x, w.cars[0]!.y).toFixed(1)} latB ${latOf(line, Math.max(0, ds[1]!.state.near), w.cars[1]!.x, w.cars[1]!.y).toFixed(1)} latC ${latOf(line, Math.max(0, ds[2]!.state.near), w.cars[2]!.x, w.cars[2]!.y).toFixed(1)} nearA ${ds[0]!.state.near} cued ${cued}`);
    if (aB < -phys.car.lengthM && aC < -phys.car.lengthM) { outcome = latAtPass === 0 ? 'middle' : 'outside'; break; }
    if (ds[0]!.state.near > (bestS + bestLen + 15) % line.n && ds[0]!.state.near < (bestS + bestLen + 40) % line.n) break;
  }
  log.finish();
  return { wide, outcome, heavy: log.heavy, taps: log.taps, gapM: sepFinal - phys.car.widthM };
}

// ---------------------------------------------------------------------------------------------------------------
// Orchestrator

function jobsFor(brain: string, seeds: number, quick: boolean, tests: Set<string>): Job[] {
  const J: Job[] = [];
  const S = (k: number) => Array.from({ length: Math.max(1, k) }, (_, i) => i + 1);
  const raceLaps = quick ? 8 : 20;
  if (tests.has('reverse')) {
    for (const seed of S(seeds)) J.push({ test: 'reverse', seed, brain, track: 'oxford', laps: raceLaps, cars: 10 });
    for (const seed of S(quick ? 3 : 10)) J.push({ test: 'reverse', seed, brain, track: 'indiana', laps: raceLaps, cars: 10 });
  }
  if (tests.has('pacegrid')) for (const seed of S(seeds)) J.push({ test: 'pacegrid', seed, brain, track: 'oxford', laps: raceLaps, cars: 10 });
  if (tests.has('long')) for (const seed of S(quick ? 2 : 8)) J.push({ test: 'long', seed, brain, track: 'oxford', laps: quick ? 30 : 100, cars: 10 });
  if (tests.has('ladder')) for (const gap of [0.2, 0.5, 1, 2]) for (const seed of S(seeds * 2)) J.push({ test: 'ladder', seed, brain, track: 'oxford', laps: 7, cars: 2, p: { gap } });
  if (tests.has('defence')) for (const seed of S(seeds * 2)) J.push({ test: 'defence', seed, brain, track: 'oxford', laps: 11, cars: 2, p: { gap: 0 } });
  if (tests.has('split')) for (const wide of [1, 0]) for (const seed of S(seeds)) J.push({ test: 'split', seed, brain, track: 'oxford', laps: 1, cars: 3, p: { wide } });
  if (tests.has('start')) {
    for (const seed of S(seeds)) J.push({ test: 'start', seed: seed + 100, brain, track: 'oxford', laps: 3, cars: 10 });
    for (const seed of S(quick ? 3 : 10)) J.push({ test: 'start', seed: seed + 100, brain, track: 'indiana', laps: 3, cars: 10 });
  }
  if (tests.has('determinism')) J.push({ test: 'determinism', seed: 3, brain, track: 'oxford', laps: 3, cars: 6 });
  return J;
}

async function runPool(jobs: Job[], width: number): Promise<{ job: Job; out: Record<string, unknown> | undefined; err?: string }[]> {
  const self = fileURLToPath(import.meta.url), results: { job: Job; out: Record<string, unknown> | undefined; err?: string }[] = [];
  // Longest first (the long races, then the 20-lap races).
  const weight = (j: Job) => j.laps * j.cars;
  const queue = [...jobs].sort((a, b) => weight(b) - weight(a));
  let done = 0;
  const runOne = (job: Job) => new Promise<void>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', self, '--worker', JSON.stringify(job), ...SETS.flatMap((s) => ['--set', s])], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      const m = out.match(/^RESULT (.*)$/m);
      results.push({ job, out: m ? (JSON.parse(m[1]!) as Record<string, unknown>) : undefined, ...(m ? {} : { err: err.slice(-800) }) });
      done++;
      if (done % 10 === 0 || done === jobs.length) process.stderr.write(`  ${done}/${jobs.length} done\n`);
      resolve();
    });
  });
  const lanes = Array.from({ length: Math.min(width, queue.length) }, async () => { while (queue.length) await runOne(queue.shift()!); });
  await Promise.all(lanes);
  return results;
}

interface Row { test: string; metric: string; target: string; value: string; verdict: 'PASS' | 'MISS' | 'INFO' }
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-'), f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(100 * x)}%` : '-');
const spread = (a: number[], f = f1) => `${f(median(a))} [${f(quant(a, 0.25))}–${f(quant(a, 0.75))}]`;
const verdict = (ok: boolean): 'PASS' | 'MISS' => (ok ? 'PASS' : 'MISS');
const count = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'; };

function summarise(results: { job: Job; out: Record<string, unknown> | undefined }[]): { rows: Row[]; raw: Record<string, unknown> } {
  const rows: Row[] = [];
  type O = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const of = (test: string, track = 'oxford', p?: (j: Job) => boolean) => results.filter((r) => r.out && r.job.test === test && r.job.track === track && (!p || p(r.job))).map((r) => r.out as O);
  const add = (test: string, metric: string, target: string, value: string, v: Row['verdict']) => rows.push({ test, metric, target, value, verdict: v });
  const all: O[] = results.filter((r) => r.out && ['reverse', 'pacegrid', 'long', 'start', 'ladder', 'defence'].includes(r.job.test)).map((r) => r.out as O);
  // 1. Reverse grid.
  for (const track of ['oxford', 'indiana']) {
    const rv = of('reverse', track);
    if (!rv.length) continue;
    const pos = rv.map((o) => o.fastestFinish as number), top5 = pos.filter((p) => p <= 5).length / pos.length;
    const t = `1. Reverse grid${track === 'indiana' ? ' (Indiana)' : ''}`;
    add(t, 'fastest car from last: finishing position', 'median 3–5 or better', `${spread(pos, (x) => x.toFixed(0))} (n ${pos.length})`, verdict(median(pos) <= 5));
    add(t, 'share finishing top 5', 'most seeds (> 50%)', pct(top5), verdict(top5 > 0.5));
  }
  // 2. Pace-order grid.
  const pg = of('pacegrid');
  if (pg.length) {
    const p = pg.map((o) => o.passesClean as number), sp = pg.map((o) => o.spearmanStart as number);
    add('2. Pace-order grid', 'on-track passes per race (no pit cycles, mistakes, lap 1)', 'near 0 (median ≤ 1)', spread(p), verdict(median(p) <= 1));
    add('2. Pace-order grid', 'finish vs start order (Spearman)', '≈ start order (≥ 0.9)', spread(sp, f2), verdict(median(sp) >= 0.9));
  }
  // 3. Long race.
  const lg = of('long');
  if (lg.length) {
    const sp = lg.map((o) => o.spearmanPace as number);
    add('3. Long race (100 laps, pit stops)', 'finish vs pace order (Spearman)', '≥ 0.8', `${spread(sp, f2)} (n ${lg.length})`, verdict(median(sp) >= 0.8));
    add('3. Long race (100 laps, pit stops)', 'pit stops per car', 'real stops (> 0)', spread(lg.map((o) => o.stops as number)), verdict(median(lg.map((o) => o.stops as number)) > 0));
  }
  // 4. Pace-gap ladder.
  const ld = results.filter((r) => r.out && r.job.test === 'ladder');
  if (ld.length) {
    const share: number[] = [];
    for (const gap of [0.2, 0.5, 1, 2]) {
      const g = ld.filter((r) => r.job.p?.gap === gap).map((r) => r.out as O).filter((o) => !o.startSwap);
      const s = g.filter((o) => o.passedIn5).length / Math.max(1, g.length);
      share.push(s);
      add('4. Pace-gap ladder', `${gap} s/lap quicker (real ${f2(median(g.map((o) => o.gap as number)))}): passed within 5 laps`, gap === 0.2 ? 'rare (≤ 25%)' : gap === 2 ? 'likely (≥ 60%)' : 'rises with the gap', `${pct(s)} (n ${g.length})`, gap === 0.2 ? verdict(s <= 0.25) : gap === 2 ? verdict(s >= 0.6) : 'INFO');
    }
    for (const gap of [0.2, 0.5, 1, 2]) {
      const g = ld.filter((r) => r.job.p?.gap === gap).map((r) => r.out as O).filter((o) => !o.startSwap), z = g.flatMap((o) => o.dq.zoneGaps as number[]);
      add('4. Pace-gap ladder', `${gap} s/lap: gap at the brake onset, in line (bumper, m): median [IQR] / min`, 'report', `${spread(z)} / ${f1(Math.min(...z))} (n ${z.length})`, 'INFO');
      const zm = g.flatMap((o) => o.dq.zoneMin as number[]);
      add('4. Pace-gap ladder', `${gap} s/lap: closest through the braking zone, in line (bumper, m): median [IQR] / min`, 'report', `${spread(zm)} / ${f1(Math.min(...zm))} (n ${zm.length})`, 'INFO');
    }
    add('4. Pace-gap ladder', 'chance rises with the gap', 'non-decreasing (±10%)', share.map(pct).join(' → '), verdict(share.every((x, k) => k === 0 || x >= share[k - 1]! - 0.1)));
  }
  // 5. Equal-car defence.
  const df = of('defence').filter((o) => !o.startSwap);
  if (df.length) {
    const withPass = df.filter((o) => o.passes > 0).length / df.length;
    const causes = df.flatMap((o) => o.passCauses as string[]), mist = causes.filter((c) => c === 'mistake' || c === 'pit').length / Math.max(1, causes.length);
    add('5. Equal-car defence', 'races with a pass (10 laps)', 'rare (≤ 30%)', `${pct(withPass)} (n ${df.length}; causes: ${count(causes)})`, verdict(withPass <= 0.3));
    add('5. Equal-car defence', 'passes after a mistake / pit', 'mostly (≥ 50%)', causes.length ? pct(mist) : 'no passes', causes.length ? verdict(mist >= 0.5) : 'PASS');
    add('5. Equal-car defence', 'laps with the attacker within 1 s at the line', 'the setup (most laps)', spread(df.map((o) => o.closeShare as number), pct), 'INFO');
    add('5. Equal-car defence', "defender's lap time vs its solo (s)", 'measurable (≥ +0.05 s)', spread(df.map((o) => o.defCost as number), f2), verdict(median(df.map((o) => o.defCost as number)) >= 0.05));
  }
  // 6. Defence quality (all duels).
  const duels = results.filter((r) => r.out && (r.job.test === 'ladder' || r.job.test === 'defence')).map((r) => r.out as O);
  if (duels.length) {
    const s = (k: string) => duels.reduce((a, o) => a + (o.dq[k] as number), 0);
    add('6. Defence quality (duels)', 'straights with 2+ moves (threatened)', '0 (≤ 2% of straights)', `${s('multiMove')} of ${s('straights')}`, verdict(s('multiMove') <= 0.02 * Math.max(1, s('straights'))));
    add('6. Defence quality (duels)', 'moves with no car within 1.5 s', 'covers only when threatened (≤ 10% of moves)', `${s('unthreatMoves')} of ${s('unthreatMoves') + s('threatMoves')}`, verdict(s('unthreatMoves') <= 0.1 * Math.max(1, s('unthreatMoves') + s('threatMoves'))));
    add('6. Defence quality (duels)', 'brakes > 5 m before its own point with the attacker within 1 s / then contact', 'never causes a hit', `${s('earlyBrakes')} / ${s('earlyBrakeHits')}`, verdict(s('earlyBrakeHits') === 0));
    const dh = duels.reduce((a, o) => a + (o.heavy as number), 0);
    add('6. Defence quality (duels)', 'heavy hits in duels', '0', `${dh} in ${duels.length} duels`, verdict(dh === 0));
  }
  // 7. Split.
  const sp = results.filter((r) => r.out && r.job.test === 'split').map((r) => r.out as O);
  if (sp.length) {
    const w = sp.filter((o) => o.wide), nn = sp.filter((o) => !o.wide);
    const mid = w.filter((o) => o.outcome === 'middle').length / Math.max(1, w.length);
    add('7. Split (B moves right)', `middle gap ${f1(w[0]?.gapM ?? NaN)} m: through the middle`, 'goes through (≥ 60%)', `${pct(mid)} (${count(w.map((o) => o.outcome))})`, verdict(mid >= 0.6));
    const nh = nn.reduce((a, o) => a + (o.heavy as number), 0), nmid = nn.filter((o) => o.outcome === 'middle').length;
    add('7. Split (B moves right)', `middle gap ${f1(nn[0]?.gapM ?? NaN)} m: backs out`, 'no heavy hit, not through the middle', `heavy ${nh}, middle ${nmid} (${count(nn.map((o) => o.outcome))})`, verdict(nh === 0 && nmid === 0));
    add('7. Split (B moves right)', 'heavy hits (wide case)', '0', String(w.reduce((a, o) => a + (o.heavy as number), 0)), verdict(w.reduce((a, o) => a + (o.heavy as number), 0) === 0));
  }
  // 8 / 9. Multi-car battles and crossovers (races).
  const races = results.filter((r) => r.out && ['reverse', 'pacegrid', 'long'].includes(r.job.test) && r.job.track === 'oxford').map((r) => r.out as O);
  if (races.length) {
    const mp = races.map((o) => o.multiPasses as number), ch = races.reduce((a, o) => a + (o.clusterHeavy as number), 0), hv = races.reduce((a, o) => a + (o.heavy as number), 0);
    add('8. Multi-car battles (races)', 'clean passes with 3+ cars within 15 m, per race', 'count', spread(mp), 'INFO');
    add('8. Multi-car battles (races)', 'heavy hits in those clusters / all heavy hits', 'count', `${ch} / ${hv} in ${races.length} races`, 'INFO');
    add('9. Crossovers (races)', 'cutback passes (defender covering, attacker wide on entry)', 'nice to see', `${races.reduce((a, o) => a + (o.cutbacks as number), 0)} in ${races.length} races`, 'INFO');
  }
  // 10. Race start.
  for (const track of ['oxford', 'indiana']) {
    const st = [...of('start', track)];
    if (!st.length) continue;
    const t = `10. Race start${track === 'indiana' ? ' (Indiana)' : ''}`;
    const L = st.map((o) => o.lap1 as O);
    const spreadOk = L.filter((l) => Math.max(...(l.gained as number[])) >= 2 && Math.min(...(l.gained as number[])) <= -2).length / L.length;
    const ab = L.map((l) => l.abreast as number), wide2 = ab.filter((a) => a >= 2).length / ab.length, wide3 = ab.filter((a) => a >= 3).length / ab.length;
    const ag = L.flatMap((l) => l.aggression as number[]), gn = L.flatMap((l) => l.gained as number[]), ct = L.flatMap((l) => l.contacts as number[]);
    const rG = spearman(ag, gn), rC = spearman(ag, ct), hv = L.reduce((a, l) => a + (l.heavy as number), 0), stk = L.reduce((a, l) => a + (l.stuck as number), 0);
    add(t, 'launch spread: someone gains ≥ 2 and someone loses ≥ 2 places', 'in most starts (> 50%)', `${pct(spreadOk)} (n ${L.length})`, verdict(spreadOk > 0.5));
    add(t, '2-wide / 3-wide into turn 1', 'a good share (2-wide ≥ 50%)', `${pct(wide2)} / ${pct(wide3)}`, verdict(wide2 >= 0.5));
    add(t, 'aggression vs places gained (Spearman, per car)', '> 0', f2(rG), verdict(rG > 0));
    add(t, 'aggression vs lap-1 contacts (Spearman, per car)', '> 0', f2(rC), verdict(rC > 0));
    add(t, 'lap-1 heavy hits per start / stuck cars', 'few (≤ 0.2) / none', `${f2(hv / L.length)} / ${stk}`, verdict(hv / L.length <= 0.2 && stk === 0));
  }
  // 11. Back markers.
  const loss = results.filter((r) => r.out && (r.job.test === 'long' || r.job.test === 'reverse') && r.job.track === 'oxford').flatMap((r) => (r.out as O).lapLoss as number[]);
  if (loss.length) add('11. Back markers', 'time lost per lapped car (s)', 'under ~1 s (median)', `${spread(loss, f2)} (n ${loss.length})`, verdict(median(loss) < 1));
  // Every test: heavy hits, stuck by cause, solo lap, determinism.
  if (all.length) {
    const racesAll = results.filter((r) => r.out && ['reverse', 'pacegrid', 'long'].includes(r.job.test)).map((r) => ({ j: r.job, o: r.out as O }));
    const hpr = racesAll.map(({ j, o }) => (o.heavy as number) / (j.laps / 20)), spr = racesAll.map(({ j, o }) => (o.stuck as number) / (j.laps / 20));
    add('All races', 'heavy hits per 20 laps', 'report', spread(hpr), 'INFO');
    add('All races', 'stuck events per 20 laps (by cause)', 'report', `${spread(spr)} (${count(racesAll.flatMap(({ o }) => o.stuckCauses as string[]))})`, 'INFO');
    const solo = results.filter((r) => r.out && r.job.test === 'reverse' && r.job.track === 'oxford').map((r) => (r.out as O).soloMean as number);
    if (solo.length) add('All races', 'solo lap time (mean of the field, Oxford)', 'unchanged', `${f2(mean(solo))} s`, 'INFO');
  }
  const det = results.find((r) => r.out && r.job.test === 'determinism');
  if (det) add('All', 'determinism (same seed twice)', 'identical', (det.out as O).same ? 'identical' : 'DIFFERENT', verdict(!!(det.out as O).same));
  const bench = results.find((r) => r.out && r.job.test === 'bench');
  if (bench) { const b = bench.out as O; add('All', 'headless speed, 10 / 20 cars (x real time; sim + AI ms per tick)', 'report', `${f1(b.x10)}x / ${f1(b.x20)}x (${f2(b.ms10)} / ${f2(b.ms20)} ms)`, 'INFO'); }
  return { rows, raw: { results } };
}

async function main() {
  if (ARGS[0] === '--worker') {
    const job = JSON.parse(ARGS[1]!) as Job;
    console.log(`RESULT ${JSON.stringify(runJob(job))}`);
    return;
  }
  const brains = opt('brain', 'rules').split(',');
  const quick = ARGS.includes('--quick');
  const seeds = Number(opt('seeds', quick ? '6' : '20'));
  const width = Number(opt('jobs', String(Math.max(1, cpus().length - 1))));
  const tests = new Set(opt('tests', 'reverse,pacegrid,long,ladder,defence,split,start,determinism').split(','));
  const tables: Record<string, Row[]> = {}, raw: Record<string, unknown> = {};
  for (const brain of brains) {
    const t0 = performance.now(), jobs = jobsFor(brain, seeds, quick, tests);
    process.stderr.write(`${brain}: ${jobs.length} jobs on ${width} processes\n`);
    const res = await runPool(jobs, width);
    const failed = res.filter((r) => !r.out);
    for (const f of failed) process.stderr.write(`FAILED ${JSON.stringify(f.job)}\n${f.err}\n`);
    // Speed alone, after the pool (a loaded machine would understate it).
    if (!tests.has('nobench')) res.push(...(await runPool([{ test: 'bench', seed: 1, brain, track: 'oxford', laps: 50, cars: 10 }], 1)));
    const s = summarise(res);
    tables[brain] = s.rows; raw[brain] = s.raw;
    process.stderr.write(`${brain}: ${((performance.now() - t0) / 1000).toFixed(0)} s, ${failed.length} failed\n`);
  }
  // One table: each row, every brain side by side.
  const first = tables[brains[0]!]!;
  const head = ['test', 'metric', 'target', ...brains.flatMap((b) => [b, ''])];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  first.forEach((r, k) => lines.push(`| ${r.test} | ${r.metric} | ${r.target} | ${brains.map((b) => { const x = tables[b]![k]; return x ? `${x.value} | ${x.verdict}` : '- | -'; }).join(' | ')} |`));
  console.log(lines.join('\n'));
  const out = opt('out', '');
  if (out) writeFileSync(out, JSON.stringify({ args: ARGS, tables, raw }, null, 1));
}
void main();
