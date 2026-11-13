// Pit-lane probe: where the boxes sit relative to the AI's pit path, then a race / practice with the
// whole field, counting cars queueing in the lane (slow, not being serviced) and contact there.
// Usage: npm run pit-probe [-- --mode race|practice --laps 12 --ai 10 --seed 1 --fuel 20 --sec 600 --dump --stuck --overlap --physics file.json]
import { readFileSync } from 'node:fs';
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, createRaceWorld, createWorld, step, type AiConfig, type CarBuild, type PhysicsConfig, type WorldState } from '../src/sim/index.ts';
import { catalog, defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const loaded = loadTrackNode(defaultTrackIdNode());
// --physics file.json: another physics config (the frozen-physics pit-entry bug: tools/fixtures/physics-baseline.json).
const physPath = args.includes('--physics') ? opt('physics', '') : '';
const ctx = physPath ? simContextNode(loaded, JSON.parse(readFileSync(physPath, 'utf8')) as PhysicsConfig) : simContextNode(loaded);
const line = buildRacingLine(loaded.track)!;
const pit = line.pit!;
const cfg = aiJson as unknown as AiConfig;
const tg = (q: number) => { const a = Math.min(q, pit.n - 2); const dx = pit.x[a + 1]! - pit.x[a]!, dy = pit.y[a + 1]! - pit.y[a]!, l = Math.hypot(dx, dy); return { x: dx / l, y: dy / l }; };
const lat = (q: number, x: number, y: number) => { const t = tg(q); return (x - pit.x[q]!) * -t.y + (y - pit.y[q]!) * t.x; };
console.log(`pit path n=${pit.n} lane ${pit.laneFrom}..${pit.laneTo}; boxes:`);
pit.boxStops.forEach((b, k) => console.log(`  box ${k}: q=${b.q} lateral ${lat(b.q, b.x, b.y).toFixed(2)} m; room left ${pit.left[b.q]!.toFixed(2)} right ${pit.right[b.q]!.toFixed(2)}`));

const mode = opt('mode', 'race');
const n = Number(opt('ai', '10'));
const builds: CarBuild[] = Array.from({ length: n }, (_, i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i % catalog.teams.length]!.id }));
// Low starting fuel so everyone pits early and often.
let w: WorldState = mode === 'race' ? createRaceWorld(ctx, builds, { laps: Number(opt('laps', '12')), seed: Number(opt('seed', '1')) }) : createWorld(ctx, builds);
w = { ...w, cars: w.cars.map((c) => ({ ...c, fuelKg: Number(opt('fuel', '20')) })) };
const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => cfg.presets[cfg.defaultPreset]!, () => cfg, 1000 + i));
let overlap = 0, queue = 0, contact = 0, maxQueued = 0, stops = 0;
const was = builds.map(() => false);
const stuckSeen = builds.map(() => 0), stuckWhere = { pit: 0, track: 0 };
const secs = Number(opt('sec', '600'));
for (let t = 0; t < 60 * secs && (!w.race || w.race.phase !== 'results'); t++) {
  w = step(w, ai.map((d) => d.read(w.tick)), ctx);
  let qd = 0;
  w.cars.forEach((c, i) => {
    // Queued: crawling in the lane short of its own box (not stopping at / waiting in it).
    const st = ai[i]!.state, box = pit.boxStops[w.race?.cars[i]?.box ?? i % pit.boxStops.length]!;
    if (c.inPitLane && Math.hypot(c.vx, c.vy) < 2 && !c.servicing && st.mode === 'pit' && st.near < box.q - 3) qd++;
    if (c.inPitLane && c.carContact && t % 60 === 0) console.log(`  contact t=${(w.tick / 60).toFixed(1)} car ${i} q ${st.near} mode ${st.mode}`);
    if (c.inPitLane && c.carContact) contact++;
    // Ghosted overlap: two pit-lane cars closer than a car width (they'd be touching side by side or nose to tail).
    for (let j = i + 1; j < w.cars.length; j++) { const o = w.cars[j]!; if (c.inPitLane && o.inPitLane && Math.hypot(c.x - o.x, c.y - o.y) < 2) { overlap++; if (args.includes('--overlap') && overlap % 10 === 1) { const si = ai[i]!.state, sj = ai[j]!.state; console.log(`  overlap t=${(w.tick / 60).toFixed(1)} car ${i} q ${si.near} ${si.mode} srv ${si.serviced} v ${Math.hypot(c.vx, c.vy).toFixed(1)} | car ${j} q ${sj.near} ${sj.mode} srv ${sj.serviced} v ${Math.hypot(o.vx, o.vy).toFixed(1)}`); } } }
    if (c.servicing && !was[i]) stops++;
    was[i] = c.servicing;
  });
  ai.forEach((d, i) => { if (d.state.stuckEvents > stuckSeen[i]!) { stuckSeen[i] = d.state.stuckEvents; stuckWhere[d.state.mode === 'pit' ? 'pit' : 'track']++; if (args.includes('--stuck')) console.log(`  stuck t=${(w.tick / 60).toFixed(1)} car ${i} ${d.state.mode} q ${d.state.near} v ${Math.hypot(w.cars[i]!.vx, w.cars[i]!.vy).toFixed(1)}`); } });
  queue += qd;
  if (qd > maxQueued || (args.includes('--dump') && qd >= 3 && t % 60 === 0)) {
    console.log(`t=${(w.tick / 60).toFixed(1)} queued ${qd}`);
    w.cars.forEach((c, i) => {
      if (!c.inPitLane) return;
      const st = ai[i]!.state;
      let bq = 0, bd = Infinity;
      for (let q = 0; q < pit.n; q++) { const d = (pit.x[q]! - c.x) ** 2 + (pit.y[q]! - c.y) ** 2; if (d < bd) { bd = d; bq = q; } }
      console.log(`   car ${i}: q ${bq} lat ${lat(bq, c.x, c.y).toFixed(2)} v ${Math.hypot(c.vx, c.vy).toFixed(1)} servicing ${c.servicing} aiServiced ${st.serviced} mode ${st.mode} box ${w.race?.cars[i]?.box} stuck ${st.stuckTicks} recov ${st.recoverTicks}`);
    });
  }
  maxQueued = Math.max(maxQueued, qd);
}
console.log(`${mode}: ${(w.tick / 60).toFixed(0)} s, stops ${stops}, queued car-seconds ${(queue / 60).toFixed(1)}, most queued at once ${maxQueued}, pit-lane contact ticks ${contact}, overlap ticks ${overlap}`);
console.log(`stuck events: pit lane ${stuckWhere.pit}, on track ${stuckWhere.track}; per car`, ai.map((d) => d.state.stuckEvents).join(' '), ' pit stops:', ai.map((d) => d.state.pitStops).join(' '));
