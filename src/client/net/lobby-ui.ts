// Online lobby (card 07): create a room or join one by its 4-letter code, pick name + team; the host
// picks track, laps, spec and the AI fill, and starts. Plus the net badge shown during a race
// (code, ping, latency simulator toggle). Plain DOM over the game.
import type { LobbyMsg, RoomSettings } from '../../server/protocol';
import { LAG_PRESETS } from './latency';

export interface LobbyHooks {
  create(me: { name: string; team: string }): void;
  join(code: string, me: { name: string; team: string }): void;
  me(m: { name?: string; team?: string }): void;
  settings(s: Partial<RoomSettings>): void;
  start(): void;
  leave(): void;
  lag(ms: number): void;
}

const CSS = `
.lobby{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(8,10,14,.72);z-index:50;font:14px/1.4 system-ui,sans-serif;color:#eee}
.lobby[hidden]{display:none}
.lobby .box{background:#15181f;border:1px solid #333a46;border-radius:10px;padding:20px 24px;width:min(560px,calc(100vw - 32px));box-shadow:0 10px 40px #000a}
.lobby h2{margin:0 0 12px;font-size:20px;letter-spacing:.04em}
.lobby .code{font:700 40px/1 ui-monospace,monospace;letter-spacing:.2em;color:#ffdd00}
.lobby label{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:6px 0}
.lobby input,.lobby select{background:#0d0f14;color:#eee;border:1px solid #3a4250;border-radius:5px;padding:5px 8px;font:inherit;min-width:0}
.lobby input.c{width:7ch;text-transform:uppercase;font-family:ui-monospace,monospace;letter-spacing:.15em}
.lobby button{background:#2b6fd6;color:#fff;border:0;border-radius:6px;padding:8px 14px;font:600 14px system-ui;cursor:pointer}
.lobby button.ghost{background:#2a2f3a}
.lobby button:disabled{opacity:.45;cursor:default}
.lobby .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}
.lobby .err{color:#ff7a6a;min-height:1.4em;margin-top:8px}
.lobby ul{list-style:none;padding:0;margin:8px 0;border-top:1px solid #2a2f3a}
.lobby li{display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #2a2f3a}
.lobby .sw{width:12px;height:12px;border-radius:2px;display:inline-block}
.lobby .dim{color:#8a93a3}
.lobby fieldset{border:1px solid #2a2f3a;border-radius:6px;margin:10px 0 0;padding:6px 12px}
.lobby fieldset:disabled{opacity:.75}
.netbadge{position:fixed;right:10px;bottom:10px;z-index:40;background:#000b;color:#ddd;font:12px ui-monospace,monospace;padding:4px 8px;border-radius:5px;cursor:pointer;user-select:none}
.netbadge[hidden]{display:none}
`;

export class LobbyUi {
  readonly root: HTMLDivElement;
  readonly badge: HTMLDivElement;
  private msg: LobbyMsg | undefined;
  private error = '';

  constructor(private readonly hooks: LobbyHooks, private readonly teams: ReadonlyArray<{ id: string; name: string; color: string }>, private me: { name: string; team: string }, private lagMs: number) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    this.root = document.createElement('div');
    this.root.className = 'lobby';
    this.badge = document.createElement('div');
    this.badge.className = 'netbadge';
    this.badge.hidden = true;
    this.badge.title = 'Click: latency simulator off / 50 / 100 / 200 ms ping';
    this.badge.addEventListener('click', () => this.hooks.lag(this.nextLag()));
    document.body.append(this.root, this.badge);
    // Keys typed into the lobby never reach the game.
    for (const t of ['keydown', 'keyup'] as const) this.root.addEventListener(t, (e) => e.stopPropagation());
    this.render();
  }

  get open(): boolean { return !this.root.hidden; }
  show(on: boolean): void { this.root.hidden = !on; }

  setError(e: string): void { this.error = e; this.render(); }
  setLag(ms: number): void { this.lagMs = ms; this.render(); }
  update(m: LobbyMsg): void { this.msg = m; this.error = ''; this.render(); }
  /** Back to the connect screen (left the room). */
  reset(): void { this.msg = undefined; this.render(); }

  /** The net badge's text (race on), or hide it. */
  setBadge(text: string | undefined): void {
    this.badge.hidden = text === undefined;
    if (text !== undefined && this.badge.textContent !== text) this.badge.textContent = text;
  }

  private nextLag(): number {
    const i = LAG_PRESETS.indexOf(this.lagMs as (typeof LAG_PRESETS)[number]);
    return LAG_PRESETS[(i + 1) % LAG_PRESETS.length]!;
  }

  private lagSelect(): string {
    return `<label>Latency simulator (ping) <select data-k="lag">${LAG_PRESETS.map((v) => `<option value="${v}"${v === this.lagMs ? ' selected' : ''}>${v ? `${v} ms` : 'off'}</option>`).join('')}</select></label>`;
  }

  private render(): void {
    const m = this.msg;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const teamOpts = (sel: string) => this.teams.map((t) => `<option value="${t.id}"${t.id === sel ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
    if (!m) {
      this.root.innerHTML = `<div class="box"><h2>ONLINE RACE</h2>
        <label>Name <input data-k="name" maxlength="16" value="${esc(this.me.name)}"></label>
        <label>Team <select data-k="team">${teamOpts(this.me.team)}</select></label>
        ${this.lagSelect()}
        <div class="row"><button data-a="create">Create room</button>
          <span class="dim">or</span> <input class="c" data-k="code" maxlength="4" placeholder="CODE"> <button data-a="join" class="ghost">Join</button></div>
        <div class="err">${esc(this.error)}</div></div>`;
    } else {
      const host = m.hostId === m.you, s = m.settings, me = m.players.find((p) => p.id === m.you);
      const color = (team: string) => this.teams.find((t) => t.id === team)?.color ?? '#888';
      const max = 10 - m.players.length;
      const racing = m.phase === 'race';
      this.root.innerHTML = `<div class="box"><h2>ROOM <span class="code">${m.code}</span></h2>
        <div class="dim">Friends join with this code. ${racing ? 'A race is running: you join the next one.' : host ? 'You are the host.' : 'Waiting for the host to start.'}</div>
        <ul>${m.players.map((p) => `<li><span class="sw" style="background:${color(p.team)}"></span>${esc(p.name)}${p.id === m.hostId ? ' <span class="dim">(host)</span>' : ''}${p.id === m.you ? ' <span class="dim">(you)</span>' : ''}${p.connected ? '' : ' <span class="dim">(reconnecting)</span>'}<span class="dim" style="margin-left:auto">${esc(this.teams.find((t) => t.id === p.team)?.name ?? p.team)}</span></li>`).join('')}
          ${s.aiCount ? `<li class="dim">+ ${Math.min(s.aiCount, max)} AI (${esc(s.aiPreset)})</li>` : ''}</ul>
        <label>Name <input data-k="name" maxlength="16" value="${esc(me?.name ?? this.me.name)}"></label>
        <label>Team <select data-k="team">${teamOpts(me?.team ?? this.me.team)}</select></label>
        <fieldset ${host && !racing ? '' : 'disabled'}><legend class="dim">Race (host)</legend>
          <label>Track <select data-k="track">${m.tracks.map((t) => `<option value="${t.id}"${t.id === s.track ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
          <label>Laps <input data-k="laps" type="number" min="1" max="99" value="${s.laps}" style="width:6ch"></label>
          <label>Spec <select data-k="spec">${m.specs.map((v) => `<option${v === s.spec ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
          <label>AI cars <input data-k="aiCount" type="number" min="0" max="9" value="${s.aiCount}" style="width:6ch"></label>
          <label>AI level <select data-k="aiPreset">${m.presets.map((v) => `<option${v === s.aiPreset ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        </fieldset>
        ${this.lagSelect()}
        <div class="row"><button data-a="start" ${host && !racing ? '' : 'disabled'}>Start race</button><button data-a="leave" class="ghost">Leave</button></div>
        <div class="err">${esc(this.error)}</div></div>`;
    }
    this.wire();
  }

  private wire(): void {
    const q = <T extends HTMLElement>(k: string) => this.root.querySelector<T>(`[data-k="${k}"]`);
    const name = q<HTMLInputElement>('name'), team = q<HTMLSelectElement>('team');
    const meNow = () => ({ name: name?.value.trim() || 'Player', team: team?.value ?? this.me.team });
    name?.addEventListener('change', () => { this.me = meNow(); if (this.msg) this.hooks.me({ name: this.me.name }); });
    team?.addEventListener('change', () => { this.me = meNow(); if (this.msg) this.hooks.me({ team: this.me.team }); });
    q<HTMLSelectElement>('lag')?.addEventListener('change', (e) => this.hooks.lag(Number((e.target as HTMLSelectElement).value)));
    for (const k of ['track', 'spec', 'aiPreset'] as const) q<HTMLSelectElement>(k)?.addEventListener('change', (e) => this.hooks.settings({ [k]: (e.target as HTMLSelectElement).value }));
    for (const k of ['laps', 'aiCount'] as const) q<HTMLInputElement>(k)?.addEventListener('change', (e) => this.hooks.settings({ [k]: Math.round(Number((e.target as HTMLInputElement).value)) }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.a;
      if (a === 'create') this.hooks.create(meNow());
      else if (a === 'join') {
        const code = (q<HTMLInputElement>('code')?.value ?? '').trim().toUpperCase();
        if (!/^[A-Z]{4}$/.test(code)) return this.setError('A room code is 4 letters.');
        this.hooks.join(code, meNow());
      } else if (a === 'start') this.hooks.start();
      else if (a === 'leave') this.hooks.leave();
    }));
  }
}
