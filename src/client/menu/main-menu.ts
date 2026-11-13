// Main menu + pause menu (Main menu + profiles card, Phase A). Client only, no sim changes.
// The front door on load: PLAY (practice / quick race / race weekend with the session setup), PROFILE,
// SETTINGS (audio, effects, labels, keybinds), RECORDS (local PBs on this track), GARAGE (later).
// In a session, Esc opens the pause menu: resume, restart, settings, main menu.
// Every choice is written to the active profile; main.ts applies the profile and starts sessions.
import type { CarCatalog } from '../../sim';
import { BIND_ACTIONS, bindKey, completeKeybinds, DEFAULT_KEYBINDS, keyConflicts, keyLabel, RESERVED_KEYS, unbindKey, type BindAction } from './keybinds';
import { cleanName, nameCode, NAME_MAX, type Profile, type ProfileStore } from './profile';
import './main-menu.css';

export type StartKind = 'practice' | 'race' | 'weekend';
export interface RecordRow { spec: string; team: string; equal: boolean; lap: number }

export interface MenuDeps {
  catalog: CarCatalog;
  aiPresets: string[];
  /** The difficulty used when the profile hasn't picked one. */
  defaultPreset: string;
  /** This track has night art (or a preview): offer Day / Night. */
  nightAvailable: boolean;
  /** Track evolution is on: offer the starting state. */
  evolution: boolean;
  /** This track's id (setup presets are per track) and the setup sliders' range. */
  trackId: string;
  /** Setup fields in real units (specs.json setup.fields) and this track's base setup. */
  setupFields: Record<string, { label: string; unit: string; min: number; max: number; step: number }>;
  trackBase: () => { [field: string]: number };
  setupSlots: ReadonlyArray<{ slot: string; minus: string; plus: string }>;
  trackName: string;
  profiles: ProfileStore;
  /** Audio buses and their current volume. */
  volumes(): Array<{ bus: string; value: number }>;
  /** Local PBs on this track for the active profile. */
  records(): RecordRow[];
  /** The active profile changed (any field): apply it. */
  onProfile(p: Profile): void;
  onStart(kind: StartKind): void;
  onResume(): void;
  onRestart(): void;
  /** Leave the session for the main menu (the track keeps running behind it as an idle practice). */
  onQuit(): void;
  /** While a menu is open, the game shouldn't drive (keyboard suspended; the pause menu stops the sim). */
  onOpenChange(open: boolean, mode: 'main' | 'pause'): void;
}

type Tab = 'play' | 'profile' | 'settings' | 'records' | 'garage';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const lapText = (t: number) => { const m = Math.floor(t / 60); const s = (t - m * 60).toFixed(3).padStart(6, '0'); return m ? `${m}:${s}` : t.toFixed(3); };

export class MainMenu {
  private readonly root = document.createElement('div');
  private mode: 'main' | 'pause' | 'closed' = 'closed';
  private tab: Tab = 'play';
  /** Waiting for a key press to bind to this action. */
  private capturing: BindAction | undefined;
  /** When it opened (performance.now()): the key press that opened it mustn't also close it. */
  private openedAt = 0;

  constructor(private readonly d: MenuDeps) {
    this.root.className = 'jr-menu';
    this.root.addEventListener('click', (e) => this.click(e));
    this.root.addEventListener('input', (e) => this.input(e));
    this.root.addEventListener('change', (e) => this.change(e));
    window.addEventListener('keydown', (e) => this.key(e), true);
    document.body.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.mode !== 'closed';
  }

  open(mode: 'main' | 'pause', tab: Tab = mode === 'main' ? 'play' : 'play'): void {
    this.mode = mode;
    this.tab = tab;
    this.capturing = undefined;
    this.openedAt = performance.now();
    this.root.classList.add('open');
    this.d.onOpenChange(true, mode);
    this.render();
  }

  close(): void {
    if (this.mode === 'closed') return;
    const was = this.mode;
    this.mode = 'closed';
    this.capturing = undefined;
    this.root.classList.remove('open');
    this.d.onOpenChange(false, was);
  }

  private get p(): Profile {
    return this.d.profiles.active();
  }

  private save(p: Profile): void {
    const saved = this.d.profiles.save(p);
    this.d.onProfile(saved);
    this.render();
  }

  // ---- rendering ----

  private render(): void {
    if (this.mode === 'closed') return;
    const p = this.p;
    const tabs: Array<[Tab, string]> = this.mode === 'pause'
      ? [['play', 'Paused'], ['settings', 'Settings']]
      : [['play', 'Play'], ['profile', 'Profile'], ['settings', 'Settings'], ['records', 'Records'], ['garage', 'Garage']];
    this.root.innerHTML = `
      <div class="panel">
        <div class="side">
          <div class="brand">JAVASCRIPT<br/>RACING</div>
          <div class="who"><span class="helmet" style="background:${esc(p.helmet)}"></span><span><b>${esc(p.name)}</b><small>${nameCode(p.name)}</small></span></div>
          ${tabs.map(([t, label]) => `<button class="tab${t === this.tab ? ' on' : ''}" data-tab="${t}">${label}</button>`).join('')}
          <div class="track">${esc(this.d.trackName)}</div>
        </div>
        <div class="body">${this.mode === 'pause' && this.tab === 'play' ? this.pauseBody() : this.body(p)}</div>
      </div>`;
  }

  private body(p: Profile): string {
    switch (this.tab) {
      case 'play': return this.playBody(p);
      case 'profile': return this.profileBody(p);
      case 'settings': return this.settingsBody(p);
      case 'records': return this.recordsBody();
      default: return this.garageBody(p);
    }
  }

  private pauseBody(): string {
    return `<h2>Paused</h2>
      <div class="big">
        <button class="go" data-act="resume">RESUME</button>
        <button data-act="restart">RESTART</button>
        <button data-act="quit">MAIN MENU</button>
      </div>
      <p class="note">Esc resumes. Session settings (AI, laps, damage...) are on the main menu and apply to the next session.</p>`;
  }

  private choice<T extends string | number>(key: string, value: T, options: ReadonlyArray<readonly [T, string]>): string {
    return `<div class="choices">${options.map(([v, label]) => `<button data-set="${key}" data-val="${v}" class="${v === value ? 'on' : ''}">${label}</button>`).join('')}</div>`;
  }

  private playBody(p: Profile): string {
    const s = p.settings, specs = Object.keys(this.d.catalog.specs.specs);
    const preset = s.ai.preset || this.d.defaultPreset;
    return `<h2>Play</h2>
      <div class="big">
        <button class="go" data-start="practice">PRACTICE</button>
        <button class="go" data-start="race">QUICK RACE</button>
        <button class="go" data-start="weekend">RACE WEEKEND</button>
      </div>
      <p class="note">Race weekend: practice, then qualifying (best lap sets the grid), then the race. Quick race goes straight to the grid.</p>
      <div class="rows">
        <label>Team</label><select data-field="team"><option value="">Default</option>${this.d.catalog.teams.map((t) => `<option value="${t.id}"${t.id === p.team ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        <label>Spec</label>${this.choice('spec', s.spec ?? specs[0]!, specs.map((x) => [x, x] as const))}
        <label>AI opponents</label>${this.choice('aiCount', s.ai.count, [0, 1, 3, 5, 9].map((n) => [n, String(n)] as const))}
        <label>AI difficulty</label>${this.choice('aiPreset', preset, this.d.aiPresets.map((x) => [x, x] as const))}
        <label>Race laps</label>${this.choice('laps', s.race.laps, [3, 5, 10, 15, 20].map((n) => [n, String(n)] as const))}
        <label>Grid</label>${this.choice('grid', s.race.grid, [['random', 'Random'], ['pole', 'Pole'], ['back', 'Back']] as const)}
        <label>Start tyres</label>${this.choice('compound', s.race.compound, [['soft', 'Soft'], ['medium', 'Medium'], ['hard', 'Hard']] as const)}
        <label>Start fuel</label>${this.choice('fuel', s.race.fuel, [[1, 'Full'], [0.75, '3/4'], [0.5, '1/2'], [0.25, '1/4']] as const)}
        <label>Fuel + tyre use</label>${this.choice('length', s.race.length, [['off', 'Normal'], ['matched', 'Matched to race length']] as const)}
        <label>Car performance</label>${this.choice('perf', s.perf, [['team', 'Team stats'], ['equal', 'Equal']] as const)}
        <label>Damage</label>${this.choice('damage', s.damage, [['off', 'Off'], ['visual', 'Visual only'], ['realistic', 'Realistic']] as const)}
        ${this.d.evolution ? `<label>Track</label>${this.choice('trackStart', s.trackStart, [['green', 'Green'], ['medium', 'Medium'], ['rubbered', 'Rubbered']] as const)}` : ''}
        ${this.d.nightAvailable ? `<label>Time of day</label>${this.choice('night', s.night ? 'night' : 'day', [['day', 'Day'], ['night', 'Night']] as const)}` : ''}
      </div>
      <p class="note">Races use at least one AI. Equal: every team performs the same, AI drivers differ by skill. Realistic damage costs grip; the pits repair it. Tyres: soft is quickest and wears fastest, hard the reverse; set the next stop while driving with 1 / 2 / 3 (tyres), 4 / 5 (fuel), 6 (change tyres), 7 (repair). Matched: fuel and tyres go faster in a short race, so it still needs a stop.</p>`;
  }

  private garageBody(p: Profile): string {
    const base = this.d.trackBase(), cur = { ...base, ...(p.setups[this.d.trackId] ?? {}) } as Record<string, number>;
    return `<h2>Garage: setup for ${esc(this.d.trackName)}</h2>
      <p class="note">Starts from this track's base setup (the AI runs it too); your changes are saved for this track in your profile. Every setting trades something. You can also change it in practice when stopped in your pit box (car panel), where the balance readout shows which axle lets go first in each corner.</p>
      <div class="rows setup">${this.d.setupSlots.map((s) => {
        const f = this.d.setupFields[s.slot]!, v = Number.isFinite(cur[s.slot]) ? cur[s.slot]! : base[s.slot]!;
        const mark = v === base[s.slot] ? '' : ` <small class="trade">(base ${base[s.slot]})</small>`;
        return `<label>${esc(f.label)}</label><div class="inline"><small class="trade">${esc(s.minus)}</small><input type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${v}" data-setup="${s.slot}" /><small class="trade">${esc(s.plus)}</small><b class="notch">${v} ${esc(f.unit)}</b>${mark}</div>`;
      }).join('')}</div>
      <div class="inline"><button data-act="neutralSetup">TRACK BASE</button></div>
      <p class="note">Liveries come here with the livery card (phase 2).</p>`;
  }

  private profileBody(p: Profile): string {
    const all = this.d.profiles.list();
    return `<h2>Profile</h2>
      <div class="rows">
        <label>Profile</label>
        <div class="inline"><select data-field="active">${all.map((q) => `<option value="${q.id}"${q.id === p.id ? ' selected' : ''}>${esc(q.name)}</option>`).join('')}</select>
          <button data-act="newProfile">NEW</button><button data-act="deleteProfile"${all.length < 2 ? ' disabled' : ''}>DELETE</button></div>
        <label>Name</label><div class="inline"><input data-field="name" maxlength="${NAME_MAX * 2}" value="${esc(p.name)}" spellcheck="false" /><span class="code" data-id="code">${nameCode(p.name)}</span></div>
        <label>Helmet</label><input type="color" data-field="helmet" value="${esc(p.helmet)}" />
        <label>Backup</label><div class="inline"><button data-act="export">EXPORT</button><label class="file">IMPORT<input type="file" accept=".json,application/json" data-field="import" /></label></div>
      </div>
      <p class="note">Up to ${NAME_MAX} characters; the three-letter code is what the running order and car labels show. Profiles live in this browser (export to move one). Each profile keeps its own settings, keys and lap records.</p>
      <p class="note" data-id="profileMsg"></p>`;
  }

  private settingsBody(p: Profile): string {
    const s = p.settings, conflicts = keyConflicts(p.keybinds);
    const rows = BIND_ACTIONS.map(({ id, label }) => `
      <label>${label}</label>
      <div class="keys">${p.keybinds[id].map((k) => `<span class="key${conflicts.has(k) ? ' clash' : ''}" title="${conflicts.has(k) ? `Also: ${conflicts.get(k)!.filter((a) => a !== id).join(', ')}` : ''}">${esc(keyLabel(k))}<button data-unbind="${id}" data-key="${esc(k)}" title="Remove">×</button></span>`).join('')}
        <button class="add${this.capturing === id ? ' wait' : ''}" data-bind="${id}">${this.capturing === id ? 'press a key…' : '+'}</button></div>`).join('');
    return `<h2>Settings</h2>
      <div class="rows">
        ${this.d.volumes().map((v) => `<label>Volume: ${v.bus}</label><input type="range" min="0" max="1" step="0.05" value="${v.value}" data-volume="${v.bus}" />`).join('')}
        <label>Effects</label>${this.choice('vfx', s.vfx, [['high', 'High'], ['low', 'Low'], ['off', 'Off']] as const)}
        <label>Car labels</label>${this.choice('labels', s.labels, [['off', 'Off'], ['position', 'Position'], ['name', 'Position + name']] as const)}
      </div>
      <h3>Controls</h3>
      <div class="rows binds">${rows}</div>
      <div class="inline"><button data-act="resetKeys">DEFAULT KEYS</button>${conflicts.size ? `<span class="warn">${conflicts.size} key${conflicts.size > 1 ? 's are' : ' is'} on more than one control (red)</span>` : ''}</div>
      <p class="note">Esc and Tab are kept for the menus. Grid slots stay on 0-9 (practice).</p>`;
  }

  private recordsBody(): string {
    const rows = this.d.records().sort((a, b) => a.spec.localeCompare(b.spec) || Number(a.equal) - Number(b.equal) || a.lap - b.lap);
    const team = (id: string) => this.d.catalog.teams.find((t) => t.id === id)?.name ?? id;
    return `<h2>Records: ${esc(this.d.trackName)}</h2>
      ${rows.length ? `<table class="rec"><tr><th>Spec</th><th>Cars</th><th>Team</th><th>Best lap</th></tr>${rows.map((r) => `<tr><td>${esc(r.spec)}</td><td>${r.equal ? 'Equal' : 'Team stats'}</td><td>${esc(team(r.team))}</td><td><b>${lapText(r.lap)}</b></td></tr>`).join('')}</table>` : '<p class="note">No laps yet on this track for this profile.</p>'}
      <p class="note">Local personal bests (this browser, this profile). The online leaderboard replaces this with card 09.</p>`;
  }

  // ---- events ----

  private click(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('button');
    if (!t) return;
    const ds = t.dataset, p = this.p;
    if (ds.tab) { this.tab = ds.tab as Tab; this.capturing = undefined; return this.render(); }
    if (ds.start) { this.close(); return this.d.onStart(ds.start as StartKind); }
    if (ds.act === 'resume') { this.close(); return this.d.onResume(); }
    if (ds.act === 'restart') { this.close(); return this.d.onRestart(); }
    if (ds.act === 'quit') { this.d.onQuit(); return this.open('main'); }
    if (ds.act === 'newProfile') { const n = this.d.profiles.create(`Player ${this.d.profiles.list().length + 1}`, p); this.d.onProfile(n); this.tab = 'profile'; return this.render(); }
    if (ds.act === 'deleteProfile') { if (confirm(`Delete the profile "${p.name}" and its settings? (Its lap records stay in this browser.)`)) { this.d.onProfile(this.d.profiles.remove(p.id)); this.render(); } return; }
    if (ds.act === 'export') return this.exportProfile(p);
    if (ds.act === 'resetKeys') return this.save({ ...p, keybinds: completeKeybinds(DEFAULT_KEYBINDS) });
    if (ds.act === 'neutralSetup') { const setups = { ...p.setups }; delete setups[this.d.trackId]; return this.save({ ...p, setups }); }
    if (ds.bind) { this.capturing = ds.bind as BindAction; return this.render(); }
    if (ds.unbind) return this.save({ ...p, keybinds: unbindKey(p.keybinds, ds.unbind as BindAction, ds.key!) });
    if (ds.set) return this.set(ds.set, ds.val!);
  }

  private set(key: string, val: string): void {
    const p = this.p, s = p.settings;
    const num = Number(val);
    const next = { ...s };
    if (key === 'aiCount') next.ai = { ...s.ai, count: num };
    else if (key === 'aiPreset') next.ai = { ...s.ai, preset: val };
    else if (key === 'laps') next.race = { ...s.race, laps: num };
    else if (key === 'grid') next.race = { ...s.race, grid: val as typeof s.race.grid };
    else if (key === 'compound') next.race = { ...s.race, compound: val as typeof s.race.compound };
    else if (key === 'fuel') next.race = { ...s.race, fuel: num };
    else if (key === 'length') next.race = { ...s.race, length: val as typeof s.race.length };
    else if (key === 'perf') next.perf = val as typeof s.perf;
    else if (key === 'damage') next.damage = val as typeof s.damage;
    else if (key === 'vfx') next.vfx = val as typeof s.vfx;
    else if (key === 'labels') next.labels = val as typeof s.labels;
    else if (key === 'spec') next.spec = val;
    else if (key === 'night') next.night = val === 'night';
    else if (key === 'trackStart') next.trackStart = val as typeof s.trackStart;
    this.save({ ...p, settings: next });
  }

  private input(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.dataset.field === 'name') {
      const code = this.root.querySelector('[data-id="code"]');
      if (code) code.textContent = nameCode(cleanName(t.value) || 'Player');
    } else if (t.dataset.setup) {
      const b = t.parentElement?.querySelector('.notch');
      if (b) b.textContent = `${t.value} ${this.d.setupFields[t.dataset.setup]?.unit ?? ''}`;
    } else if (t.dataset.volume) {
      const p = this.p;
      // Volumes apply live; saved on release (change) so dragging doesn't rewrite the profile every step.
      this.d.onProfile({ ...p, settings: { ...p.settings, volumes: { ...p.settings.volumes, [t.dataset.volume]: Number(t.value) } } });
    }
  }

  private change(e: Event): void {
    const t = e.target as HTMLInputElement & HTMLSelectElement;
    const p = this.p, f = t.dataset.field;
    if (f === 'name') { const name = cleanName(t.value); if (name) this.save({ ...p, name }); else this.render(); }
    else if (f === 'helmet') this.save({ ...p, helmet: t.value });
    else if (f === 'team') this.save({ ...p, team: t.value });
    else if (f === 'active') { const q = this.d.profiles.setActive(t.value); if (q) { this.d.onProfile(q); this.render(); } }
    else if (f === 'import') void this.importProfile(t);
    else if (t.dataset.setup) this.save({ ...p, setups: { ...p.setups, [this.d.trackId]: { ...this.d.trackBase(), ...(p.setups[this.d.trackId] ?? {}), [t.dataset.setup]: Number(t.value) } } });
    else if (t.dataset.volume) this.save({ ...p, settings: { ...p.settings, volumes: { ...p.settings.volumes, [t.dataset.volume]: Number(t.value) } } });
  }

  private key(e: KeyboardEvent): void {
    if (this.mode === 'closed' || e.timeStamp <= this.openedAt) return; // (timestamps are whole ms: same ms = same press)
    if (this.capturing) {
      e.preventDefault();
      e.stopImmediatePropagation(); // the keyboard input listens on window too
      const action = this.capturing;
      this.capturing = undefined;
      if (e.code === 'Escape' || RESERVED_KEYS.has(e.code)) return this.render();
      return this.save({ ...this.p, keybinds: bindKey(this.p.keybinds, action, e.code) });
    }
    if (e.code === 'Escape' && this.mode === 'pause') {
      e.preventDefault();
      e.stopImmediatePropagation(); // the keyboard input listens on window too
      this.close();
      this.d.onResume();
    }
  }

  private exportProfile(p: Profile): void {
    const blob = new Blob([this.d.profiles.exportJson(p)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jr2-profile-${cleanName(p.name).replace(/[^\p{L}\p{N}]+/gu, '-') || 'player'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private async importProfile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const p = this.d.profiles.importJson(await file.text());
      this.d.onProfile(p);
      this.render();
      const msg = this.root.querySelector('[data-id="profileMsg"]');
      if (msg) msg.textContent = `Imported "${p.name}" as a new profile.`;
    } catch {
      const msg = this.root.querySelector('[data-id="profileMsg"]');
      if (msg) msg.textContent = 'That file isn\'t a profile export.';
    }
  }
}
