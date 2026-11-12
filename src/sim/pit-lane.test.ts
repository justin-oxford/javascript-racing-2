// @vitest-environment node
// Pit lane: cars in it ghost through each other (contact.json pitLaneGhosting), and a field that all
// pits on the same lap gets through single file in the fast lane without queueing behind parked cars.
// Full field, more detail: `npm run pit-probe`.
import { describe, expect, it } from 'vitest';
import aiJson from '../../tools/fixtures/ai-baseline.json';
import contactJson from '../../tools/fixtures/contact-baseline.json';
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import slipstreamJson from '../../tools/fixtures/slipstream-baseline.json';
import raceJson from '../../config/race.json';
import { catalog, loadTrackNode, simContextNode } from '../../tools/load-track-node';
import { aiInputSource, buildRacingLine, createRaceWorld, createWorld, pitBoxPose, step, type AiConfig, type PhysicsConfig, type RaceConfig, type SimContext, type WorldState } from './index';

const loaded = loadTrackNode('oxford');
const base: SimContext = { ...simContextNode(loaded, structuredClone(physicsJson as PhysicsConfig)), contact: contactJson, race: raceJson as RaceConfig, slipstream: slipstreamJson };
const line = buildRacingLine(loaded.track)!;
const ppm = loaded.track.json.pxPerMeter;

describe('pit lane ghosting', () => {
  // Car 1 parked in box 0; car 0 dropped right on top of it, rolling.
  const overlapped = (ctx: SimContext) => {
    const pose = pitBoxPose(line, 0, ppm)!;
    let w: WorldState = createWorld(ctx, 2);
    w = { ...w, cars: w.cars.map((c, i) => ({ ...c, x: pose.x / ppm, y: pose.y / ppm, heading: pose.heading, vx: i === 0 ? Math.sin(pose.heading) * 5 : 0, vy: i === 0 ? -Math.cos(pose.heading) * 5 : 0, inPitLane: true })) };
    let touched = false;
    for (let t = 0; t < 30; t++) {
      w = step(w, [], ctx);
      touched ||= w.cars.some((c) => c.carContact);
    }
    return { w, touched };
  };

  it('two cars in the pit lane pass through each other', () => {
    const { w, touched } = overlapped(base);
    expect(touched).toBe(false);
    expect(Math.hypot(w.cars[1]!.vx, w.cars[1]!.vy)).toBeLessThan(0.01); // the parked car wasn't shoved
  });

  it('switched off, they collide as usual', () => {
    expect(overlapped({ ...base, contact: { ...base.contact, pitLaneGhosting: false } }).touched).toBe(true);
  });
});

describe('a field that all pits together', () => {
  it('everyone stops in their own box and gets out; nobody queues or gets stuck in the lane', () => {
    const cfg = aiJson as unknown as AiConfig;
    const builds = Array.from({ length: 8 }, (_, i) => ({ ...base.physics.defaultCar, team: catalog.teams[i]!.id }));
    let w: WorldState = createRaceWorld(base, builds, { laps: 5, seed: 1 });
    w = { ...w, cars: w.cars.map((c) => ({ ...c, fuelKg: 12 })) }; // everyone pits at the end of lap 1
    const ai = builds.map((_, i) => aiInputSource(i, () => ({ world: w, ctx: base, line }), () => ({ ...cfg.presets[cfg.defaultPreset]!, mistakesPerMin: 0 }), () => cfg, 70 + i));
    const boxQ = (i: number) => line.pit!.boxStops[w.race!.cars[i]!.box]!.q;
    let queued = 0, pitStuck = 0;
    const seen = builds.map(() => 0);
    for (let t = 0; t < 60 * 150 && !ai.every((d) => d.state.pitStops >= 1 && d.state.mode === 'race'); t++) {
      w = step(w, ai.map((d) => d.read(w.tick)), base);
      // Queued: crawling in the lane short of its own box (not stopping at it or waiting in it).
      // Stuck in the lane itself. (Under this frozen physics a car can overcook the pit-entry hairpin and
      // need to reverse out; with the live tuning it doesn't: npm run pit-probe. Not the lane's business.)
      ai.forEach((d, i) => { if (d.state.stuckEvents > seen[i]!) { seen[i] = d.state.stuckEvents; if (d.state.mode === 'pit' && d.state.near >= line.pit!.laneFrom - 3) pitStuck++; } });
      w.cars.forEach((c, i) => { if (c.inPitLane && Math.hypot(c.vx, c.vy) < 2 && !c.servicing && ai[i]!.state.mode === 'pit' && ai[i]!.state.near < boxQ(i) - 3) queued++; });
    }
    expect(ai.map((d) => d.state.pitStops)).toEqual(builds.map(() => 1));
    expect(ai.every((d) => d.state.mode === 'race')).toBe(true);
    expect(queued / 60).toBeLessThan(3);
    expect(pitStuck).toBe(0);
  }, 60_000);
});
