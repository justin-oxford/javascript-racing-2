// The v0.16 HUD, rebuilt: top timing bar, timing dropdown, vehicle + setup panel. (The old spec/team
// drop-down is gone: its settings live in the pause menu, HUD v2 card.)
// It reads sim state and the session; it never writes sim state. Choices go out through callbacks.
import { normalizeSetup, snapSetupValue, tyreLife, wearGrip } from '../../sim';
import type { CarSetup, CarState, CatalogLike } from './hud-types';
import type { Session, Tile } from './session';
import type { HudConfig } from './timing-lines';
import './hud.css';

export interface HudCallbacks {
  onSetup(slot: keyof CarSetup, value: number): void;
  /** The bar's menu icon: the pause menu (the same one Esc opens). */
  onMenu(): void;
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
  private panels = { timing: false, car: false };
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
    return `
      <div class="hud-bar" data-id="bar">
        <div class="sec left">
          <button class="hud-icon menu" data-id="menuBtn" title="Menu (Esc)"></button>
          <div class="sess">
            <div class="sess-top"><b class="sess-name" data-id="sessName">PRACTICE</b><span class="sess-lap" data-id="lapWrap">Lap <b data-id="lap">0</b></span></div>
            <div class="sess-mini">
              <span class="ers" title="Engine mode (E) and battery: hold Shift or / to deploy"><span class="mode" data-id="ersMode">STD</span><span class="batt"><span data-id="battFill"></span></span></span>
              <span class="fuel-delta" data-id="fuelDelta" title="Laps of fuel left minus laps to go"></span>
              <span class="tow" data-id="tow" title="Slipstream: less drag behind another car">TOW</span>
              <span class="weather" data-id="weather" title="Weather: rain now, or when it's coming"></span>
            </div>
          </div>
          <div class="damage-mini" data-id="damageMini" title="Damage: front wing, rear wing, left and right suspension">
            <svg viewBox="0 0 40 70" width="100%" height="100%">
              <rect x="4" y="2" width="32" height="7" rx="1.5" data-zone="frontWing" />
              <rect x="11" y="11" width="18" height="48" rx="6" class="body" />
              <rect x="3" y="18" width="6" height="34" rx="1.5" data-zone="left" />
              <rect x="31" y="18" width="6" height="34" rx="1.5" data-zone="right" />
              <rect x="6" y="61" width="28" height="7" rx="1.5" data-zone="rearWing" />
            </svg>
          </div>
        </div>
        <div class="sec mid" data-id="mid">
          <div class="reset-note" data-id="resetNote"></div>
        </div>
        <div class="sec right" data-id="right">
          <div class="r-row">
            <span class="r-pos" data-id="pos" title="Position">P-</span>
            <span class="r-iv" title="Interval to the car ahead"><small>AHD</small><span data-id="ahead">---</span></span>
            <span class="r-iv" title="Interval to the car behind"><small>BHD</small><span data-id="behind">---</span></span>
            <b class="r-time" data-id="time">---</b>
            <span class="r-tiles">${[0, 1, 2].map((i) => `<span class="mtile" data-id="mtile${i}">S${i + 1}</span>`).join('')}</span>
          </div>
          <div class="r-row">
            <span class="r-kv"><small>LAST</small><span data-id="lastLap">---</span></span>
            <span class="r-kv"><small>BEST</small><span data-id="bestLap">---</span></span>
            <span class="r-kv r-speed"><b data-id="speed">0</b><small>KPH</small></span>
            <span class="r-kv r-tyre" title="Tyre compound and the most worn tyre's wear"><span class="compound" data-id="compound">M</span><span data-id="wear">0%</span></span>
            <span class="r-kv r-pit" data-id="pitInfo" title="Pit stops made, and what the next stop does (pit board keys)"><small>PIT</small><span data-id="stops">0</span><span class="next" data-id="nextStop"></span></span>
          </div>
        </div>
        <button class="hud-icon time" data-id="timeBtn" title="Timing: splits, personal bests"></button>
      </div>
      <div class="hud-drop timing" data-id="timingPanel">
        <div class="title">THIS LAP</div>
        <table class="sectors">
          <tr class="idents">${tiles.map((t) => `<td>${t}</td>`).join('')}</tr>
          <tr>${tiles.map((_, i) => `<td><div class="tile${i === 3 ? ' lap' : ''}" data-id="tile${i}">---</div></td>`).join('')}</tr>
          <tr class="splits">${tiles.map((_, i) => `<td data-id="split${i}">---</td>`).join('')}</tr>
        </table>
        <hr />
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
      <div class="hud-drop car" data-id="carPanel">
        <div class="pit-board" data-id="pitBoard"></div>
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
    this.el.menuBtn!.addEventListener('click', () => this.cb.onMenu());
    this.el.timeBtn!.addEventListener('click', () => this.toggle('timing'));
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
  /** The HUD's root element (the race overlay mounts inside it so it scales the same way). */
  get element(): HTMLElement {
    return this.root;
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

  /** The damage diagram shows only when damage is on. */
  setDamage(mode: string): void {
    this.el.damageMini!.style.display = mode === 'off' ? 'none' : 'block';
  }

  private toggle(p: keyof Hud['panels']): void {
    this.panels[p] = !this.panels[p];
    this.carPanelAuto = false;
    this.applyPanels();
  }

  private applyPanels(): void {
    this.el.timingPanel!.classList.toggle('open', this.panels.timing);
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

  /** The middle section of the bar (the race overlay puts the lights and the ticker in it). */
  get middle(): HTMLElement {
    return this.el.mid!;
  }

  private text(id: string, t: string): void {
    const e = this.el[id]!;
    if (e.textContent !== t) e.textContent = t;
  }

  /**
   * HUD v2 bar, left and right: the session name, its lap line, and where you stand.
   * `standing`: race = place + intervals; qualifying / practice = place by best lap + gaps (undefined = none).
   */
  setSession(name: string, lap: string, standing?: { pos: number; of: number; ahead: string; behind: string; aheadLabel?: string; behindLabel?: string }): void {
    this.text('sessName', name);
    this.el.sessName!.dataset.len = name.length > 8 ? 'long' : '';
    this.el.lapWrap!.innerHTML = lap;
    this.el.pos!.innerHTML = standing ? `P${standing.pos}<small>/${standing.of}</small>` : 'P<small>-</small>';
    this.text('ahead', standing?.ahead || '---');
    this.text('behind', standing?.behind || '---');
    const labels = this.el.right!.querySelectorAll<HTMLElement>('.r-iv small');
    labels[0]!.textContent = standing?.aheadLabel ?? 'AHD';
    labels[1]!.textContent = standing?.behindLabel ?? 'BHD';
  }

  /** `race`: race laps and the car's own box (1-based) while racing; undefined in practice. */
  update(car: CarState, simTime: number, session: Session, hasLines: boolean, inBoxStopped: boolean, race?: { laps: number; box: number }, reset?: { holdFrac: number; penaltySec: number }, power?: { batteryFrac: number; fuelMargin?: number | undefined }, pit?: { letter: string; color: string; stops: number; next: string; flash: boolean; board?: string | undefined }): void {
    // Race strategy: the compound on the car; stops made and the pit board's next stop (lit after a pit key).
    if (pit) {
      this.text('compound', pit.letter);
      this.el.compound!.style.setProperty('--c', pit.color);
      this.text('stops', String(pit.stops));
      if (this.el.nextStop!.dataset.html !== pit.next) { this.el.nextStop!.innerHTML = pit.next; this.el.nextStop!.dataset.html = pit.next; }
      this.el.pitInfo!.classList.toggle('flash', pit.flash);
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
    this.text('speed', Math.abs(car.speed * 3.6).toFixed(0));
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
    // The bar's small sector tiles (S1-S3), last and best lap.
    for (let i = 0; i < 3; i++) {
      const t = session.tiles[i]!, e = this.el[`mtile${i}`]!;
      this.text(`mtile${i}`, t.time === undefined ? `S${i + 1}` : t.time.toFixed(t.time < 100 ? 1 : 0));
      e.dataset.color = t.color;
      e.title = `Sector ${i + 1}${t.time === undefined ? '' : `: ${t.time.toFixed(3)}${t.split === undefined ? '' : ` (${fmt(t.split, true)})`}`}`;
    }
    this.text('lastLap', fmt(session.lastLap));
    this.text('bestLap', fmt(session.personalBest.lap));
    // Tyres: the most worn tyre's wear, coloured by the grip it has left.
    let worst = 0;
    car.wheels.forEach((w, i) => { if (w.wear > car.wheels[worst]!.wear) worst = i; });
    const ww = car.wheels[worst]!.wear;
    this.text('wear', `${Math.round((1 - tyreLife(ww)) * 100)}%`);
    this.el.wear!.style.color = `hsl(${Math.round(120 * wearGrip(ww))}, 75%, 60%)`;

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
