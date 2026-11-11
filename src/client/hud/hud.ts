// The v0.16 HUD, rebuilt: top timing bar, timing dropdown, spec/team menu, vehicle + setup panel.
// It reads sim state and the session; it never writes sim state. Choices go out through callbacks.
import type { CarSetup, CarState, CatalogLike } from './hud-types';
import type { Session, Tile } from './session';
import type { HudConfig } from './timing-lines';
import './hud.css';

export interface HudCallbacks {
  onSpec(spec: string): void;
  onTeam(team: string): void;
  onSetup(slot: keyof CarSetup, value: string): void;
}

const fmt = (t: number | undefined, plus = false): string => {
  if (t === undefined || !Number.isFinite(t)) return '---';
  const sign = t < 0 ? '-' : plus ? '+' : '';
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = (a - m * 60).toFixed(3).padStart(6, '0');
  return m ? `${sign}${m}:${s}` : `${sign}${(a).toFixed(3)}`;
};

const SLOTS: Array<{ slot: keyof CarSetup; label: string }> = [
  { slot: 'downforce', label: 'Downforce' },
  { slot: 'gearing', label: 'Gearing' },
  { slot: 'brakes', label: 'Brake Pressure' },
];

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

  /** Height of the top bar in canvas backing pixels (so the K debug text can sit below it). */
  barHeightBackingPx(): number {
    return this.el.bar!.getBoundingClientRect().height * (window.devicePixelRatio || 1);
  }

  private markup(): string {
    const tiles = ['Sector 1', 'Sector 2', 'Sector 3', 'Lap'];
    const specs = Object.entries(this.catalog.specs.specs);
    return `
      <div class="hud-bar" data-id="bar">
        <button class="hud-icon menu" data-id="menuBtn" title="Menu"></button>
        <div class="lap-speed">Lap:<b data-id="lap">0</b>Speed:<b data-id="speed">--</b>kph</div>
        <div class="current">Time:<b data-id="time">---</b></div>
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
      </div>
      <div class="hud-drop car" data-id="carPanel">
        <div class="title">Vehicle Information</div>
        <div class="vehicle">
          <div class="tyres">${['FL', 'FR', 'RL', 'RR'].map((n, i) => `<div class="tyre" data-id="tyre${i}"><small>${n}</small><span data-id="tyrePct${i}">100%</span></div>`).join('')}</div>
          <div class="fuel"><div>FUEL LEVEL</div><div class="gauge"><div class="level" data-id="fuelLevel"></div><span data-id="fuelPct">100</span></div></div>
        </div>
        <div class="title setup-title">Car Setup Adjustments</div>
        <div class="setup">${SLOTS.map((s) => `
          <div class="slot"><div>${s.label.toUpperCase()}</div>
            <button class="up" data-slot="${s.slot}" data-dir="1">+</button>
            <div class="value" data-id="setup-${s.slot}">Med</div>
            <button class="dn" data-slot="${s.slot}" data-dir="-1">-</button>
          </div>`).join('')}
        </div>
        <div class="hint" data-id="setupHint">Stop in a pit box to change the setup.</div>
      </div>`;
  }

  private wire(): void {
    this.el.menuBtn!.addEventListener('click', () => this.toggle('menu'));
    this.el.timeBtn!.addEventListener('click', () => this.toggle('timing'));
    this.root.querySelectorAll<HTMLButtonElement>('[data-spec]').forEach((b) => b.addEventListener('click', () => this.cb.onSpec(b.dataset.spec!)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-team]').forEach((b) => b.addEventListener('click', () => this.cb.onTeam(b.dataset.team!)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-slot]').forEach((b) =>
      b.addEventListener('click', () => {
        const slot = b.dataset.slot as keyof CarSetup;
        const options = Object.keys(this.catalog.specs.setups[slot] ?? {});
        const current = this.setup?.[slot] ?? 'Med';
        const i = Math.max(0, Math.min(options.length - 1, options.indexOf(current) + Number(b.dataset.dir)));
        if (options[i] && options[i] !== current) this.cb.onSetup(slot, options[i]);
      }),
    );
    // Buttons shouldn't keep keyboard focus (Space would "click" them instead of braking).
    this.root.addEventListener('mouseup', () => (document.activeElement as HTMLElement | null)?.blur());
  }

  private setup: CarSetup | undefined;

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

  update(car: CarState, simTime: number, session: Session, hasLines: boolean, inBoxStopped: boolean): void {
    this.el.lap!.textContent = String(car.timing.started ? car.timing.laps + 1 : 0);
    this.el.speed!.textContent = Math.abs(car.speed * 3.6).toFixed(0);
    const time = this.el.time!;
    if (!hasLines) time.textContent = 'no lines';
    else if (!car.timing.started) time.textContent = 'OUT LAP';
    else time.textContent = car.timing.lapInvalid ? 'INVALID' : fmt(simTime - car.timing.lapStart);
    time.classList.toggle('invalid', car.timing.started && car.timing.lapInvalid);
    session.tiles.forEach((t, i) => this.tile(i, t));

    const pb = session.personalBest;
    pb.sectors.forEach((s, i) => (this.el[`pb${i}`]!.textContent = s === undefined ? '---' : s.toFixed(3)));
    this.el.pb3!.textContent = fmt(pb.lap);
    this.el.avg!.textContent = fmt(session.average);
    this.el.optimal!.textContent = fmt(session.theoreticalBest);
    this.el.last!.textContent = fmt(session.lastLap);
    this.el.laps!.textContent = String(session.completedLaps);
    this.el.noLines!.textContent = hasLines ? '' : 'This track has no start/finish line yet: place timing lines in the editor (?edit=1).';

    // Vehicle: tyres green -> red by wear, fuel gauge.
    car.wheels.forEach((w, i) => {
      const hue = Math.round(120 * Math.max(0, Math.min(1, w.wear)));
      this.el[`tyre${i}`]!.style.background = `hsla(${hue}, 70%, 38%, 0.85)`;
      this.el[`tyrePct${i}`]!.textContent = `${Math.round(w.wear * 100)}%`;
    });
    const fuel = Math.max(0, Math.min(1, car.fuelKg / this.fuelTankKg));
    this.el.fuelLevel!.style.height = `${fuel * 100}%`;
    this.el.fuelPct!.textContent = String(Math.round(fuel * 100));

    // Setup: shows the car's setup; changes only while stopped in a pit box.
    this.setup = car.build.setup;
    for (const s of SLOTS) this.el[`setup-${s.slot}`]!.textContent = car.build.setup[s.slot];
    this.root.querySelectorAll<HTMLButtonElement>('[data-slot]').forEach((b) => (b.disabled = !inBoxStopped));
    this.el.setupHint!.textContent = inBoxStopped ? 'In the box: fresh tyres, refuelling. Setup changes apply now.' : 'Stop in a pit box to change the setup.';
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
