// @vitest-environment node
// Ticker + label data: positions, codes, gaps to the leader, the player's intervals.
import { describe, expect, it } from 'vitest';
import contactJson from '../../../tools/fixtures/contact-baseline.json';
import physicsJson from '../../../tools/fixtures/physics-baseline.json';
import slipstreamJson from '../../../tools/fixtures/slipstream-baseline.json';
import raceJson from '../../../config/race.json';
import { catalog, loadTrackNode, simContextNode } from '../../../tools/load-track-node';
import { createRaceWorld, type PhysicsConfig, type SimContext, type WorldState } from '../../sim';
import { lapHead, playerIntervals, runningOrder, teamCode } from './running-order';

const ctx: SimContext = { ...simContextNode(loadTrackNode('oxford'), structuredClone(physicsJson as PhysicsConfig)), contact: contactJson, race: raceJson, slipstream: slipstreamJson };
const builds = [0, 1, 2, 3].map((i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id }));

/** A race in progress: order 2, 0, 3, 1; everyone has crossed the start line and one more line. */
function midRace(): WorldState {
  const w = createRaceWorld(ctx, builds, { laps: 5, seed: 1 });
  const race = structuredClone(w.race!);
  race.phase = 'racing';
  race.startTime = 0;
  race.order = [2, 0, 3, 1];
  const at = { 2: [0, 10], 0: [0.4, 11.25], 3: [0.6, 11.5], 1: [0.9, 13] } as Record<number, number[]>;
  race.cars.forEach((c, i) => { c.crossings = at[i]!; c.progress = 0.3; });
  return { ...w, race };
}

describe('running order', () => {
  it('codes from team names', () => {
    expect(teamCode('Blue Bull')).toBe('BLU');
    expect(teamCode('McFaren')).toBe('MCF');
  });

  it('lists positions with gaps to the leader; the player is YOU', () => {
    const o = runningOrder(midRace(), catalog);
    expect(o.map((e) => e.car)).toEqual([2, 0, 3, 1]);
    expect(o.map((e) => e.pos)).toEqual([1, 2, 3, 4]);
    expect(o[0]!.gap).toBe('LEADER');
    expect(o[1]).toMatchObject({ code: 'YOU', me: true, gap: '+1.250' });
    expect(o[3]!.gap).toBe('+3.000');
    expect(o[2]!.code).toBe(teamCode(catalog.teams[3]!.name));
  });

  it("the player's intervals to the cars either side", () => {
    expect(playerIntervals(midRace())).toEqual({ pos: 2, of: 4, ahead: '+1.250', behind: '-0.250' });
  });

  it('no gaps on the grid; lap counter', () => {
    const w = createRaceWorld(ctx, builds, { laps: 5, seed: 1 });
    expect(runningOrder(w, catalog).every((e) => e.gap === '')).toBe(true);
    expect(lapHead(w)).toBe('GRID');
    expect(lapHead(midRace())).toBe('LAP 1/5');
  });
});
