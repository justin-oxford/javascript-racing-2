// Pass execution probe (AI overtaking card): duels in Equal mode (identical cars), live config.
// A quicker attacker (pace 85) starts right behind a slower defender (pace 40, and its corner and braking
// margins x --slow, or with identical cars it never gets close), rolling, on the main straight.
// Does it get by, how often does it commit to a move and complete it, does it touch, and does aggression
// (how early it pulls out, how close it follows; a low-aggression defender concedes) change it?
// Usage: npm run pass-probe [-- --laps 3 --slow 0.9]   (env TRACE=1 / TRACE=2: attacker state every 0.5 s / every
// 5 ticks during a committed move; LAPS=1: lap times and battery; HITS=1: each contact's geometry)
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, createWorld, driverPreset, step, type AiConfig, type DriverStats, type WorldState } from '../src/sim/index.ts';
import { defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: number) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };
const laps = opt('laps', 3), slowBy = opt('slow', 0.9);
const loaded = loadTrackNode(defaultTrackIdNode());
const ctx = simContextNode(loaded);
const line = buildRacingLine(loaded.track)!;
const cfg = aiJson as unknown as AiConfig;
const base = { ...cfg.presets[cfg.defaultPreset]!, mistakesPerMin: 0 };
const { spawn, pxPerMeter: ppm } = ctx.track.json;
const f = { x: Math.sin(spawn.heading), y: -Math.cos(spawn.heading) };

function duel(attacker: DriverStats, defender: DriverStats, gapM: number, v: number) {
  const build = { ...ctx.physics.defaultCar, equalise: 1 };
  let w: WorldState = createWorld(ctx, [build, build]);
  const place = (c: WorldState['cars'][number], back: number) => ({ ...c, x: spawn.x / ppm - f.x * back, y: spawn.y / ppm - f.y * back, heading: spawn.heading, vx: f.x * v, vy: f.y * v });
  w = { ...w, cars: [place(w.cars[0]!, 60), place(w.cars[1]!, 60 + gapM)] }; // car 0 = defender ahead, car 1 = attacker
  const dp = driverPreset(base, defender, cfg.skill?.spread ?? 0);
  const presets = [{ ...dp, cornerMargin: dp.cornerMargin * slowBy, brakeMargin: dp.brakeMargin * slowBy }, driverPreset(base, attacker, cfg.skill?.spread ?? 0)];
  const ai = [0, 1].map((i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => presets[i]!, () => cfg, 77 + i));
  // Distance round the line, continuous (from the AI's nearest line point, wrapping; the cars start just before it).
  const lapsDone = [0, 0], lastNear = [-1, -1];
  const prog = (i: number) => {
    const n = ai[i]!.state.near;
    if (lastNear[i]! < 0 && n > line.n / 2) lapsDone[i] = -1;
    if (lastNear[i]! >= 0 && n < lastNear[i]! - line.n / 2) lapsDone[i]!++;
    if (n >= 0) lastNear[i] = n;
    return lapsDone[i]! * line.n + Math.max(0, n);
  };
  let contacts = 0, ahead = false, firstPassSec = -1, sumGap = 0, nGap = 0;
  for (let t = 0; t < 60 * 40 * laps && w.cars[0]!.timing.laps < laps; t++) {
    const prev = w;
    w = step(w, ai.map((d) => d.read(w.tick)), ctx);
    if (w.cars[1]!.carContact && !prev.cars[1]!.carContact) {
      contacts++;
      if (process.env.HITS) {
        const a = w.cars[1]!, d = w.cars[0]!, fx = Math.sin(a.heading), fy = -Math.cos(a.heading);
        const lon = (d.x - a.x) * fx + (d.y - a.y) * fy, lat = -(d.x - a.x) * fy + (d.y - a.y) * fx;
        console.log(`hit t=${(t / 60).toFixed(1)} near ${ai[1]!.state.near} lon ${lon.toFixed(1)} lat ${lat.toFixed(1)} vA ${Math.hypot(a.vx, a.vy).toFixed(1)} vD ${Math.hypot(d.vx, d.vy).toFixed(1)} offA ${ai[1]!.state.offset.toFixed(2)} offD ${ai[0]!.state.offset.toFixed(2)} tgt ${ai[1]!.state.passTarget} side ${ai[1]!.state.passSide}`);
      }
    }
    const gap = (prog(0) - prog(1)) * 2;
    if (process.env.LAPS) for (const e of w.events) if (e.type === 'lap') console.log('lap car', e.car, e.time.toFixed(2), 'wear', w.cars[e.car]!.wheels.map((x) => Math.round(x.wear * 1000) / 10).join('/'), 'deploying', w.cars.map((c) => c.ers.deploying).join('/'), 'batt', w.cars.map((c) => c.ers.batteryKJ.toFixed(0)).join('/'));
    if (process.env.TRACE && (t % 30 === 0 || (process.env.TRACE === '2' && ai[1]!.state.passTarget >= 0 && t % 5 === 0)) && t < 60 * 45) console.log((t / 60).toFixed(1), 'gap', gap, 'v', w.cars.map((c) => Math.hypot(c.vx, c.vy).toFixed(1)).join('/'), 'craft', ai[1]!.state.craft, 'off', ai[1]!.state.offset.toFixed(2), 'tgt', ai[1]!.state.passTarget, 'near', ai[1]!.state.near, 'brk', ai[1]!.state.lastAllowed.toFixed(1), 'tgap', (gap / Math.max(5, Math.hypot(w.cars[1]!.vx, w.cars[1]!.vy))).toFixed(2), 'defence', ai[0]!.state.defence);
    if (t > 120) { sumGap += gap; nGap++; ahead = gap < -3; if (ahead && firstPassSec < 0) firstPassSec = t / 60; }
  }
  if (process.env.WEAR) console.log(`wear after ${laps} laps: defender ${(100 - w.cars[0]!.wheels.reduce((x, h) => x + h.wear, 0) * 25).toFixed(2)}% used, attacker (following) ${(100 - w.cars[1]!.wheels.reduce((x, h) => x + h.wear, 0) * 25).toFixed(2)}% used; laps ${w.cars[0]!.timing.laps}/${w.cars[1]!.timing.laps}`);
  const d = ai[0]!.state;
  return { ahead, firstPassSec, contacts, avgGap: sumGap / Math.max(1, nGap), tries: ai[1]!.state.passTries, made: ai[1]!.state.passesMade, conceded: d.concessions, cover: d.defCovers, coverLost: d.defCoverLost, hold: d.defHolds, holdLost: d.defHoldLost };
}

const avg = { pace: 50, aggression: 50, racecraft: 50, consistency: 80, tyres: 50 };
// --care: following closely with poor vs good TYRE MANAGEMENT (same pace, near-equal cars): tyre life used.
if (args.includes('--care')) {
  for (const tyres of [20, 90]) {
    process.env.WEAR = '1';
    console.log(`follower TYRE MANAGEMENT ${tyres}:`);
    duel({ ...avg, pace: 60, tyres }, { ...avg, pace: 60 }, 10, 30);
  }
  process.exit(0);
}
for (const [label, aggr, defAggr] of [['low aggression ', 25, 50], ['high aggression', 90, 50], ['high aggr vs a conceding defender', 90, 10]] as const) {
  const t = { ahead: 0, passed: 0, runs: 0, contacts: 0, tries: 0, made: 0, conceded: 0, gap: 0, cover: 0, coverLost: 0, hold: 0, holdLost: 0 };
  for (const gap of [8, 12, 16]) for (const v of [30, 40]) {
    const r = duel({ ...avg, pace: 85, aggression: aggr }, { ...avg, pace: 40, aggression: defAggr }, gap, v);
    t.runs++; if (r.ahead) t.ahead++; if (r.firstPassSec >= 0) t.passed++;
    t.contacts += r.contacts; t.tries += r.tries; t.made += r.made; t.conceded += r.conceded; t.gap += r.avgGap;
    t.cover += r.cover; t.coverLost += r.coverLost; t.hold += r.hold; t.holdLost += r.holdLost;
  }
  console.log(`attacker ${label}: got by in ${t.passed}/${t.runs} duels (ahead at the end in ${t.ahead}); moves committed ${t.tries}, completed ${t.made}; contacts ${t.contacts}; defender conceded ${t.conceded}; average gap ${(t.gap / t.runs).toFixed(1)} m; defender covered ${t.cover} (lost ${t.coverLost}), held ${t.hold} (lost ${t.holdLost})`);
}
