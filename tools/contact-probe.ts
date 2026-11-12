// Car-to-car contact probe (card 06): two scripted contacts with live config, so contact tuning has
// numbers to go with the feel test. Usage: npm run contact-probe
//   RUB:  two cars side by side at speed, one leaning into the other for 1 s. Fair = both carry on
//         (small heading change, little speed lost).
//   PUNT: a faster car hits the rear quarter of another. Fair = the hit car spins (big heading change).
// Tune with the panel: Car contact (friction, restitution) and Car body -> inertiaScale.
import { bodyOffsetM, createWorld, step, type CarInput, type WorldState } from '../src/sim/index.ts';
import { defaultTrackIdNode, loadTrackNode, simContextNode } from './load-track-node.ts';

const loaded = loadTrackNode(defaultTrackIdNode());
const ctx = simContextNode(loaded);
// Try values without touching config: --friction 0.6 --restitution 0.2 --inertia 0.7
const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? Number(argv[i + 1]) : undefined; };
ctx.contact = { ...ctx.contact, carFriction: opt('friction') ?? ctx.contact.carFriction, carRestitution: opt('restitution') ?? ctx.contact.carRestitution };
ctx.physics.car.inertiaScale = opt('inertia') ?? ctx.physics.car.inertiaScale;
ctx.physics.tyres.falloff = opt('falloff') ?? ctx.physics.tyres.falloff;
const { spawn, pxPerMeter: ppm } = ctx.track.json;
const f = { x: Math.sin(spawn.heading), y: -Math.cos(spawn.heading) }, r = { x: Math.cos(spawn.heading), y: Math.sin(spawn.heading) };
const deg = (a: number) => ((a * 180) / Math.PI).toFixed(1);

/** Two cars on the start straight: offsets (along, across) from the spawn in metres, speeds in m/s. */
function scenario(b: { along: number; across: number; speed: number; headingOff: number }, aSpeed: number): WorldState {
  const w = createWorld(ctx, 2);
  // Offsets place each car's BODY centre (where it's drawn and collides), not its CG, which sits
  // bodyOffsetM behind it (03b geometry), so the scripted hits land where they look like they land.
  const place = (c: WorldState['cars'][number], along: number, across: number, v: number, dh: number) => ({
    ...c,
    x: spawn.x / ppm + f.x * along + r.x * across - Math.sin(spawn.heading + dh) * bodyOffsetM(ctx.physics),
    y: spawn.y / ppm + f.y * along + r.y * across + Math.cos(spawn.heading + dh) * bodyOffsetM(ctx.physics),
    heading: spawn.heading + dh,
    vx: Math.sin(spawn.heading + dh) * v,
    vy: -Math.cos(spawn.heading + dh) * v,
  });
  return { ...w, cars: [place(w.cars[0]!, 0, 0, aSpeed, 0), place(w.cars[1]!, b.along, b.across, b.speed, b.headingOff)] };
}

function run(name: string, w0: WorldState, inputs: [CarInput, CarInput], seconds: number, fair: string): void {
  let w = w0;
  const h0 = w.cars[0]!.heading, v0 = Math.hypot(w.cars[0]!.vx, w.cars[0]!.vy);
  let contactTicks = 0, maxYaw = 0;
  for (let t = 0; t < seconds * 60; t++) {
    w = step(w, inputs, ctx);
    if (w.cars[0]!.carContact) contactTicks++;
    maxYaw = Math.max(maxYaw, Math.abs(w.cars[0]!.angVel));
  }
  const a = w.cars[0]!;
  console.log(`${name}: contact ${contactTicks} ticks; hit car heading change ${deg(Math.atan2(Math.sin(a.heading - h0), Math.cos(a.heading - h0)))} deg, peak yaw ${deg(maxYaw)} deg/s, speed ${(v0 * 3.6).toFixed(0)} -> ${(Math.hypot(a.vx, a.vy) * 3.6).toFixed(0)} kph   (fair: ${fair})`);
}

const cruise: CarInput = { throttle: 0.6, brake: 0, steer: 0 };
console.log(`contact: friction ${ctx.contact.carFriction}, restitution ${ctx.contact.carRestitution}; inertiaScale ${ctx.physics.car.inertiaScale}; tyre falloff ${ctx.physics.tyres.falloff}`);
// RUB: car B alongside (2.2 m centre to centre, cars are ~2 m wide), steering gently into car A.
run('RUB ', scenario({ along: 0, across: 2.2, speed: 42, headingOff: -0.04 }, 42), [cruise, { throttle: 0.6, brake: 0, steer: -0.15 }], 1.5, 'small heading change, keeps most speed');
// PUNT: car B behind and to the side, turning in (17 deg) on A's rear quarter, 8 m/s faster.
run('PUNT', scenario({ along: -ctx.physics.car.lengthM + 0.5, across: 2.4, speed: 38, headingOff: -0.3 }, 30), [cruise, { throttle: 1, brake: 0, steer: 0 }], 2, 'big heading change: it spins');
