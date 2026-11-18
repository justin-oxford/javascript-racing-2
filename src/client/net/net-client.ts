// The browser's end of multiplayer (card 07): one Colyseus room, the latency simulator on every message
// both ways, inputs up every tick, snapshots down into a buffer the renderer draws from. The client never
// decides anything about the race: lights, positions, laps and results all arrive in snapshots.
import { Client, type Room } from '@colyseus/sdk';
import type { CarInput, CarState, WorldState } from '../../sim';
import { ROOM_NAME, worldFromSnap, type CarDriver, type LobbyMsg, type RoomSettings, type SnapMsg, type StartMsg } from '../../server/protocol';
import { LatencySim } from './latency';
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
  interpDelayMs = 100;
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

  /** My input for this tick, numbered. */
  sendInput(input: CarInput): void {
    if (!this.racing || !this.race || this.race.you < 0) return;
    this.send('input', { ...input, seq: this.seq++ });
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
    this.buffer.push({ tick: m.tick, ack: m.ack, world: permuteWorld(world, this.perm) }, now);
  }

  /** What to draw now: two snapshots and how far between them (`interpDelayMs` behind the server clock). */
  view(nowMs: number): { prev: WorldState; curr: WorldState; alpha: number; passed: ViewSnap[]; renderTick: number } | undefined {
    const t = this.buffer.renderTick(nowMs, this.interpDelayMs);
    if (t === undefined) return undefined;
    const br = this.buffer.bracket(t);
    if (!br) return undefined;
    return { prev: br.a.world, curr: br.b.world, alpha: br.alpha, passed: this.buffer.take(t), renderTick: t };
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
