// One race on the server (card 07): the real sim, stepped at 60 Hz by the room. Players' cars take the
// latest input each client sent; every other car (AI fill, and dropped players) is driven by 05's AI
// InputSource, right here on the server. No Colyseus in this file, so tests can drive it directly.
import aiJson from '../../config/ai.json' with { type: 'json' };
import driversJson from '../../config/drivers.json' with { type: 'json' };
import netCfg from '../../config/net.json' with { type: 'json' };
import {
  aiInputSource, aiStartCompound, cornerTable, assignDrivers, buildRacingLine, consumableScale, createRaceWorld, driverPreset, normalizeSetup, step,
  NEUTRAL_INPUT, TICK_HZ, type AiConfig, type CarBuild, type CarInput, type DriverDef, type InputSource, type RacingLine, type SimContext, type SimEvent, type WorldState,
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

/**
 * Measure the AI's corner tables for one track + spec ahead of time (the server does this at boot for the
 * default race), so pressing Start doesn't stall the box. A table depends on spec, setup and starting tyre,
 * not the team (car-limits.ts measures on one team), so: one per compound, and the players' default.
 */
export function warmCornerTables(ctx: SimContext, spec: string): number {
  if (!aiCfg.measuredLimits) return 0;
  const p = ctx.physics, setup = normalizeSetup(ctx.track.json.baseSetup ?? p.defaultCar.setup, ctx.catalog.specs.setup);
  const base: CarBuild = { ...p.defaultCar, setup, spec };
  const builds = [base, ...(Object.keys(ctx.strategy.compounds) as Array<CarBuild['compound']>).map((compound) => ({ ...base, compound }))];
  for (const b of builds) cornerTable(ctx, b);
  return builds.length;
}

export class RaceHost {
  world: WorldState;
  readonly line: RacingLine | undefined;
  readonly drivers: CarDriver[];
  /** Inputs from each car's player, oldest first, not yet used (a small jitter buffer: one per tick). */
  private readonly queue: Array<Array<{ input: CarInput; seq: number }>>;
  /** Per car: ticks the queue ran dry (last input repeated) and inputs dropped to catch up. Each shifts the
   *  player's timeline a tick against their prediction (a correction of one tick of travel). */
  readonly inputStats: Array<{ repeats: number; drops: number }>;
  /** Per car: the shortest the queue has been since the window began, and when it began (tick). */
  private readonly qMin: Array<{ min: number; since: number }>;
  /** The input each player's car used last tick (repeated when the queue runs dry). */
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
    // The AI measures each car's cornering limits the first time it drives it (~0.8 s per build), which
    // would freeze the whole room at lights out. Measure them now, before the race clock runs (cached per
    // build, so a rerun of the same grid is free). Players' cars too: the AI takes over if they drop.
    if (aiCfg.measuredLimits) for (const b of builds) cornerTable(ctx, b);
    this.drivers = entrants.map((e) => ({ code: e.code, name: e.name, ...(e.player ? { player: e.player } : {}) }));
    this.latest = entrants.map(() => undefined);
    this.queue = entrants.map(() => []);
    this.inputStats = entrants.map(() => ({ repeats: 0, drops: 0 }));
    this.qMin = entrants.map(() => ({ min: Infinity, since: 0 }));
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

  /** Is the AI driving car i this tick (AI fill, or a player who dropped)? */
  aiDriving(i: number): boolean {
    return !!this.aiDriven[i];
  }

  /** Car index for a player, -1 if they're not in this race. */
  carOf(player: string): number {
    return this.drivers.findIndex((d) => d.player === player);
  }

  /**
   * A player's input, queued: each tick uses the next one, so the server applies exactly the inputs the
   * client numbered, one per tick, as the client's prediction replays them (card 07 step 6; step 3 used
   * the latest only, which skips and repeats inputs under jitter). Older seqs are ignored.
   */
  setInput(car: number, msg: InputMsg): void {
    const q = this.queue[car]!;
    const last = q[q.length - 1] ?? this.latest[car];
    if (last && msg.seq <= last.seq) return;
    const { seq, ...input } = msg;
    q.push({ input: { throttle: clamp01(input.throttle), brake: clamp01(input.brake), steer: Math.max(-1, Math.min(1, input.steer || 0)), ...pick(input) }, seq });
  }

  /** Hand a player's car to the AI (dropped) or back to the player (rejoined). */
  setAiDriving(car: number, on: boolean): void {
    if (on && !this.ai[car]) this.ai[car] = this.makeAi(car, this.presetFor(car));
    this.aiDriven[car] = on;
    if (!on) { this.latest[car] = undefined; this.queue[car]!.length = 0; } // the player's next input, not the ones before the drop
  }

  /** Retired (dropped too long): parked where it is, no driver. It keeps its laps in the results. */
  retire(car: number): void {
    this.aiDriven[car] = false;
    this.queue[car]!.length = 0;
    this.latest[car] = { input: { ...NEUTRAL_INPUT, brake: 1 }, seq: Number.MAX_SAFE_INTEGER };
  }

  /** One fixed tick. */
  step(): void {
    const inputs = this.world.cars.map((_, i) => {
      if (this.aiDriven[i]) return this.ai[i]!.read(this.world.tick);
      const q = this.queue[i]!;
      this.trimQueue(i);
      const next = q.shift();
      if (!next && this.latest[i]) this.inputStats[i]!.repeats++;
      if (next) this.latest[i] = next;
      const l = this.latest[i];
      if (l && l.seq !== Number.MAX_SAFE_INTEGER) this.applied[i] = l.seq;
      // Ran dry: the last input again, minus one-shot requests.
      return next ? next.input : l ? { throttle: l.input.throttle, brake: l.input.brake, steer: l.input.steer, ...(l.input.deploy ? { deploy: true } : {}), ...(l.input.reset ? { reset: true } : {}) } : NEUTRAL_INPUT;
    });
    this.world = step(this.world, inputs, this.ctx);
    for (const e of this.world.events) this.pending.push({ ...e, tick: this.world.tick });
  }

  /**
   * Keep each player's input queue as short as their link allows: drop inputs only when it has stayed deeper
   * than `spare` for a whole window (lag that's built up and stayed), never for a burst that drains itself.
   */
  private trimQueue(i: number): void {
    const q = this.queue[i]!, w = this.qMin[i]!, cfg = netCfg.inputBuffer, stats = this.inputStats[i]!;
    const drop = (n: number) => { if (n > 0) { q.splice(0, n); stats.drops += n; } };
    drop(q.length - cfg.cap);
    w.min = Math.min(w.min, q.length);
    if (this.world.tick - w.since >= cfg.windowSec * TICK_HZ) {
      drop(Math.min(q.length, w.min) - cfg.spare);
      w.min = Infinity;
      w.since = this.world.tick;
    }
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
