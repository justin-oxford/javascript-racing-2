// Running order for the race ticker and the car labels: pure functions of world.race, no DOM.
import { raceGap, type CarCatalog, type Gap, type WorldState } from '../../sim';

export interface OrderEntry {
  /** 1-based race position. */
  pos: number;
  car: number;
  /** Three-letter code (the player's profile code for car 0). */
  code: string;
  name: string;
  swatch: string;
  /** Gap to the leader as shown ("+1.234", "+1 LAP", "" when there's no timing line yet; the leader's is "LEADER"). */
  gap: string;
  state: '' | 'pit' | 'finished';
  me: boolean;
}

/** How the local player shows in the running order, labels and results: their profile's code and name. */
export const player = { code: 'YOU', name: 'You' };
export function setPlayerIdentity(code: string, name: string): void {
  player.code = code;
  player.name = name;
}

export const gapText = (g: Gap | undefined): string => (!g ? '' : g.laps ? `+${g.laps} LAP${g.laps > 1 ? 'S' : ''}` : `+${g.seconds.toFixed(3)}`);

/** Three letters from a team name: "Blue Bull" -> BLU, "McFaren" -> MCF. */
export const teamCode = (name: string): string => name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();

export function runningOrder(world: WorldState, catalog: CarCatalog): OrderEntry[] {
  const race = world.race;
  if (!race) return [];
  const started = race.phase !== 'grid' && race.phase !== 'lights';
  return race.order.map((car, k) => {
    const team = catalog.teams.find((t) => t.id === world.cars[car]!.build.team);
    const rc = race.cars[car]!;
    return {
      pos: k + 1,
      car,
      code: car === 0 ? player.code : teamCode(team?.name ?? '???'),
      name: car === 0 ? player.name : (team?.name ?? '?'),
      swatch: team?.colors.primary ?? '#888',
      gap: !started ? '' : k === 0 ? 'LEADER' : gapText(raceGap(race, car, race.order[0]!)),
      state: rc.finished ? 'finished' : world.cars[car]!.inPitLane ? 'pit' : '',
      me: car === 0,
    };
  });
}

/** The player's place and intervals to the cars either side ("" when there's no gap to show). */
export function playerIntervals(world: WorldState): { pos: number; of: number; ahead: string; behind: string } | undefined {
  const race = world.race;
  if (!race) return undefined;
  const k = race.order.indexOf(0);
  if (k < 0) return undefined;
  const started = race.phase !== 'grid' && race.phase !== 'lights';
  const ahead = started && k > 0 ? gapText(raceGap(race, 0, race.order[k - 1]!)) : '';
  const behind = started && k < race.order.length - 1 ? gapText(raceGap(race, race.order[k + 1]!, 0)) : '';
  return { pos: k + 1, of: race.order.length, ahead, behind: behind.replace(/^\+/, '-') };
}

/** The lap line over the ticker: GRID, LAP n/N, FINISH. */
export function lapHead(world: WorldState): string {
  const race = world.race;
  if (!race) return '';
  if (race.phase === 'grid' || race.phase === 'lights') return 'GRID';
  if (race.phase !== 'racing') return 'FINISH';
  const leader = race.cars[race.order[0]!]!;
  const lap = Math.min(race.laps, Math.max(1, Math.floor(leader.finished ? leader.finishLaps : leader.progress) + 1));
  return `LAP ${lap}/${race.laps}`;
}

/** m:ss.sss (or s.sss under a minute). */
export const lapText = (t: number): string => {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(3).padStart(6, '0');
  return m ? `${m}:${s}` : t.toFixed(3);
};

/** Qualifying order: by best lap; pole shows its time, the rest the gap to pole; no time = "NO TIME". */
export function qualiEntries(world: WorldState, catalog: CarCatalog): OrderEntry[] {
  const q = world.quali;
  if (!q) return [];
  const pole = q.cars[q.order[0]!]!.bestLap;
  return q.order.map((car, k) => {
    const team = catalog.teams.find((t) => t.id === world.cars[car]!.build.team);
    const c = q.cars[car]!;
    return {
      pos: k + 1,
      car,
      code: car === 0 ? player.code : teamCode(team?.name ?? '???'),
      name: car === 0 ? player.name : (team?.name ?? '?'),
      swatch: team?.colors.primary ?? '#888',
      gap: !c.bestLap ? 'NO TIME' : k === 0 ? lapText(c.bestLap) : `+${(c.bestLap - pole).toFixed(3)}`,
      state: c.done ? 'finished' : world.cars[car]!.inPitLane ? 'pit' : '',
      me: car === 0,
    };
  });
}

/** Whichever session is running: race order, qualifying order, or nothing (practice). */
export function sessionOrder(world: WorldState, catalog: CarCatalog): OrderEntry[] {
  return world.race ? runningOrder(world, catalog) : qualiEntries(world, catalog);
}
