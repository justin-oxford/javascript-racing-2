// The v0.16 HUD, rebuilt: top timing bar, timing dropdown, spec/team menu, vehicle + setup panel.
// It reads sim state and the session; it never writes sim state. Choices go out through callbacks.
import { normalizeSetup, snapSetupValue, tyreLife, wearGrip } from '../../sim';
import type { CarSetup, CarState, CatalogLike } from './hud-types';
import type { Session, Tile } from './session';
import type { HudConfig } from './timing-lines';
import './hud.css';

export interface HudCallbacks {
  onSpec(spec: string): void;
  onTeam(team: string): void;
  onSetup(slot: keyof CarSetup, value: number): void;
  /** AI opponents: how many (0-9) and which difficulty preset. Restarts practice from the grid. */
  onAi(count: number, preset: string): void;
  /** Start a race (card 06) with the menu's AI count, difficulty, team and spec. */
  onRace(laps: number, grid: 'random' | 'pole' | 'back'): void;
  /** Leave a race for practice. */
  onPractice(): void;
  /** Practice: put the car back in the pits (the v0.16 R). Ignored in a session. */
  onPits(): void;
  /** Car damage setting (Car damage card): off, visual only, realistic. Restarts like the AI choice. */
  onDamage(mode: 'off' | 'visual' | 'realistic'): void;
  /** Car performance: team stats, or equalised cars (Equal performance card). Restarts like the AI choice. */
  onPerf(mode: 'team' | 'equal'): void;
  /** Start a race weekend (practice -> qualifying -> race) of the menu's race length. */
  onWeekend(laps: number): void;
  /** Car labels over the track: off / position / position + team code (also the L key). */
  onLabels(mode: 'off' | 'position' | 'name'): void;
}

const fmt = (t: number | undefined, plus = false): string => {
  if (t === undefined || !Number.isFinite(t)) return '---';
  const sign = t < 0 ? '-' : plus ? '+' : '';
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = (a - m * 60).toFixed(3).padStart(6, '0');
  return m ? `${sign}${m}:${s}` : `${sign}${(a).toFixed(3)}`;
};

/** Setup (Car setup overhaul card), real units: what - and + trade, for the labels (ranges in specs.json). */
export const SETUP_LABELS: Array<{ slot: keyof CarSetup; minus: string; plus: string }> = [
  { slot: 'frontWingDeg', minus: 'less front grip, less drag', plus: 'more front grip, more drag' },
  { slot: 'rearWingDeg', minus: 'less rear grip, faster on straights', plus: 'more rear grip, slower on straights' },
  { slot: 'topSpeedKph', minus: 'short: acceleration', plus: 'long: top speed' },
  { slot: 'brakeBiasPct', minus: 'rearward: rotates, rear can lock', plus: 'forward: stable, fronts lock' },
  { slot: 'arbFront', minus: 'softer front: more turn-in', plus: 'stiffer front: understeer' },
  { slot: 'arbRear', minus: 'softer rear: more stable', plus: 'stiffer rear: oversteer' },
  { slot: 'rideFrontMm', minus: 'low: downforce, kerbs bite', plus: 'high: less downforce, forgiving' },
  { slot: 'rideRearMm', minus: 'low: downforce, kerbs bite', plus: 'high: less downforce, forgiving' },
  { slot: 'pressurePsi', minus: 'low: grip, more wear, lazy', plus: 'high: less grip and wear, sharp' },
];
const SLOTS = SETUP_LABELS;

export class Hud {
  private readonly root: HTMLElement;
  private readonly el: Record<string, HTMLElement> = {};
  private panels = { timing: false, menu: false, car: false };
  private carPanelAuto = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cfg: HudConfig,
    private readonly catalog: CatalogLike,
    private readonly cb: HudCallbacks,
    private readonly trackHeightPx: () => number,
    siteUrl: (p: string) => string,
    private readonly aiPresets: readonly string[] = [],
  ) {
    const fonts = document.createElement('style');
    fonts.textContent = ['Regular', 'Bold', 'Wide']
      .map((w) => `@font-face { font-family: "Formula1 ${w}"; src: url("${siteUrl(`assets/Fonts/Formula1-${w}.otf`)}"); font-display: swap; }`)
      .join('\n');
    document.head.appendChild(fonts);
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.style.setProperty('--purple', cfg.colors.purple);
    this.root.style.setProperty('--green', cfg.colors.green);
    this.root.style.setProperty('--yellow', cfg.colors.yellow);
    this.root.style.setProperty('--invalid', cfg.colors.invalid);
    this.root.style.setProperty('--invalid-live', cfg.colors.invalidLive);
    this.root.style.setProperty('--tile', cfg.colors.tile);
    this.root.style.setProperty('--bar', cfg.colors.bar);
    this.root.style.setProperty('--text', cfg.colors.text);
    this.root.style.setProperty('--icon-menu', `url("${siteUrl('assets/images/menuWHT.png')}")`);
    this.root.style.setProperty('--icon-time', `url("${siteUrl('assets/images/timeWHT.png')}")`);
    this.root.innerHTML = this.markup();
    document.body.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[data-id]').forEach((e) => (this.el[e.dataset.id!] = e));
    this.wire();
    this.layout();
    window.addEventListener('resize', () => this.layout());
  }

  /** Wet weather card: the weather tag in the bar ('' hides it). */
  setWeather(text: string, raining: boolean): void {
    const e = this.el.weather!;
    if (e.textContent !== text) e.textContent = text;
    e.classList.toggle('on', !!text);
    e.classList.toggle('rain', raining);
  }

  /** Height of the top bar in canvas backing pixels (so the K debug text can sit below it). */
  barHeightBackingPx(): number {
    return this.el.bar!.getBoundingClientRect().height * (window.devicePixelRatio || 1);
  }

  private markup(): string {
    const tiles = ['Sector 1', 'Sector 2', 'Sector 3', 'Lap'];
    const specs = Object.entries(this.catalog.specs.specs);
    return `
      <div class="reset-note" data-id="resetNote"></div>
      <div class="pit-board" data-id="pitBoard"></div>
      <div class="damage-mini" data-id="damageMini" title="Damage: front wing, rear wing, left and right suspension">
        <svg viewBox="0 0 40 70" width="100%" height="100%">
          <rect x="4" y="2" width="32" height="7" rx="1.5" data-zone="frontWing" />
          <rect x="11" y="11" width="18" height="48" rx="6" class="body" />
          <rect x="3" y="18" width="6" height="34" rx="1.5" data-zone="left" />
          <rect x="31" y="18" width="6" height="34" rx="1.5" data-zone="right" />
          <rect x="6" y="61" width="28" height="7" rx="1.5" data-zone="rearWing" />
        </svg>
      </div>
      <div class="hud-bar" data-id="bar">
        <button class="hud-icon menu" data-id="menuBtn" title="Menu"></button>
        <div class="lap-speed">Lap:<b data-id="lap">0</b>Speed:<b data-id="speed">--</b>kph</div>
        <div class="current">Time:<b data-id="time">---</b></div>
        <div class="tow" data-id="tow" title="Slipstream: less drag behind another car">TOW</div>
        <div class="weather" data-id="weather" title="Weather: rain now, or when it's coming"></div>
        <div class="ers" title="Engine mode (E) and battery: hold Shift or / to deploy">
          <span class="compound" data-id="compound" title="Tyre compound (pit board: 1 / 2 / 3)">M</span>
          <span class="mode" data-id="ersMode">STD</span>
          <span class="batt"><span data-id="battFill"></span></span>
          <span class="fuel-delta" data-id="fuelDelta" title="Laps of fuel left minus laps to go"></span>
        </div>
        <table class="sectors">
          <tr class="idents">${tiles.map((t) => `<td>${t}</td>`).join('')}</tr>
          <tr>${tiles.map((_, i) => `<td><div class="tile${i === 3 ? ' lap' : ''}" data-id="tile${i}">---</div></td>`).join('')}</tr>
          <tr class="splits">${tiles.map((_, i) => `<td data-id="split${i}">---</td>`).join('')}</tr>
        </table>
        <button class="hud-icon time" data-id="timeBtn" title="Timing"></button>
      </div>
      <div class="hud-drop timing" data-id="timingPanel">
        <div class="title">PERSONAL BESTS</div>
        <table class="pb">
          <tr class="idents"><td>Sector 1</td><td>Sector 2</td><td>Sector 3</td><td>Best Lap</td></tr>
          <tr>${[0, 1, 2, 3].map((i) => `<td><div class="pbtile" data-id="pb${i}">---</div></td>`).join('')}</tr>
        </table>
        <hr />
        <table class="pb other">
          <tr class="idents"><td>Avg Lap</td><td>Optimal Lap</td><td>Last Lap</td><td>Laps</td></tr>
          <tr><td><div class="pbtile" data-id="avg">---</div></td><td><div class="pbtile" data-id="optimal">---</div></td>
              <td><div class="pbtile" data-id="last">---</div></td><td><div class="pbtile" data-id="laps">0</div></td></tr>
          <tr class="desc"><td>All completed valid laps, even the slow ones.</td><td>Your lap if every sector matched your best.</td><td></td><td></td></tr>
        </table>
        <div class="hint" data-id="noLines"></div>
      </div>
      <div class="hud-drop menu" data-id="menuPanel">
        <div class="title">SELECT SPEC</div>
        <div class="choices specs">${specs.map(([id, s]) => `<button data-spec="${id}" title="${s.name}">${id}</button>`).join('')}</div>
        <div class="note">Changing spec resets your times.</div>
        <div class="title">SELECT TEAM</div>
        <div class="choices teams">${this.catalog.teams.map((t) => `<button data-team="${t.id}">${t.name}</button>`).join('')}</div>
        <div class="note">Changing team resets the car but keeps your times, so you can compare.</div>
        <div class="title">AI OPPONENTS</div>
        <div class="choices ai-count">${[0, 1, 3, 5, 9].map((n) => `<button data-ai-count="${n}">${n}</button>`).join('')}</div>
        <div class="choices ai-level">${this.aiPresets.map((p) => `<button data-ai-preset="${p}">${p}</button>`).join('')}</div>
        <div class="note">Changing AI restarts everyone from the grid.</div>
        <div class="title">DAMAGE</div>
        <div class="choices damage">${(['off', 'visual', 'realistic'] as const).map((m) => `<button data-damage="${m}">${{ off: 'Off', visual: 'Visual only', realistic: 'Realistic' }[m]}</button>`).join('')}</div>
        <div class="note">Realistic: hits cost grip and downforce by where they land (a broken front wing understeers); the pits repair it, which makes the stop longer. Visual only: shown, no effect.</div>
        <div class="title">CAR PERFORMANCE</div>
        <div class="choices perf"><button data-perf="team">Team stats</button><button data-perf="equal">Equal</button></div>
        <div class="note">Equal: every team's car performs the same (spec and setup still count); AI drivers differ by skill instead.</div>
        <div class="title">RACE</div>
        <div class="choices race-laps">${[3, 5, 10, 15].map((n) => `<button data-race-laps="${n}">${n} laps</button>`).join('')}</div>
        <div class="choices race-grid">${(['random', 'pole', 'back'] as const).map((g) => `<button data-race-grid="${g}">${{ random: 'Random grid', pole: 'Pole', back: 'Back of grid' }[g]}</button>`).join('')}</div>
        <div class="choices race-go"><button data-id="weekend">RACE WEEKEND</button><button data-id="raceStart">QUICK RACE</button><button data-id="practice">PRACTICE</button></div>
        <div class="choices"><button data-id="toPits">BACK TO PITS</button></div>
        <div class="note">Stuck? Hold R for a second to rejoin the track behind where you left it (lap invalidated; in a race you wait out a short penalty). Back to pits: practice only.</div>
        <div class="note">Race weekend: practice, then qualifying (best lap sets the grid), then the race. Quick race skips to the grid. Races use the AI count above (at least 1) and difficulty.</div>
        <div class="title">CAR LABELS (L)</div>
        <div class="choices labels">${(['off', 'position', 'name'] as const).map((m) => `<button data-labels="${m}">${{ off: 'Off', position: 'Position', name: 'Position + name' }[m]}</button>`).join('')}</div>
      </div>
      <div class="hud-drop car" data-id="carPanel">
        <div class="title">Vehicle Information</div>
        <div class="vehicle">
          <div class="tyres">${['FL', 'FR', 'RL', 'RR'].map((n, i) => `<div class="tyre" data-id="tyre${i}"><small>${n}</small><span data-id="tyrePct${i}">100%</span></div>`).join('')}</div>
          <div class="fuel"><div>FUEL LEVEL</div><div class="gauge"><div class="level" data-id="fuelLevel"></div><span data-id="fuelPct">100</span></div></div>
        </div>
        <div class="title setup-title">Car Setup Adjustments</div>
        <div class="setup notched">${SLOTS.map((s) => `
          <div class="nslot" title="- ${s.minus} / + ${s.plus}"><span class="lbl">${this.catalog.specs.setup.fields[s.slot].label.toUpperCase()}</span>
            <button class="dn" data-slot="${s.slot}" data-dir="-1">-</button>
            <span class="track"><span class="mark" data-id="setupMark-${s.slot}"></span></span>
            <button class="up" data-slot="${s.slot}" data-dir="1">+</button>
            <span class="value" data-id="setup-${s.slot}">0</span>
          </div>`).join('')}
        </div>
        <div class="hint" data-id="setupHint">Stop in a pit box to change the setup.</div>
        <div class="title setup-title">Balance (practice: which axle lets go first)</div>
        <div class="balance" data-id="balance">Drive a few laps.</div>
      </div>`;
  }

  private wire(): void {
    this.el.menuBtn!.addEventListener('click', () => this.toggle('menu'));
    this.el.timeBtn!.addEventListener('click', () => this.toggle('timing'));
    this.root.querySelectorAll<HTMLButtonElement>('[data-spec]').forEach((b) => b.addEventListener('click', () => this.cb.onSpec(b.dataset.spec!)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-team]').forEach((b) => b.addEventListener('click', () => this.cb.onTeam(b.dataset.team!)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-race-laps]').forEach((b) => b.addEventListener('click', () => { this.race.laps = Number(b.dataset.raceLaps); this.showRaceChoice(); }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-race-grid]').forEach((b) => b.addEventListener('click', () => { this.race.grid = b.dataset.raceGrid as Hud['race']['grid']; this.showRaceChoice(); }));
    this.el.raceStart!.addEventListener('click', () => { this.closeMenu(); this.cb.onRace(this.race.laps, this.race.grid); });
    this.el.practice!.addEventListener('click', () => { this.closeMenu(); this.cb.onPractice(); });
    this.el.weekend!.addEventListener('click', () => { this.closeMenu(); this.cb.onWeekend(this.race.laps); });
    this.el.toPits!.addEventListener('click', () => { this.closeMenu(); this.cb.onPits(); });
    this.root.querySelectorAll<HTMLButtonElement>('[data-ai-count]').forEach((b) => b.addEventListener('click', () => this.cb.onAi(Number(b.dataset.aiCount), this.ai.preset)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-ai-preset]').forEach((b) => b.addEventListener('click', () => this.cb.onAi(this.ai.count, b.dataset.aiPreset!)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-perf]').forEach((b) => b.addEventListener('click', () => this.cb.onPerf(b.dataset.perf as 'team' | 'equal')));
    this.root.querySelectorAll<HTMLButtonElement>('[data-damage]').forEach((b) => b.addEventListener('click', () => this.cb.onDamage(b.dataset.damage as 'off' | 'visual' | 'realistic')));
    this.root.querySelectorAll<HTMLButtonElement>('[data-labels]').forEach((b) => b.addEventListener('click', () => this.cb.onLabels(b.dataset.labels as 'off' | 'position' | 'name')));
    this.root.querySelectorAll<HTMLButtonElement>('[data-slot]').forEach((b) =>
      b.addEventListener('click', () => {
        const slot = b.dataset.slot as keyof CarSetup;
        const f = this.catalog.specs.setup.fields[slot];
        const current = this.setup?.[slot] ?? f.neutral;
        const next = snapSetupValue(current + Number(b.dataset.dir) * f.step, f);
        if (next !== current) this.cb.onSetup(slot, next);
      }),
    );
    // Buttons shouldn't keep keyboard focus (Space would "click" them instead of braking).
    this.root.addEventListener('mouseup', () => (document.activeElement as HTMLElement | null)?.blur());
  }

  private setup: CarSetup | undefined;
  private race: { laps: number; grid: 'random' | 'pole' | 'back' } = { laps: 5, grid: 'random' };

  /** Default race length (config/race.json). */
  setRaceDefaults(laps: number): void {
    this.race.laps = laps;
    this.showRaceChoice();
  }

  private showRaceChoice(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-race-laps]').forEach((b) => b.classList.toggle('active', Number(b.dataset.raceLaps) === this.race.laps));
    this.root.querySelectorAll<HTMLButtonElement>('[data-race-grid]').forEach((b) => b.classList.toggle('active', b.dataset.raceGrid === this.race.grid));
  }

  /** Open the menu (results screen: back to menu). */
  openMenu(): void {
    this.panels.menu = this.panels.car = true;
    this.applyPanels();
  }

  private closeMenu(): void {
    this.panels.menu = this.panels.car = false;
    this.applyPanels();
  }

  /** The HUD's root element (the race overlay mounts inside it so it scales the same way). */
  get element(): HTMLElement {
    return this.root;
  }
  private ai = { count: 0, preset: '' };

  /** Show the current AI choice (highlights the buttons). */
  setAi(count: number, preset: string): void {
    this.ai = { count, preset };
    this.root.querySelectorAll<HTMLButtonElement>('[data-ai-count]').forEach((b) => b.classList.toggle('active', Number(b.dataset.aiCount) === count));
    this.root.querySelectorAll<HTMLButtonElement>('[data-ai-preset]').forEach((b) => b.classList.toggle('active', b.dataset.aiPreset === preset));
  }

  /** The balance readout: per corner, front / rear first as a share of passes. */
  setBalance(rows: Array<{ name: string; front: number; rear: number; passes: number }>): void {
    const el = this.el.balance!;
    const seen = rows.filter((r) => r.passes > 0);
    if (!seen.length) { el.textContent = 'Drive a few laps.'; return; }
    el.innerHTML = seen.map((r) => {
      const f = Math.round((100 * r.front) / r.passes), rr = Math.round((100 * r.rear) / r.passes);
      const tag = f >= 50 && f > rr ? 'under' : rr >= 50 && rr > f ? 'over' : '';
      return `<span class="corner ${tag}" title="${r.passes} passes: front first ${f}%, rear first ${rr}%">${r.name}<small>${tag === 'under' ? `F ${f}%` : tag === 'over' ? `R ${rr}%` : 'ok'}</small></span>`;
    }).join('');
  }

  /** Highlight the current damage setting; the damage diagram shows only when it's on. */
  setDamage(mode: string): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-damage]').forEach((b) => b.classList.toggle('active', b.dataset.damage === mode));
    this.el.damageMini!.style.display = mode === 'off' ? 'none' : 'block';
  }

  /** Highlight the current car performance mode. */
  setPerf(mode: string): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-perf]').forEach((b) => b.classList.toggle('active', b.dataset.perf === mode));
  }

  /** Highlight the current car-label mode. */
  setLabels(mode: string): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-labels]').forEach((b) => b.classList.toggle('active', b.dataset.labels === mode));
  }

  private toggle(p: keyof Hud['panels']): void {
    this.panels[p] = !this.panels[p];
    if (p === 'menu') this.panels.car = this.panels.menu; // the menu opens both, like v0.16
    this.carPanelAuto = false;
    this.applyPanels();
  }

  private applyPanels(): void {
    this.el.timingPanel!.classList.toggle('open', this.panels.timing);
    this.el.menuPanel!.classList.toggle('open', this.panels.menu);
    this.el.carPanel!.classList.toggle('open', this.panels.car);
  }

  /** Sit exactly over the canvas; scale so the bar covers the top `hudBarTrackPx` of the track. */
  layout(): void {
    const r = this.canvas.getBoundingClientRect();
    Object.assign(this.root.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    // 1 u = 1 pixel of the v0.16 layout (1280 wide, 50 px bar). On an authored 2560x1440 track the bar
    // then covers exactly the reserved top hudBarTrackPx; on other shapes (Indiana) the width decides.
    const barCss = (this.cfg.hudBarTrackPx / this.trackHeightPx()) * r.height;
    this.root.style.setProperty('--u', `${Math.min(barCss / 50, r.width / 1280)}px`);
  }

  private tile(i: number, t: Tile): void {
    const e = this.el[`tile${i}`]!;
    e.textContent = t.time === undefined ? '---' : i === 3 ? fmt(t.time) : t.time.toFixed(3);
    e.dataset.color = t.color;
    this.el[`split${i}`]!.textContent = t.split === undefined ? '---' : fmt(t.split, true);
  }

  /** `race`: race laps and the car's own box (1-based) while racing; undefined in practice. */
  update(car: CarState, simTime: number, session: Session, hasLines: boolean, inBoxStopped: boolean, race?: { laps: number; box: number }, reset?: { holdFrac: number; penaltySec: number }, power?: { batteryFrac: number; fuelMargin?: number | undefined }, pit?: { letter: string; color: string; board?: string | undefined }): void {
    // Race strategy: the compound on the car, and the pit board when it's up.
    if (pit) {
      this.el.compound!.textContent = pit.letter;
      this.el.compound!.style.setProperty('--c', pit.color);
    }
    const board = this.el.pitBoard!;
    board.style.display = pit?.board ? 'block' : 'none';
    if (pit?.board && board.dataset.html !== pit.board) { board.innerHTML = pit.board; board.dataset.html = pit.board; }
    // Engine mode, battery (glows while deploying), fuel margin in a race (green = enough, red = save or stop).
    this.el.ersMode!.textContent = { save: 'SAVE', standard: 'STD', push: 'PUSH' }[car.ers.mode];
    this.el.ersMode!.className = `mode ${car.ers.mode}`;
    this.el.battFill!.style.width = `${Math.round(Math.max(0, Math.min(1, power?.batteryFrac ?? 0)) * 100)}%`;
    this.el.battFill!.parentElement!.classList.toggle('on', car.ers.deploying);
    const fm = power?.fuelMargin, fd = this.el.fuelDelta!;
    fd.textContent = fm === undefined ? '' : `FUEL ${fm >= 0 ? '+' : ''}${fm.toFixed(1)}`;
    fd.className = `fuel-delta ${fm === undefined ? '' : fm >= 0 ? 'ok' : 'short'}`;
    // Damage diagram: each zone green -> amber -> red.
    for (const z of this.el.damageMini!.querySelectorAll<SVGRectElement>('[data-zone]')) {
      const d = Math.max(0, Math.min(1, car.damage[z.dataset.zone as keyof CarState['damage']]));
      z.style.fill = d < 0.02 ? 'rgba(80, 200, 90, 0.85)' : `hsla(${Math.round(50 * (1 - d))}, 85%, 50%, 0.95)`;
    }
    // Reset to track: a fill while R is held, then the race penalty countdown.
    const note = this.el.resetNote!;
    const pen = reset?.penaltySec ?? 0, hold = reset?.holdFrac ?? 0;
    note.style.display = pen > 0 || hold > 0 ? 'block' : 'none';
    if (pen > 0) note.innerHTML = `RESET PENALTY <b>${pen.toFixed(1)}</b>`;
    else if (hold > 0) note.innerHTML = `HOLD R TO RESET <span class="fill"><span style="width:${Math.round(Math.min(1, hold) * 100)}%"></span></span>`;
    this.el.lap!.textContent = race
      ? `${Math.min(race.laps, car.timing.started ? car.timing.laps + 1 : 0)}/${race.laps}`
      : String(car.timing.started ? car.timing.laps + 1 : 0);
    this.el.speed!.textContent = Math.abs(car.speed * 3.6).toFixed(0);
    const time = this.el.time!;
    if (!hasLines) time.textContent = 'no lines';
    else if (!car.timing.started) time.textContent = 'OUT LAP';
    else time.textContent = car.timing.lapInvalid ? 'INVALID' : fmt(simTime - car.timing.lapStart);
    time.classList.toggle('invalid', car.timing.started && car.timing.lapInvalid);
    // Slipstream: a small tag while you're in a tow.
    const tow = this.el.tow!;
    tow.classList.toggle('on', car.tow > 0.02);
    if (car.tow > 0.02) tow.textContent = `TOW ${Math.round(car.tow * 100)}%`;
    session.tiles.forEach((t, i) => this.tile(i, t));

    const pb = session.personalBest;
    pb.sectors.forEach((s, i) => (this.el[`pb${i}`]!.textContent = s === undefined ? '---' : s.toFixed(3)));
    this.el.pb3!.textContent = fmt(pb.lap);
    this.el.avg!.textContent = fmt(session.average);
    this.el.optimal!.textContent = fmt(session.theoreticalBest);
    this.el.last!.textContent = fmt(session.lastLap);
    this.el.laps!.textContent = String(session.completedLaps);
    this.el.noLines!.textContent = hasLines ? '' : 'This track has no start/finish line yet: place timing lines in the editor (?edit=1).';

    // Vehicle: tyre LIFE (100% new, 0% = no grip left), coloured by the grip left (green -> amber as it
    // nears the cliff -> red), fuel gauge.
    car.wheels.forEach((w, i) => {
      const hue = Math.round(120 * wearGrip(w.wear));
      this.el[`tyre${i}`]!.style.background = `hsla(${hue}, 70%, 38%, 0.85)`;
      this.el[`tyrePct${i}`]!.textContent = `${Math.round(tyreLife(w.wear) * 100)}%`;
    });
    const fuel = Math.max(0, Math.min(1, car.fuelKg / this.fuelTankKg));
    this.el.fuelLevel!.style.height = `${fuel * 100}%`;
    this.el.fuelPct!.textContent = String(Math.round(fuel * 100));

    // Setup: shows the car's setup; changes only while stopped in a pit box.
    this.setup = normalizeSetup(car.build.setup, this.catalog.specs.setup);
    for (const s of SLOTS) {
      const v = this.setup[s.slot], f = this.catalog.specs.setup.fields[s.slot];
      this.el[`setup-${s.slot}`]!.textContent = `${v} ${f.unit}`;
      this.el[`setupMark-${s.slot}`]!.style.left = `${((v - f.min) / (f.max - f.min)) * 100}%`;
    }
    this.root.querySelectorAll<HTMLButtonElement>('[data-slot]').forEach((b) => (b.disabled = !inBoxStopped));
    this.el.setupHint!.textContent = inBoxStopped ? 'In the box: fresh tyres, refuelling. Setup changes apply now.'
      : race && race.box > 0 ? `Your pit box is ${race.box} (outlined when you're in the pit lane). Only your box services you.`
      : 'Stop in a pit box to change the setup.';
    this.root.querySelectorAll<HTMLButtonElement>('[data-spec]').forEach((b) => b.classList.toggle('active', b.dataset.spec === car.build.spec));
    this.root.querySelectorAll<HTMLButtonElement>('[data-team]').forEach((b) => b.classList.toggle('active', b.dataset.team === car.build.team));

    // Stopping in the box opens the car panel; driving off closes it again (unless opened by hand).
    if (inBoxStopped && !this.panels.car) {
      this.panels.car = true;
      this.carPanelAuto = true;
      this.applyPanels();
    } else if (!car.inPitBox && this.carPanelAuto) {
      this.panels.car = false;
      this.carPanelAuto = false;
      this.applyPanels();
    }
  }

  fuelTankKg = 110;
}
