// Mid-corner mistake probe (card "AI: pass when the car ahead slows mid-corner"): a leader and a follower 12 m behind,
// both on the racing line at the planned speed before a corner; mid-corner the leader makes a mistake (scripted: held
// to --frac (0.55) of its planned speed for --slow (1.5) s, its own steering kept), then drives on. Did the follower take the place
// within 4 s, and was there contact / a heavy hit? Every corner of the track, seeds x both brains.
// Usage: npm run midcorner-probe -- [--track oxford] [--seeds 4] [--set ai.midCorner.enabled=true ...]
import aiJson from '../config/ai.json' with { type: 'json' };
import {
  aiInputSource, buildRacingLine, cornersOf, createWorld, normalizeSetup, speedProfile, cornerTable, buildStats, step,
  type AiConfig, type CarInput, type WorldState,
} from '../src/sim/index.ts';
import { contactLog } from './contact-split.ts';
import { catalog, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const track = opt('track', 'oxford'), seeds = Number(opt('seeds', '4')), slowSec = Number(opt('slow', '1.5')), slowFrac = Number(opt('frac', '0.55'));
const L = loadTrackNode(track), ctx = simContextNode(L), line = buildRacingLine(L.track)!;
const base = structuredClone(aiJson) as unknown as AiConfig;
for (const [k, a] of args.entries()) if (a === '--set') { const [path, v] = args[k + 1]!.split('='); const ks = path!.split('.').slice(1); let o = base as unknown as Record<string, unknown>; for (const x of ks.slice(0, -1)) o = o[x] as Record<string, unknown>; o[ks[ks.length - 1]!] = v === 'true' ? true : v === 'false' ? false : Number(v); }
const build = { ...ctx.physics.defaultCar, setup: normalizeSetup(L.track.json.baseSetup ?? ctx.physics.defaultCar.setup, catalog.specs.setup) };
const pre = { ...base.presets[base.defaultPreset]!, mistakesPerMin: 0 };
const v = speedProfile(line.x, line.y, ctx.physics, buildStats(build, catalog), { cornerMargin: pre.cornerMargin, brakeMargin: pre.brakeMargin, fuelKg: ctx.physics.fuel.startKg / 2, table: base.measuredLimits ? cornerTable(ctx, build) : undefined });
const n = line.n, wrap = (q: number) => ((q % n) + n) % n;
const tan = (q: number) => Math.atan2(line.x[wrap(q + 1)]! - line.x[q]!, -(line.y[wrap(q + 1)]! - line.y[q]!));
const corners = cornersOf(line).filter((c) => { let k = 0; for (let q = c.from; q !== wrap(c.to + 1); q = wrap(q + 1)) k = Math.max(k, Math.abs(line.k[q]!)); return k > 1 / 60; });
const near = (x: number, y: number, h: number) => { let b = h, bd = Infinity; for (let d = -10; d <= 30; d++) { const q = wrap(h + d), e = (line.x[q]! - x) ** 2 + (line.y[q]! - y) ** 2; if (e < bd) { bd = e; b = q; } } return b; };

const rows: Array<{ brain: string; corner: number; pass: boolean; heavy: number; taps: number }> = [];
for (const brain of ['rules', 'lookahead'] as const) {
  const cfg = { ...base, brain };
  for (const c of corners) for (let s = 1; s <= seeds; s++) {
    const qL = wrap(c.from - 2), qF = wrap(qL - 6);
    const place = (q: number) => ({ x: line.x[q]!, y: line.y[q]!, heading: tan(q), vx: Math.sin(tan(q)) * v[q]!, vy: -Math.cos(tan(q)) * v[q]! });
    let w: WorldState = createWorld(ctx, [build, build]);
    w = { ...w, cars: [{ ...w.cars[0]!, ...place(qL) }, { ...w.cars[1]!, ...place(qF) }] };
    const dL = aiInputSource(0, () => ({ world: w, ctx, line }), () => pre, () => cfg, s * 31);
    const dF = aiInputSource(1, () => ({ world: w, ctx, line }), () => pre, () => cfg, s * 37 + 1);
    const log = contactLog(ctx);
    let hL = qL, hF = qF, lapL = 0, lapF = 0, mistakeFrom = -1;
    const apex = wrap(Math.round((c.from + (c.to >= c.from ? c.to : c.to + n)) / 2));
    for (let t = 0; t < 60 * 8; t++) {
      const inL = dL.read(w.tick);
      if (mistakeFrom < 0 && hL === apex) mistakeFrom = t;
      const mistake = mistakeFrom >= 0 && t - mistakeFrom < slowSec * 60;
      // The mistake: held to slowFrac of its planned speed (throttle off, brakes on above it), its own steering kept.
      const sp = Math.hypot(w.cars[0]!.vx, w.cars[0]!.vy), cap = v[hL]! * slowFrac;
      const input: CarInput = mistake ? { ...inL, throttle: sp < cap - 0.5 ? 0.5 : 0, brake: sp > cap + 0.5 ? 0.6 : 0 } : inL;
      w = step(w, [input, dF.read(w.tick)], ctx);
      log.tick(w);
      const nL = near(w.cars[0]!.x, w.cars[0]!.y, hL), nF = near(w.cars[1]!.x, w.cars[1]!.y, hF);
      if (nL < hL - n / 2) lapL++; if (nF < hF - n / 2) lapF++;
      hL = nL; hF = nF;
      if (process.env.MCDBG && brain === process.env.MCDBG && c === corners[Number(process.env.MCC ?? 0)] && s === 1 && t % 10 === 0 && mistakeFrom >= 0) {
        const a = w.cars[0]!, b = w.cars[1]!, st = dF.state;
        console.log(t - mistakeFrom, 'L', (Math.hypot(a.vx, a.vy) * 3.6).toFixed(0), 'F', (Math.hypot(b.vx, b.vy) * 3.6).toFixed(0), 'gap', Math.hypot(a.x - b.x, a.y - b.y).toFixed(1), 'F offset', st.offset.toFixed(2), 'passTarget', st.passTarget, 'side', st.passSide, 'aim', st.passOffsetM?.toFixed(2), 'profV', (st.diag.profileV * 3.6).toFixed(0), 'trafV', (st.diag.trafficV * 3.6).toFixed(0), 'allowed', (st.lastAllowed * 3.6).toFixed(0), 'mode', st.mode);
      }
      if (mistakeFrom >= 0 && t - mistakeFrom > (slowSec + 4) * 60) break;
    }
    const progL = lapL * n + hL, progF = lapF * n + hF;
    (log as { finish?: () => void }).finish?.();
    const heavy = log.incidents.filter((i) => i.peakMps >= log.thresholdMps).length;
    rows.push({ brain, corner: c.from, pass: progF > progL, heavy, taps: log.incidents.length - heavy });
  }
}
console.log(`Mid-corner mistake probe, ${track}: ${corners.length} corners x ${seeds} seeds; leader held to ${slowFrac} of its planned speed for ${slowSec} s from the apex${args.includes('--set') ? `; ${args.filter((a, i) => args[i - 1] === '--set').join(' ')}` : ''}`);
for (const brain of ['rules', 'lookahead']) {
  const r = rows.filter((x) => x.brain === brain);
  console.log(`  ${brain}: follower took the place ${r.filter((x) => x.pass).length}/${r.length} (${((100 * r.filter((x) => x.pass).length) / r.length).toFixed(0)}%), heavy hits ${r.reduce((a, x) => a + x.heavy, 0)}, taps ${r.reduce((a, x) => a + x.taps, 0)}`);
}
