// Online mode (card 07, ?online): the lobby, the connection and the latency simulator, glued to the game.
// main.ts keeps drawing worlds exactly as offline; online, the worlds come from the server's snapshots.
import type { CarInput, CarState, SimContext, WorldState } from '../../sim';
import { DEFAULT_PORT, type CarDriver, type LobbyMsg, type StartMsg } from '../../server/protocol';
import { LAG_PRESETS, LatencySim } from './latency';
import { LobbyUi } from './lobby-ui';
import { NetClient } from './net-client';

export interface OnlineDeps {
  /** The track this page loaded (a room on another track reloads the page onto it). */
  trackId: string;
  teams: ReadonlyArray<{ id: string; name: string; color: string }>;
  me: { name: string; team: string };
  /** The client's sim context: my own car is predicted with it (step 6). */
  ctx: SimContext;
  /** Keys go to the lobby while it's open. */
  setKeysSuspended(on: boolean): void;
  /** A race (re)started: its first world with my car as car 0, and who drives each car (same order). */
  onStart(world: WorldState, drivers: CarDriver[], me: { name: string }): void;
  /** The room went back to the lobby (or we left it). */
  onLobby(): void;
}

const LAG_KEY = 'jr2.net.lag';

/** Where the server is: ?server=ws://..., else VITE_SERVER_URL, else this host on the dev port. */
export function serverUrl(params: URLSearchParams): string {
  return params.get('server') ?? (import.meta.env.VITE_SERVER_URL as string | undefined) ?? `ws://${location.hostname || 'localhost'}:${DEFAULT_PORT}`;
}

export class OnlineMode {
  readonly net: NetClient;
  readonly ui: LobbyUi;
  private readonly lag: LatencySim;
  private connecting = false;

  constructor(private readonly deps: OnlineDeps, params: URLSearchParams) {
    // Latency simulator: ?lag=ms, else what this browser used last; ON at 100 ms by default in dev.
    const stored = (() => { try { return localStorage.getItem(LAG_KEY); } catch { return null; } })();
    const want = Number(params.get('lag') ?? stored ?? (import.meta.env.DEV ? 100 : 0));
    this.lag = new LatencySim(LAG_PRESETS.includes(want as (typeof LAG_PRESETS)[number]) ? want : 0);
    this.net = new NetClient(serverUrl(params), this.lag, {
      lobby: (m) => this.onLobby(m),
      start: (m) => this.onStart(m),
      closed: (reason) => {
        this.ui.reset();
        this.ui.setError(`Disconnected: ${reason}`);
        this.ui.show(true);
        this.deps.setKeysSuspended(true);
        this.deps.onLobby();
      },
    });
    // ?predict=0: no prediction (my car drawn from snapshots like the rest: step 5 behaviour, for comparing).
    this.net.predict = params.get('predict') !== '0';
    this.net.predictCtx = deps.ctx;
    this.ui = new LobbyUi({
      create: (me) => void this.connect(undefined, me),
      join: (code, me) => void this.connect(code, me),
      me: (m) => this.net.setMe(m),
      settings: (s) => this.net.setSettings(s),
      start: () => this.net.startRace(),
      leave: () => void this.net.leave().then(() => { this.ui.reset(); this.setUrlCode(undefined); }),
      lag: (ms) => this.setLag(ms),
    }, deps.teams, deps.me, this.lag.pingMs);
    deps.setKeysSuspended(true);
    // A tab in the background stops ticking: don't leave the server holding its last input (full throttle...).
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.net.sendInput({ throttle: 0, brake: 1, steer: 0 }); });
    // ?online=ABCD: straight into that room (a reload, or a link from a friend).
    const code = (params.get('online') ?? '').toUpperCase();
    if (/^[A-Z]{4}$/.test(code)) void this.connect(code, deps.me);
  }

  get racing(): boolean { return this.net.racing; }

  /** Every client tick: my input up to the server (and into my predicted car: returns it before/after). */
  tick(input: CarInput): { was: CarState; me: CarState } | undefined {
    return this.racing && !this.ui.open ? this.net.sendInput(input) : undefined;
  }

  /** Results screen buttons. */
  restart(): void { if (this.net.isHost) this.net.startRace(); }
  menu(): void {
    if (this.net.isHost) this.net.backToLobby();
    else this.showLobby(true);
  }

  showLobby(on: boolean): void {
    this.ui.show(on);
    this.deps.setKeysSuspended(on);
  }

  /** The badge line during a race. */
  updateBadge(): void {
    const l = this.net.lobby;
    if (!this.racing || !l) return this.ui.setBadge(undefined);
    const kb = (this.net.snapRate.perSec / 1024).toFixed(0);
    const p = this.net.predictor, c = this.net.corr;
    const pred = p ? `predict ${p.pendingCount} ahead, fix ${(c.last * 100).toFixed(0)} cm (max ${(c.max * 100).toFixed(0)})` : 'no prediction';
    this.ui.setBadge(`ONLINE ${l.code} · ping ${Math.round(this.net.rttMs)} ms · lag sim ${this.lag.pingMs ? `${this.lag.pingMs} ms` : 'off'} · ${kb} KB/s · ${pred}`);
  }

  private setLag(ms: number): void {
    this.lag.pingMs = ms;
    this.ui.setLag(ms);
    try { localStorage.setItem(LAG_KEY, String(ms)); } catch { /* fine */ }
  }

  private async connect(code: string | undefined, me: { name: string; team: string }): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    try {
      await this.net.connect(code, me);
    } catch (e) {
      this.ui.setError(code ? `Couldn't join ${code}: ${(e as Error).message || e}` : `Couldn't reach the server at ${this.net.url}. Is it running (npm run server)?`);
    } finally {
      this.connecting = false;
    }
  }

  private onLobby(m: LobbyMsg): void {
    this.setUrlCode(m.code);
    // The room is on another track: reload onto it (the seat is kept: reconnection token).
    if (m.settings.track !== this.deps.trackId) return this.reloadOnto(m.settings.track, m.code);
    this.ui.update(m);
    if (m.phase === 'lobby' && !this.ui.open) { this.showLobby(true); this.deps.onLobby(); }
  }

  private onStart(m: StartMsg): void {
    if (m.track !== this.deps.trackId) return this.reloadOnto(m.track, this.net.lobby?.code ?? '');
    const first = this.net.buffer.latest?.world;
    if (!first) return;
    this.showLobby(false);
    const me = this.net.lobby?.players.find((p) => p.id === this.net.lobby?.you);
    this.deps.onStart(first, this.net.drivers, { name: me?.name ?? this.deps.me.name });
  }

  private reloadOnto(track: string, code: string): void {
    const q = new URLSearchParams(location.search);
    q.set('track', track);
    q.set('online', code);
    location.search = q.toString();
  }

  /** Keep the room code in the address bar, so a reload goes back in. */
  private setUrlCode(code: string | undefined): void {
    const q = new URLSearchParams(location.search);
    q.set('online', code ?? '');
    history.replaceState(null, '', `${location.pathname}?${q.toString().replace(/(^|&)online=(?=&|$)/, '$1online')}`);
  }
}
