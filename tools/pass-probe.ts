// Pass execution probe (AI overtaking card): duels in Equal mode (identical cars), live config.
// A quicker attacker (pace 85) starts right behind a slower defender (pace 40, and its corner and braking
// margins x --slow, or with identical cars it never gets close), rolling, on the main straight.
// Does it get by, how often does it commit to a move and complete it, does it touch, and does aggression
// (how early it pulls out, how close it follows; a low-aggression defender concedes) change it?
// Usage: npm run pass-probe [-- --laps 3 --slow 0.9]
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
    if (w.cars[1]!.carContact && !prev.cars[1]!.carContact) contacts++;
    const gap = (prog(0) - prog(1)) * 2;
    if (t > 120) { sumGap += gap; nGap++; ahead = gap < -3; if (ahead && firstPassSec < 0) firstPassSec = t / 60; }
  }
  return { ahead, firstPassSec, contacts, avgGap: sumGap / Math.max(1, nGap), tries: ai[1]!.state.passTries, made: ai[1]!.state.passesMade, conceded: ai[0]!.state.concessions };
}

const avg = { pace: 50, aggression: 50, racecraft: 50, consistency: 80, tyres: 50 };
for (const [label, aggr, defAggr] of [['low aggression ', 25, 50], ['high aggression', 90, 50], ['high aggr vs a conceding defender', 90, 10]] as const) {
  const t = { ahead: 0, passed: 0, runs: 0, contacts: 0, tries: 0, made: 0, conceded: 0, gap: 0 };
  for (const gap of [8, 12, 16]) for (const v of [30, 40]) {
    const r = duel({ ...avg, pace: 85, aggression: aggr }, { ...avg, pace: 40, aggression: defAggr }, gap, v);
    t.runs++; if (r.ahead) t.ahead++; if (r.firstPassSec >= 0) t.passed++;
    t.contacts += r.contacts; t.tries += r.tries; t.made += r.made; t.conceded += r.conceded; t.gap += r.avgGap;
  }
  console.log(`attacker ${label}: got by in ${t.passed}/${t.runs} duels (ahead at the end in ${t.ahead}); moves committed ${t.tries}, completed ${t.made}; contacts ${t.contacts}; defender conceded ${t.conceded}; average gap ${(t.gap / t.runs).toFixed(1)} m`);
}
