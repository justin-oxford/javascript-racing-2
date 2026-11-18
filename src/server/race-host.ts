// One race on the server (card 07): the real sim, stepped at 60 Hz by the room. Players' cars take the
// latest input each client sent; every other car (AI fill, and dropped players) is driven by 05's AI
// InputSource, right here on the server. No Colyseus in this file, so tests can drive it directly.
import aiJson from '../../config/ai.json' with { type: 'json' };
import driversJson from '../../config/drivers.json' with { type: 'json' };
import {
  aiInputSource, aiStartCompound, assignDrivers, buildRacingLine, consumableScale, createRaceWorld, driverPreset, normalizeSetup, step,
  NEUTRAL_INPUT, type AiConfig, type CarBuild, type CarInput, type DriverDef, type InputSource, type RacingLine, type SimContext, type SimEvent, type WorldState,
} from '../sim';
import { encodeCar, fullCar, type CarDriver, type InputMsg, type RoomSettings, type SnapMsg } from './protocol';

export const aiCfg = aiJson as unknown as AiConfig;
const roster = (driversJson as { drivers: DriverDef[] }).drivers;

export interface Entrant {
  /** Player session id (absent = AI fill). */
  player?: string;
  name: string;
  /** Three-letter code. */
  code: string;
  team: string;
}

/** Three letters from a name: "Justin" -> JUS. */
export const nameCode = (name: string): string => (name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'PLY').padEnd(3, 'X');

export class RaceHost {
  world: WorldState;
  readonly line: RacingLine | undefined;
  readonly drivers: CarDriver[];
  /** Latest input per car from its player, and the seq it came with. */
  private readonly latest: Array<{ input: CarInput; seq: number } | undefined>;
  /** Seq of the input applied on the last tick, per car (the snapshot's ack). */
  private readonly applied: number[];
  /** AI drivers, per car (AI fill from the start; players' cars get one when they drop). */
  private readonly ai: Array<InputSource | undefined>;
  /** Cars driven by AI this tick (AI fill, or a dropped player). */
  private readonly aiDriven: boolean[];
  private pending: Array<SimEvent & { tick: number }> = [];

  constructor(readonly ctx: SimContext, settings: RoomSettings, players: ReadonlyArray<Omit<Entrant, 'code'>>, readonly seed: number, readonly raceId = 1) {
    this.line = buildRacingLine(ctx.track);
    const physics = ctx.physics;
    const setup = normalizeSetup(ctx.track.json.baseSetup ?? physics.defaultCar.setup, ctx.catalog.specs.setup);
    const spec = ctx.catalog.specs.specs[settings.spec] ? settings.spec : physics.defaultCar.spec;
    // The AI fill takes teams no player has, in catalog order (then round again).
    const taken = new Set(players.map((p) => p.team));
    const free = ctx.catalog.teams.filter((t) => !taken.has(t.id));
    const pool = free.length ? free : ctx.catalog.teams;
    const aiCount = this.line ? Math.max(0, settings.aiCount) : 0;
    const lineup = assignDrivers(roster, aiCount, seed);
    const entrants: Entrant[] = [
      ...players.map((p) => ({ ...p, code: nameCode(p.name) })),
      ...lineup.map((d, k) => ({ name: d.name, code: d.code, team: pool[k % pool.length]!.id })),
    ];
    const scale = consumableScale(undefined, settings.laps, ctx.strategy);
    const builds: CarBuild[] = entrants.map((e, i) => {
      const b: CarBuild = { ...physics.defaultCar, setup, spec, team: e.team };
      // The AI's starting tyres: seeded, from the race length (as in single player).
      return e.player ? b : { ...b, compound: aiStartCompound(settings.laps, scale, ctx.strategy, (((seed ^ ((i + 1) * 2654435761)) >>> 0) % 1000) / 1000) };
    });
    this.world = createRaceWorld(ctx, builds, { laps: settings.laps, seed });
    this.drivers = entrants.map((e) => ({ code: e.code, name: e.name, ...(e.player ? { player: e.player } : {}) }));
    this.latest = entrants.map(() => undefined);
    this.applied = entrants.map(() => -1);
    const base = aiCfg.presets[settings.aiPreset] ?? aiCfg.presets[aiCfg.defaultPreset]!;
    const presetFor = (i: number) => () => (entrants[i]!.player ? base : driverPreset(base, lineup[i - players.length], aiCfg.skill?.spread ?? 0));
    this.ai = entrants.map((e, i) => (e.player ? undefined : this.makeAi(i, presetFor(i))));
    this.aiDriven = entrants.map((e) => !e.player);
    this.presetFor = presetFor;
  }
  private readonly presetFor: (i: number) => () => ReturnType<typeof driverPreset>;

  private makeAi(i: number, preset: () => ReturnType<typeof driverPreset>): InputSource {
    return aiInputSource(i, () => ({ world: this.world, ctx: this.ctx, line: this.line }), preset, () => aiCfg, 1000 + i + this.seed);
  }

  /** Car index for a player, -1 if they're not in this race. */
  carOf(player: string): number {
    return this.drivers.findIndex((d) => d.player === player);
  }

  /** A player's latest input. Older seqs (reordered or duplicated) are ignored. */
  setInput(car: number, msg: InputMsg): void {
    const was = this.latest[car];
    if (was && msg.seq <= was.seq) return;
    const { seq, ...input } = msg;
    this.latest[car] = { input: { throttle: clamp01(input.throttle), brake: clamp01(input.brake), steer: Math.max(-1, Math.min(1, input.steer || 0)), ...pick(input) }, seq };
  }

  /** Hand a player's car to the AI (dropped) or back to the player (rejoined). */
  setAiDriving(car: number, on: boolean): void {
    if (on && !this.ai[car]) this.ai[car] = this.makeAi(car, this.presetFor(car));
    this.aiDriven[car] = on;
    if (!on) this.latest[car] = undefined; // wait for the player's next input, not the one before the drop
  }

  /** Retired (dropped too long): parked where it is, no driver. It keeps its laps in the results. */
  retire(car: number): void {
    this.aiDriven[car] = false;
    this.latest[car] = { input: { ...NEUTRAL_INPUT, brake: 1 }, seq: Number.MAX_SAFE_INTEGER };
  }

  /** One fixed tick. */
  step(): void {
    const inputs = this.world.cars.map((_, i) => {
      if (this.aiDriven[i]) return this.ai[i]!.read(this.world.tick);
      const l = this.latest[i];
      if (l && l.seq !== Number.MAX_SAFE_INTEGER) this.applied[i] = l.seq;
      return l?.input ?? NEUTRAL_INPUT;
    });
    this.world = step(this.world, inputs, this.ctx);
    for (const e of this.world.events) this.pending.push({ ...e, tick: this.world.tick });
  }

  /** Snapshots for every client: call once per snapshot tick, then send `forCar(i)` to each. */
  takeSnapshot(): { forCar: (car: number) => SnapMsg } {
    const cars = this.world.cars.map(encodeCar);
    const events = this.pending;
    this.pending = [];
    const { tick, race } = this.world;
    return {
      forCar: (car) => ({
        raceId: this.raceId, tick, ack: car >= 0 ? this.applied[car]! : -1, cars, events,
        ...(car >= 0 && this.world.cars[car] ? { me: fullCar(this.world.cars[car]!) } : {}),
        ...(race ? { race } : {}),
      }),
    };
  }

  /** The starting world for clients (no trails). */
  startWorld(): WorldState {
    return { ...this.world, cars: this.world.cars.map(fullCar) };
  }
}

const clamp01 = (v: number) => (v > 1 ? 1 : v > 0 ? v : 0);
/** The optional CarInput fields a client may send (anything else is dropped). */
function pick(i: CarInput): Partial<CarInput> {
  const out: Partial<CarInput> = {};
  if (i.reset) out.reset = true;
  if (i.deploy) out.deploy = true;
  if (typeof i.engineMode === 'string') out.engineMode = i.engineMode;
  if (i.pitPlan && typeof i.pitPlan === 'object') out.pitPlan = i.pitPlan;
  return out;
}
