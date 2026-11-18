// The browser's end of multiplayer (card 07): one Colyseus room, the latency simulator on every message
// both ways, inputs up every tick, snapshots down into a buffer the renderer draws from. The client never
// decides anything about the race: lights, positions, laps and results all arrive in snapshots.
import { Client, type Room } from '@colyseus/sdk';
import netCfg from '../../../config/net.json' with { type: 'json' };
import type { CarInput, CarState, SimContext, WorldState } from '../../sim';
import { ROOM_NAME, worldFromSnap, type CarDriver, type LobbyMsg, type RoomSettings, type SnapMsg, type StartMsg } from '../../server/protocol';
import { LatencySim } from './latency';
import { Predictor, type Correction } from './predictor';
import { permuteWorld, SnapBuffer, viewOrder } from './view';

/** A snapshot ready to draw: the server's world, permuted so my car is car 0. */
export interface ViewSnap {
  tick: number;
  ack: number;
  world: WorldState;
}

export interface NetHooks {
  lobby(m: LobbyMsg): void;
  start(m: StartMsg): void;
  /** The connection is gone for good (left, kicked, server down). */
  closed(reason: string): void;
}

const TOKEN_KEY = 'jr2.net.token';

export class NetClient {
  room: Room | undefined;
  lobby: LobbyMsg | undefined;
  race: StartMsg | undefined;
  /** Drivers in view order (my car first). */
  drivers: CarDriver[] = [];
  readonly buffer = new SnapBuffer<ViewSnap>();
  /** How far behind the server clock remote cars are drawn. */
  interpDelayMs = netCfg.interpDelayMs;
  /** Step 6: predict my own car (needs `predictCtx`). Off = my car drawn from snapshots like everyone else. */
  predict = true;
  /** The sim context prediction steps with (the client's own, same track and config as the server). */
  predictCtx: SimContext | undefined;
  predictor: Predictor | undefined;
  /** What's still to blend out of my car's drawn pose after corrections (old - new), metres / radians. */
  readonly offset: Correction = { dx: 0, dy: 0, dh: 0 };
  /** Correction sizes (metres): the last one, and the largest since the race started. */
  readonly corr = { last: 0, max: 0, snaps: 0 };
  /** Every correction's size, metres (tests). */
  onCorrection: ((m: number, c: Correction) => void) | undefined;
  /** Time spent rewinding and replaying, ms (cost readout). */
  reconcileMs = 0;
  /** Measured round trip (ping/pong through the latency simulator), ms. */
  rttMs = 0;
  /** Bytes of snapshot per second, roughly (JSON size, for the debug line). */
  snapRate = { bytes: 0, since: 0, perSec: 0 };
  /** The newest snapshot's world in server car order (tests, and the client-side AI driver in them). */
  rawLatest: WorldState | undefined;
  private seq = 0;
  private perm: number[] = [];
  /** Last full state per car (server order): the start world, then my own car from every snapshot. */
  private base: CarState[] = [];
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(readonly url: string, readonly lag: LatencySim, private readonly hooks: NetHooks) {}

  /** Create a room (no code) or join one by code. A reload rejoins the same seat (reconnection token). */
  async connect(code: string | undefined, me: { name: string; team: string; timeScale?: number }): Promise<void> {
    const client = new Client(this.url);
    // The seat token is saved only as the page goes away (a reload, or a reload onto the room's track) and
    // used once: a duplicated tab (which copies sessionStorage) must not take this tab's seat.
    const saved = readToken();
    clearToken();
    let room: Room | undefined;
    if (code && saved?.code === code) room = await client.reconnect(saved.token).catch(() => undefined);
    room ??= code ? await client.joinById(code, me) : await client.create(ROOM_NAME, me);
    this.room = room;
    (globalThis as { addEventListener?: (t: string, f: () => void) => void }).addEventListener?.('pagehide', () => { if (this.room) writeToken(this.room.roomId, this.room.reconnectionToken); });
    const via = <T>(f: (m: T) => void) => (m: T) => this.lag.in(() => f(m));
    room.onMessage('lobby', via((m: LobbyMsg) => { this.lobby = m; this.hooks.lobby(m); }));
    room.onMessage('start', via((m: StartMsg) => this.onStart(m)));
    room.onMessage('snap', via((m: SnapMsg) => this.onSnap(m)));
    room.onMessage('pong', via((t: number) => { this.rttMs = performance.now() - t; }));
    room.onLeave((code, reason) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.hooks.closed(reason || `left (${code})`);
    });
    this.pingTimer = setInterval(() => this.send('ping', performance.now()), 1000);
  }

  /** Send through the latency simulator. */
  send(type: string, msg?: unknown): void {
    const room = this.room;
    if (room) this.lag.out(() => room.send(type, msg));
  }

  get isHost(): boolean {
    return !!this.lobby && this.lobby.hostId === this.lobby.you;
  }

  setSettings(s: Partial<RoomSettings>): void { this.send('settings', s); }
  setMe(m: { name?: string; team?: string }): void { this.send('me', m); }
  startRace(): void { this.send('start'); }
  backToLobby(): void { this.send('lobby'); }

  /** In a race (start received, room not back in the lobby). */
  get racing(): boolean {
    return !!this.race && this.lobby?.phase === 'race';
  }

  /**
   * My input for this tick, numbered, up to the server and (step 6) straight into my predicted car.
   * Returns my car before and after the predicted tick (sound, effects), if predicting.
   */
  sendInput(input: CarInput): { was: CarState; me: CarState } | undefined {
    if (!this.racing || !this.race || this.race.you < 0) return undefined;
    const msg = { ...input, seq: this.seq++ };
    this.send('input', msg);
    const p = this.predictor;
    if (!p) return undefined;
    p.tick(msg);
    const was = p.prev?.cars[p.you], me = p.world?.cars[p.you];
    return was && me ? { was, me } : undefined;
  }

  async leave(): Promise<void> {
    clearToken();
    await this.room?.leave();
  }

  private onStart(m: StartMsg): void {
    this.race = m;
    this.rawLatest = m.world;
    this.perm = viewOrder(m.world.cars.length, m.you);
    this.base = m.world.cars.map((c) => c);
    this.drivers = this.perm.map((s) => m.drivers[s]!);
    this.buffer.clear();
    this.buffer.push({ tick: m.world.tick, ack: -1, world: permuteWorld(m.world, this.perm) }, performance.now());
    this.predictor = this.predict && this.predictCtx && m.you >= 0 ? new Predictor(this.predictCtx, m.you, { ...(m.world.surface ? { surface: m.world.surface } : {}), ...(m.world.settings ? { settings: m.world.settings } : {}) }) : undefined;
    this.predictor?.start(m.world);
    Object.assign(this.offset, { dx: 0, dy: 0, dh: 0 });
    Object.assign(this.corr, { last: 0, max: 0, snaps: 0 });
    this.hooks.start(m);
  }

  private onSnap(m: SnapMsg): void {
    const race = this.race;
    if (!race || m.raceId !== race.raceId) return; // a snapshot from the race before
    const now = performance.now();
    const r = this.snapRate;
    r.bytes += JSON.stringify(m).length;
    if (now - r.since > 1000) { r.perSec = r.bytes / ((now - r.since) / 1000); r.bytes = 0; r.since = now; }
    const world = worldFromSnap(m, this.base, race.you);
    if (!this.rawLatest || m.tick > this.rawLatest.tick) this.rawLatest = world;
    if (m.me && race.you >= 0) this.base[race.you] = m.me;
    const newest = !this.buffer.latest || m.tick > this.buffer.latest.tick;
    this.buffer.push({ tick: m.tick, ack: m.ack, world: permuteWorld(world, this.perm) }, now);
    if (newest && this.predictor) {
      const t0 = performance.now();
      this.correct(this.predictor.reconcile(world, m.ack));
      this.reconcileMs += performance.now() - t0;
    }
  }

  /** A correction moves my car's physics at once; on screen it's blended out over correction.blendSec. */
  private correct(c: Correction | undefined): void {
    if (!c) return;
    const m = Math.hypot(c.dx, c.dy), cfg = netCfg.correction;
    this.corr.last = m;
    this.corr.max = Math.max(this.corr.max, m);
    this.onCorrection?.(m, c);
    if (m > cfg.snapM || Math.abs(c.dh) > cfg.snapRad) { // a reset to track or a teleport: no slide across the map
      Object.assign(this.offset, { dx: 0, dy: 0, dh: 0 });
      this.corr.snaps++;
      return;
    }
    this.offset.dx += c.dx;
    this.offset.dy += c.dy;
    this.offset.dh += c.dh;
  }

  /** My car as drawn now: between the last two predicted ticks (`tickAlpha`), plus what's left of corrections. */
  private ownCar(tickAlpha: number): CarState | undefined {
    const p = this.predictor;
    const a = p?.prev?.cars[p.you], b = p?.world?.cars[p.you];
    if (!a || !b) return undefined;
    const t = Math.max(0, Math.min(1, tickAlpha));
    let dh = b.heading - a.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    return { ...b, x: a.x + (b.x - a.x) * t + this.offset.dx, y: a.y + (b.y - a.y) * t + this.offset.dy, heading: a.heading + dh * t + this.offset.dh };
  }

  /**
   * What to draw now: everyone else between the two snapshots either side of `interpDelayMs` behind the
   * server clock; my own car (predicting) where my inputs have it now, `tickAlpha` between client ticks.
   * `frameSec` decays the correction blend.
   */
  view(nowMs: number, tickAlpha = 1, frameSec = 0): { prev: WorldState; curr: WorldState; alpha: number; passed: ViewSnap[]; renderTick: number } | undefined {
    const t = this.buffer.renderTick(nowMs, this.interpDelayMs);
    if (t === undefined) return undefined;
    const br = this.buffer.bracket(t);
    if (!br) return undefined;
    const k = Math.exp(-frameSec / Math.max(1e-3, netCfg.correction.blendSec));
    this.offset.dx *= k; this.offset.dy *= k; this.offset.dh *= k;
    const me = this.ownCar(tickAlpha);
    // Mine is already placed: the same car in both, so the renderer's blend leaves it there.
    const withMe = (w: WorldState): WorldState => (me ? { ...w, cars: [me, ...w.cars.slice(1)] } : w);
    return { prev: withMe(br.a.world), curr: withMe(br.b.world), alpha: br.alpha, passed: this.buffer.take(t), renderTick: t };
  }
}

function readToken(): { code: string; token: string } | undefined {
  try { return JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null') ?? undefined; } catch { return undefined; }
}
function writeToken(code: string, token: string): void {
  try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ code, token })); } catch { /* private window: no rejoin on reload */ }
}
function clearToken(): void {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}
