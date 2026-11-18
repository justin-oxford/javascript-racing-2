// The Colyseus room (card 07): one room = one race, joined by a 4-letter code. The server owns the room,
// not the host: the host only picks the settings and presses start, and leaving hands that to someone else.
// The race itself is the sim from /src/sim, run by RaceHost at a fixed 60 Hz; clients send inputs and
// get snapshots back. Race events (lights, positions, finish, results) all come from this sim.
import { Room, type Client } from '@colyseus/core';
import physicsJson from '../../config/physics.json' with { type: 'json' };
import raceJson from '../../config/race.json' with { type: 'json' };
import teamsJson from '../../config/teams.json' with { type: 'json' };
import specsJson from '../../config/specs.json' with { type: 'json' };
import trackDefaults from '../../config/track-defaults.json' with { type: 'json' };
import { TICK_HZ, type WorldState } from '../sim';
import { aiCfg, RaceHost } from './race-host';
import { DROP_GRACE_SEC, MAX_CARS, SNAP_EVERY, type InputMsg, type LobbyMsg, type LobbyPlayer, type RoomPhase, type RoomSettings, type StartMsg } from './protocol';
import { raceContext, roomTracks } from './tracks';

const teams = (teamsJson as { teams: Array<{ id: string; name: string }> }).teams;
const specs = Object.keys((specsJson as { specs: Record<string, unknown> }).specs);
const codes = new Set<string>();
/** A fresh 4-letter join code (no I or O: they read as 1 and 0). */
function newCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
    if (!codes.has(c)) { codes.add(c); return c; }
  }
}

interface Player extends LobbyPlayer {
  client: Client;
  /** When the car was handed to the AI (ms), 0 = driving it. */
  droppedAt: number;
}

export interface RoomOptions {
  name?: string;
  team?: string;
  /** Tests: run the race faster than real time (ticks per 1/60 s). */
  timeScale?: number;
}

export class RaceRoom extends Room {
  /** Tests: sees the server's world after every tick (the truth the clients are checked against). */
  static tap: ((code: string, world: WorldState) => void) | undefined;
  override maxClients = MAX_CARS;
  private code = '';
  private hostId = '';
  private phase: RoomPhase = 'lobby';
  private settings!: RoomSettings;
  private readonly players = new Map<string, Player>();
  /** Players whose session ended mid-race: their car is AI-driven until it retires or they rejoin by name. */
  private readonly dropped: Array<{ name: string; car: number; at: number }> = [];
  private host: RaceHost | undefined;
  private raceId = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private timeScale = 1;
  private resultsAt = 0;

  override onCreate(options: RoomOptions): void {
    this.code = newCode();
    this.roomId = this.code;
    this.timeScale = Math.max(1, Math.min(20, Number(options?.timeScale) || 1));
    const tracks = roomTracks();
    const preferred = (trackDefaults as { defaultTrack?: string }).defaultTrack;
    this.settings = {
      track: tracks.find((t) => t.id === preferred)?.id ?? tracks[0]?.id ?? '',
      laps: raceJson.defaultLaps,
      spec: (physicsJson as { defaultCar: { spec: string } }).defaultCar.spec,
      aiCount: 3,
      aiPreset: aiCfg.defaultPreset,
    };
    const tracksList = tracks;
    this.lobbyExtras = { tracks: tracksList, specs, presets: Object.keys(aiCfg.presets), teams: teams.map((t) => ({ id: t.id, name: t.name })) };

    this.onMessage('settings', (client, s: Partial<RoomSettings>) => {
      if (client.sessionId !== this.hostId || this.phase !== 'lobby' || !s || typeof s !== 'object') return;
      const next = { ...this.settings };
      if (typeof s.track === 'string' && tracksList.some((t) => t.id === s.track)) next.track = s.track;
      if (Number.isInteger(s.laps) && s.laps! >= 1 && s.laps! <= 99) next.laps = s.laps!;
      if (typeof s.spec === 'string' && specs.includes(s.spec)) next.spec = s.spec;
      if (Number.isInteger(s.aiCount) && s.aiCount! >= 0 && s.aiCount! < MAX_CARS) next.aiCount = s.aiCount!;
      if (typeof s.aiPreset === 'string' && aiCfg.presets[s.aiPreset]) next.aiPreset = s.aiPreset;
      this.settings = next;
      this.sendLobby();
    });
    this.onMessage('me', (client, m: { name?: string; team?: string }) => {
      const p = this.players.get(client.sessionId);
      if (!p || this.phase !== 'lobby' || !m) return;
      if (typeof m.name === 'string') p.name = cleanName(m.name);
      if (typeof m.team === 'string' && teams.some((t) => t.id === m.team)) p.team = m.team;
      this.sendLobby();
    });
    this.onMessage('start', (client) => {
      if (client.sessionId !== this.hostId) return;
      this.startRace();
    });
    this.onMessage('lobby', (client) => {
      if (client.sessionId !== this.hostId) return;
      this.endRace();
    });
    this.onMessage('input', (client, m: InputMsg) => {
      const p = this.players.get(client.sessionId);
      if (!this.host || !p || p.car < 0 || p.droppedAt || !m || typeof m.seq !== 'number') return;
      this.host.setInput(p.car, m);
    });
    this.onMessage('ping', (client, t: number) => client.send('pong', t));
  }
  private lobbyExtras!: Pick<LobbyMsg, 'tracks' | 'specs' | 'presets' | 'teams'>;

  override onJoin(client: Client, options: RoomOptions): void {
    const name = cleanName(options?.name ?? 'Player');
    const usedTeams = new Set([...this.players.values()].map((p) => p.team));
    const team = typeof options?.team === 'string' && teams.some((t) => t.id === options.team) ? options.team : teams.find((t) => !usedTeams.has(t.id))?.id ?? teams[0]!.id;
    const p: Player = { id: client.sessionId, name, team, car: -1, connected: true, client, droppedAt: 0 };
    // Rejoining a running race by name inside the grace window takes the car back from the AI.
    if (this.host) {
      const k = this.dropped.findIndex((d) => d.name === name && Date.now() - d.at < DROP_GRACE_SEC * 1000);
      if (k >= 0) {
        const d = this.dropped.splice(k, 1)[0]!;
        p.car = d.car;
        this.host.drivers[d.car]!.player = client.sessionId;
        this.host.setAiDriving(d.car, false);
      }
    }
    this.players.set(client.sessionId, p);
    if (!this.hostId || !this.players.has(this.hostId)) this.hostId = client.sessionId;
    this.sendLobby();
    if (this.host) client.send('start', this.startMsg(p.car));
  }

  override async onDrop(client: Client): Promise<void> {
    const p = this.players.get(client.sessionId);
    if (!p) return;
    p.connected = false;
    p.droppedAt = Date.now();
    if (this.host && p.car >= 0) this.host.setAiDriving(p.car, true);
    this.sendLobby();
    this.allowReconnection(client, DROP_GRACE_SEC);
  }

  override onReconnect(client: Client): void {
    const p = this.players.get(client.sessionId);
    if (!p) return;
    p.client = client;
    p.connected = true;
    p.droppedAt = 0;
    if (this.host && p.car >= 0) this.host.setAiDriving(p.car, false);
    this.sendLobby();
    if (this.host) client.send('start', this.startMsg(p.car));
  }

  override onLeave(client: Client): void {
    const p = this.players.get(client.sessionId);
    if (!p) return;
    this.players.delete(client.sessionId);
    if (this.host && p.car >= 0 && this.host.drivers[p.car]?.player === p.id) {
      // Left (or never came back): the AI keeps the car for the rest of the window, then it retires.
      this.host.setAiDriving(p.car, true);
      this.dropped.push({ name: p.name, car: p.car, at: p.droppedAt || Date.now() });
    }
    if (this.hostId === p.id) this.hostId = [...this.players.keys()][0] ?? '';
    this.sendLobby();
  }

  override onDispose(): void {
    if (this.timer) clearInterval(this.timer);
    codes.delete(this.code);
  }

  private startRace(): void {
    const racers = [...this.players.values()].filter((p) => p.connected);
    if (!racers.length) return;
    const ctx = raceContext(this.settings.track);
    const aiCount = Math.min(this.settings.aiCount, MAX_CARS - racers.length);
    const seed = (Math.random() * 2 ** 32) >>> 0;
    this.raceId++;
    this.host = new RaceHost(ctx, { ...this.settings, aiCount }, racers.map((p) => ({ player: p.id, name: p.name, team: p.team })), seed, this.raceId);
    for (const p of this.players.values()) p.car = this.host.carOf(p.id);
    this.dropped.length = 0;
    this.phase = 'race';
    this.resultsAt = 0;
    this.sendLobby();
    for (const p of this.players.values()) p.client.send('start', this.startMsg(p.car));
    this.runLoop();
  }

  private endRace(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.host = undefined;
    this.phase = 'lobby';
    for (const p of this.players.values()) p.car = -1;
    this.sendLobby();
  }

  /** Fixed 60 Hz from wall time (timers on Windows are coarse: catch up whole ticks, never step by frame time). */
  private runLoop(): void {
    if (this.timer) clearInterval(this.timer);
    const tickMs = 1000 / TICK_HZ / this.timeScale;
    let next = performance.now();
    this.timer = setInterval(() => {
      const host = this.host;
      if (!host) return;
      let n = 0;
      while (performance.now() >= next && n < 120) {
        next += tickMs;
        n++;
        host.step();
        RaceRoom.tap?.(this.code, host.world);
        this.retireDropped();
        if (host.world.tick % SNAP_EVERY === 0) {
          const snap = host.takeSnapshot();
          for (const p of this.players.values()) if (p.connected) p.client.send('snap', snap.forCar(p.car));
        }
      }
      if (n === 120) next = performance.now(); // 2 s behind (debugger, sleep): drop the backlog rather than spiral
      // Results are in: keep the room on them, stop simulating a little later.
      if (host.world.race?.phase === 'results') {
        if (!this.resultsAt) this.resultsAt = performance.now();
        else if (performance.now() - this.resultsAt > 3000 && this.timer) { clearInterval(this.timer); this.timer = undefined; }
      }
    }, 4);
  }

  private retireDropped(): void {
    for (let k = this.dropped.length - 1; k >= 0; k--) {
      const d = this.dropped[k]!;
      if (Date.now() - d.at >= DROP_GRACE_SEC * 1000) {
        this.host?.retire(d.car);
        this.dropped.splice(k, 1);
      }
    }
  }

  private startMsg(you: number): StartMsg {
    const host = this.host!;
    return { raceId: host.raceId, track: this.settings.track, world: host.startWorld(), drivers: host.drivers, you };
  }

  private sendLobby(): void {
    const players: LobbyPlayer[] = [...this.players.values()].map(({ id, name, team, car, connected }) => ({ id, name, team, car, connected }));
    for (const p of this.players.values())
      if (p.connected) p.client.send('lobby', { code: this.code, hostId: this.hostId, you: p.id, phase: this.phase, settings: this.settings, players, ...this.lobbyExtras } satisfies LobbyMsg);
  }
}

const cleanName = (s: string): string => String(s).replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Player';
