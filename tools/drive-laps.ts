// Smoke test for a track: a scripted driver (not AI) follows the track's centre path for up to 3 laps
// and prints every sector/lap event. Proves the lap closes and every timing line is crossable.
// Usage: npm run drive-laps -- <id>      (uses live config/physics.json)
import { createWorld, step, type CarInput } from '../src/sim/index.ts';
import { lapGeometry } from './lap-distance.ts';
import { loadTrackNode, simContextNode, surfaces } from './load-track-node.ts';
const id = process.argv[2];
if (!id) {
  console.error('usage: npm run drive-laps -- <id>');
  process.exit(1);
}
const loaded = loadTrackNode(id);
const ctx = simContextNode(loaded); // live config/physics.json (Justin's tuning)
const ppm = loaded.track.json.pxPerMeter;
const geo = lapGeometry(loaded.track);
const path: { x: number; y: number }[] = [];
for (let d = 0; d < geo.lap; d += 60) { const p = geo.centreAt(d); path.push({ x: p.x / ppm, y: p.y / ppm }); }
let world = createWorld(ctx);
let near = 0;
let stuck = 0;
const drive = (): CarInput => {
  const c = world.cars[0]!;
  let best = near, bd = Infinity;
  for (let k = -5; k < 40; k++) { const i = (near + k + path.length) % path.length, p = path[i]!; const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2; if (d < bd) { bd = d; best = i; } }
  near = best;
  const t = path[(best + 3) % path.length]!; // ~18 m ahead: steer
  const far = path[(best + 8) % path.length]!; // ~48 m ahead: brake early for corners
  let a = Math.atan2(t.x - c.x, -(t.y - c.y)) - c.heading; a = Math.atan2(Math.sin(a), Math.cos(a));
  let af = Math.atan2(far.x - c.x, -(far.y - c.y)) - c.heading; af = Math.atan2(Math.sin(af), Math.cos(af));
  if (stuck > 60) { stuck = stuck > 150 ? 0 : stuck + 1; return { throttle: 0, brake: 1, steer: -Math.sign(a) }; } // reverse out
  stuck = c.wallContact && Math.abs(c.speed) < 2 ? stuck + 1 : 0;
  const cap = Math.abs(af) > 0.35 ? 16 : Math.abs(af) > 0.15 ? 26 : 50;
  return { throttle: c.speed < cap ? 1 : 0, brake: c.speed > cap + 2 ? 1 : 0, steer: Math.max(-1, Math.min(1, a * 3)) };
};
let laps = 0, offTicks = 0, walls = 0;
for (let t = 0; t < 60 * 240 && laps < 3; t++) {
  world = step(world, [drive()], ctx);
  const c = world.cars[0]!;
  if (c.offTrack) offTicks++;
  if (c.wallContact) walls++;
  for (const e of world.events) {
    if (e.type === 'sector') console.log(`  ${(world.tick / 60).toFixed(1)}s S${e.sector + 1} ${e.time.toFixed(3)}${e.invalid ? ' INVALID' : ''}`);
    if (e.type === 'lap') { laps++; console.log(`LAP ${e.lap}: ${e.time.toFixed(3)} = ${e.sectors.map((s) => s.toFixed(3)).join(' + ')}${e.invalid ? ' INVALID' : ''}`); }
    if (e.type === 'outOfBounds') console.log('OUT OF BOUNDS', e);
  }
}
const c = world.cars[0]!;
console.log(`end: laps ${laps}, wall-contact ticks ${walls}, off-track ticks ${offTicks}, surfaces ${c.wheels.map((w) => surfaces[w.surface]!.id).join('/')}`);
