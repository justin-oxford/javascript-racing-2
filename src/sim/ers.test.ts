// @vitest-environment node
// Engine modes + battery deploy (POLISH card): modes trade power for fuel, deploy adds drive on top of
// the engine while charge and the lap budget last, braking harvests, the mode sticks until changed.
import { describe, expect, it } from 'vitest';
import contactJson from '../../tools/fixtures/contact-baseline.json';
import physicsJson from '../../tools/fixtures/physics-baseline.json';
import slipstreamJson from '../../tools/fixtures/slipstream-baseline.json';
import raceJson from '../../config/race.json';
import { loadTrackNode, simContextNode } from '../../tools/load-track-node';
import { createWorld, deployPowerW, newErs, nextEngineMode, step, updateErs, type CarInput, type EngineMode, type PhysicsConfig, type RaceConfig, type SimContext, type WorldState } from './index';

const loaded = loadTrackNode('oxford');
const ctx: SimContext = { ...simContextNode(loaded, structuredClone(physicsJson as unknown as PhysicsConfig)), contact: contactJson, race: raceJson as RaceConfig, slipstream: slipstreamJson };
const { spawn, pxPerMeter: ppm } = ctx.track.json;
const f = { x: Math.sin(spawn.heading), y: -Math.cos(spawn.heading) };
/** One car on the main straight at v m/s, then `ticks` of `input`. */
const straight = (input: CarInput, ticks: number, v = 30, c: SimContext = ctx): WorldState => {
  let w = createWorld(c, 1);
  w = { ...w, cars: [{ ...w.cars[0]!, x: spawn.x / ppm - f.x * 60, y: spawn.y / ppm - f.y * 60, heading: spawn.heading, vx: f.x * v, vy: f.y * v }] };
  for (let t = 0; t < ticks; t++) w = step(w, [input], c);
  return w;
};
const flat = (engineMode?: EngineMode, deploy = false): CarInput => ({ throttle: 1, brake: 0, steer: 0, engineMode, deploy });

describe('engine modes', () => {
  it('SAVE burns less and is slower, PUSH burns more and is faster; the mode sticks', () => {
    const run = (m: EngineMode) => straight(flat(m), 90).cars[0]!;
    const save = run('save'), std = run('standard'), push = run('push');
    const used = (c: typeof std) => ctx.physics.fuel.startKg - c.fuelKg;
    expect(used(save)).toBeCloseTo(used(std) * ctx.ers.modes.save.fuel, 6);
    expect(used(push)).toBeCloseTo(used(std) * ctx.ers.modes.push.fuel, 6);
    expect(save.speed).toBeLessThan(std.speed);
    expect(push.speed).toBeGreaterThan(std.speed);
    // Asked once, kept: no engineMode in later inputs leaves it in SAVE.
    let w = straight(flat('save'), 1);
    for (let t = 0; t < 30; t++) w = step(w, [flat()], ctx);
    expect(w.cars[0]!.ers.mode).toBe('save');
    expect(nextEngineMode('save')).toBe('standard');
    expect(nextEngineMode('push')).toBe('save');
  });
});

describe('battery deploy', () => {
  it('adds drive on top of the engine and drains the battery; none without charge', () => {
    const on = straight(flat('standard', true), 90).cars[0]!, off = straight(flat('standard', false), 90).cars[0]!;
    expect(on.speed - off.speed).toBeGreaterThan(1); // m/s after 1.5 s from 108 kph
    expect(on.ers.batteryKJ).toBeLessThan(off.ers.batteryKJ);
    const flatBattery: SimContext = { ...ctx, ers: { ...ctx.ers, battery: { ...ctx.ers.battery, startPct: 0 } } };
    expect(straight(flat('standard', true), 90, 30, flatBattery).cars[0]!.speed).toBeCloseTo(off.speed, 6);
  });

  it('is capped per lap and the budget resets at the line; braking harvests, the engine never does', () => {
    const cfg = ctx.ers, b = cfg.battery;
    let e = { ...newErs(cfg), batteryKJ: b.capacityKJ };
    let ticks = 0;
    while (deployPowerW(e, true, 1, cfg) > 0 && ticks < 60 * 60) { e = updateErs(e, 'standard', deployPowerW(e, true, 1, cfg), 0, 0, 1 / 60, cfg); ticks++; }
    expect(e.lapDeployKJ).toBeGreaterThanOrEqual(b.maxDeployPerLapKJ);
    expect(e.lapDeployKJ).toBeLessThan(b.maxDeployPerLapKJ + 2);
    expect(ticks / 60).toBeCloseTo(b.maxDeployPerLapKJ / b.deployKW, 1);
    e = updateErs(e, 'standard', 0, 0, 1, 1 / 60, cfg); // crossed the line
    expect(e.lapDeployKJ).toBe(0);
    expect(deployPowerW(e, true, 1, cfg)).toBeGreaterThan(0);
    // Harvest: braking adds charge; flat out (no braking) adds none.
    const low = { ...newErs(cfg), batteryKJ: 10 };
    expect(updateErs(low, 'standard', 0, 1e6, 0, 1, cfg).batteryKJ).toBeCloseTo(10 + 1e6 * b.harvestShare / 1000, 6);
    const w = straight(flat(), 60, 30, { ...ctx, ers: { ...cfg, battery: { ...b, startPct: 0.1 } } });
    expect(w.cars[0]!.ers.batteryKJ).toBeCloseTo(b.capacityKJ * 0.1, 6);
    const braked = straight({ throttle: 0, brake: 1, steer: 0 }, 60, 70, { ...ctx, ers: { ...cfg, battery: { ...b, startPct: 0.1 } } });
    expect(braked.cars[0]!.ers.batteryKJ).toBeGreaterThan(b.capacityKJ * 0.1 + 5);
  });

  it('is deterministic', () => {
    expect(straight(flat('push', true), 120)).toEqual(straight(flat('push', true), 120));
  });
});
