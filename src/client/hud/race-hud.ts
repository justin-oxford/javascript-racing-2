// Race overlay (card 06 + race weekend; HUD v2 card): the bar's middle section (start lights, then the
// ticker) and the results screens. The lap line and your place + intervals live in the bar's left and
// right sections (Hud). Ticker, by session:
//   race:        P1-P3 pinned | the rest scrolling if it doesn't fit
//   qualifying:  P1-P3 by best lap | the rest | END SESSION
//   practice:    the session's best laps, fastest first (| GO TO QUALIFYING in a race weekend)
// Reads world.race / world.quali; never writes sim state. Choices go out through callbacks.
import { pointsFor, qualiResults, qualiTimeLeft, raceResults, TICK_DT, type CarCatalog, type RaceConfig, type WorldState } from '../../sim';
import { gapText, lapText, qualiEntries, runningOrder, type OrderEntry, carIdentity } from './running-order';
import './race-hud.css';

export interface RaceHudCallbacks {
  /** Race results: run the race again (same grid in a weekend). */
  onRestart(): void;
  onMenu(): void;
  /** Weekend practice -> qualifying. */
  onQualify(): void;
  /** Qualifying: end your session now (your best lap stands; the rest is fast-forwarded). */
  onEndSession(): void;
  /** Qualifying results -> the race. */
  onStartRace(): void;
}

/** Where the race weekend is (main.ts owns it). Undefined = a one-off race or plain practice. */
export interface WeekendView {
  stage: 'practice' | 'quali' | 'race';
  laps: number;
  /** Race grid from qualifying (order[slot] = car), for the results' Grid column. */
  grid?: readonly number[] | undefined;
}

export class RaceHud {
  private readonly el: Record<string, HTMLElement> = {};
  private lastTicker = 0;
  /** Ticker scroll: one copy of the scrolling set is this wide (CSS px); 0 = it fits, no scrolling. */
  private reelWidth = 0;
  private scrollPx = 0;
  private lastFrame = 0;
  /** Ticker scroll speed, CSS px per second at 1280 wide (scales with the HUD). */
  static scrollSpeed = 45;
  /** Which results screen is open ('' = none). */
  private resultsShown: '' | 'race' | 'quali' = '';
  private mode: '' | 'race' | 'quali' | 'practice' = '';
  weekend: WeekendView | undefined;

  constructor(
    /** The HUD root (results screens) and the bar's middle section (lights, ticker). */
    parent: HTMLElement,
    middle: HTMLElement,
    private readonly catalog: CarCatalog,
    private readonly cb: RaceHudCallbacks,
    private readonly raceCfg: () => RaceConfig,
  ) {
    const bar = document.createElement('div');
    bar.className = 'race-bar';
    bar.innerHTML = `
      <div class="start" data-id="start">
        <div class="lights" data-id="lights">${[0, 1, 2, 3, 4].map(() => '<div class="light"><i></i><i></i></div>').join('')}</div>
        <div class="note" data-id="note"></div>
      </div>
      <div class="ticker" data-id="ticker">
        <div class="tk-top" data-id="tkTop"></div>
        <div class="tk-scroll" data-id="tkScroll"><div class="tk-reel" data-id="tkReel"><div class="tk-set" data-id="tkSetA"></div><div class="tk-set" data-id="tkSetB"></div></div></div>
        <button class="tk-btn" data-id="tkBtn"></button>
      </div>`;
    middle.prepend(bar);
    const root = document.createElement('div');
    root.className = 'race-hud';
    root.innerHTML = `
      <div class="results" data-id="results">
        <div class="title" data-id="resTitle">RESULTS</div>
        <div class="sub" data-id="resSub"></div>
        <table><thead data-id="resHead"></thead><tbody data-id="rows"></tbody></table>
        <div class="buttons" data-id="resButtons"></div>
      </div>`;
    parent.appendChild(root);
    for (const r of [root, bar]) r.querySelectorAll<HTMLElement>('[data-id]').forEach((e) => (this.el[e.dataset.id!] = e));
    this.el.tkBtn!.addEventListener('click', () => {
      if (this.mode === 'practice') this.cb.onQualify();
      else if (this.mode === 'quali') this.cb.onEndSession();
    });
    this.el.resButtons!.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).dataset.act;
      if (act === 'restart') this.cb.onRestart();
      else if (act === 'menu') this.cb.onMenu();
      else if (act === 'race') this.cb.onStartRace();
    });
    this.el.root = root;
    this.el.bar = bar;
    this.hide();
  }

  hide(): void {
    this.mode = '';
    this.closeResults();
  }

  private closeResults(): void {
    this.resultsShown = '';
    this.el.results!.classList.remove('open');
  }

  private driver(world: WorldState, car: number): { name: string; swatch: string } {
    const team = this.catalog.teams.find((t) => t.id === world.cars[car]!.build.team);
    return { name: carIdentity(car, team?.name).name, swatch: team ? team.colors.primary : '#888' };
  }

  /**
   * `note`: a line beside the start lights (e.g. shared pit boxes).
   * `practiceBest`: practice, the session's best laps, fastest first (the ticker's practice view).
   */
  update(world: WorldState, note = '', practiceBest: OrderEntry[] = []): void {
    const mode = world.race ? 'race' : world.quali ? 'quali' : 'practice';
    if (mode !== this.mode) { this.mode = mode; this.closeResults(); this.lastTicker = 0; }
    this.el.bar!.dataset.mode = mode;

    // Before the start the ticker has nothing to show: the lights (and any note) use its slot. Five pairs
    // light up one by one; at lights out the ticker takes over.
    const race = world.race;
    const lightsOn = !!race && (race.phase === 'grid' || race.phase === 'lights');
    this.el.start!.style.display = lightsOn ? '' : 'none';
    this.el.ticker!.style.display = lightsOn ? 'none' : '';
    if (this.el.note!.textContent !== note) this.el.note!.textContent = note;
    this.el.lights!.querySelectorAll('.light').forEach((l, k) => l.classList.toggle('on', lightsOn && k < race!.lights));

    // Ticker text: ~8x a second is plenty.
    const now = performance.now();
    if (now - this.lastTicker > 120) {
      this.lastTicker = now;
      if (mode === 'practice') this.fillPractice(practiceBest);
      else this.fillTicker(world, mode);
    }
    // Ticker scroll: every frame, a seamless loop over two copies of the set.
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    if (this.reelWidth > 0) {
      const u = this.el.root!.getBoundingClientRect().width / 1280;
      this.scrollPx = (this.scrollPx + RaceHud.scrollSpeed * u * dt) % this.reelWidth;
    } else this.scrollPx = 0;
    this.el.tkReel!.style.transform = `translateX(${-this.scrollPx}px)`;

    if (race?.phase === 'results' && this.resultsShown !== 'race') this.showRaceResults(world);
    if (world.quali?.phase === 'results' && this.resultsShown !== 'quali') this.showQualiResults(world);
  }

  private chip(e: OrderEntry): string {
    const flag = e.state === 'finished' ? '<span class="chq"></span>' : e.state === 'pit' ? '<span class="pit">PIT</span>' : '';
    return `<span class="chip${e.me ? ' me' : ''}" title="${e.name}"><b class="p">${e.pos}</b><span class="sw" style="background:${e.swatch}"></span><span class="n">${e.code}</span>${flag}<span class="g">${e.gap}</span></span>`;
  }

  private setButton(text: string): void {
    const b = this.el.tkBtn!;
    b.textContent = text;
    b.style.display = text ? '' : 'none';
  }

  /** Lay out the field: P1-P3 pinned, the rest scrolling only when it doesn't fit. */
  private fillOrder(order: OrderEntry[], empty = ''): void {
    this.el.tkTop!.innerHTML = order.length ? order.slice(0, 3).map((e) => this.chip(e)).join('') : empty;
    const rest = order.slice(3).map((e) => this.chip(e)).join('');
    const a = this.el.tkSetA!, b = this.el.tkSetB!;
    a.innerHTML = rest;
    // Scroll only when the rest of the field doesn't fit; the second copy makes the loop seamless.
    const fits = a.scrollWidth <= this.el.tkScroll!.clientWidth;
    b.innerHTML = fits ? '' : rest;
    this.reelWidth = fits ? 0 : a.getBoundingClientRect().width;
    this.el.tkScroll!.classList.toggle('scrolling', !fits);
  }

  private fillPractice(best: OrderEntry[]): void {
    const weekend = this.weekend?.stage === 'practice';
    this.fillOrder(best, `<span class="chip hint">${weekend
      ? `Race weekend practice: learn the track and try setups (stop in a pit box). Then qualifying: best lap sets the grid for ${this.weekend?.laps ?? '?'} laps.`
      : 'Practice: best laps show here, fastest first.'}</span>`);
    this.setButton(weekend ? 'GO TO QUALIFYING' : '');
  }

  private fillTicker(world: WorldState, mode: 'race' | 'quali'): void {
    this.fillOrder(mode === 'race' ? runningOrder(world, this.catalog) : qualiEntries(world, this.catalog));
    if (mode === 'race') this.setButton('');
    else {
      const q = world.quali!, mine = q.cars[0]!;
      this.setButton(q.phase === 'results' ? '' : mine.done ? 'FAST-FORWARDING' : 'END SESSION');
      this.el.tkBtn!.toggleAttribute('disabled', mine.done);
    }
  }

  /** Qualifying clock for the bar's lap slot ("4:32", or FLAG once it's out). */
  static qualiClock(world: WorldState): string {
    const q = world.quali;
    if (!q) return '';
    if (q.phase !== 'running') return 'FLAG';
    const left = qualiTimeLeft(q, world.tick, TICK_DT);
    return `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
  }

  private openResults(title: string, sub: string, head: string[], rows: string[], buttons: Array<[string, string]>): void {
    this.el.resTitle!.textContent = title;
    this.el.resSub!.textContent = sub;
    this.el.resHead!.innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>`;
    this.el.rows!.innerHTML = rows.join('');
    this.el.resButtons!.innerHTML = buttons.map(([act, label]) => `<button data-act="${act}">${label}</button>`).join('');
    this.el.results!.classList.add('open');
  }

  private showRaceResults(world: WorldState): void {
    const race = world.race!;
    this.resultsShown = 'race';
    const grid = this.weekend?.stage === 'race' ? this.weekend.grid : undefined;
    const points = this.raceCfg().points;
    const rows = raceResults(race).map((r) => {
      const d = this.driver(world, r.car);
      const t = !r.finished ? 'DNF' : r.pos === 1 ? lapText(r.time) : gapText(r.gap);
      const from = grid ? grid.indexOf(r.car) + 1 : race.cars[r.car]!.slot + 1;
      const delta = from - r.pos;
      const moved = delta > 0 ? `<span class="up">▲${delta}</span>` : delta < 0 ? `<span class="dn">▼${-delta}</span>` : '';
      const pts = r.finished ? pointsFor(r.pos, points) : 0;
      return `<tr class="${r.car === 0 ? 'me' : ''}"><td>${r.pos}</td><td><span class="sw" style="background:${d.swatch}"></span></td><td>${d.name}</td><td>${from} ${moved}</td><td>${r.laps}</td><td>${t}</td><td>${r.bestLap ? lapText(r.bestLap) : '---'}</td><td>${r.pitStops}</td><td><b>${pts || ''}</b></td><td>${[r.jumpStart ? '<span class="jump">JUMP START</span>' : '', r.resets ? `<span class="jump">${r.resets} RESET${r.resets > 1 ? 'S' : ''}</span>` : ''].filter(Boolean).join(' ')}</td></tr>`;
    });
    const mine = raceResults(race).find((r) => r.car === 0);
    const sub = this.weekend ? `Race weekend complete${mine?.finished ? `: P${mine.pos}, ${pointsFor(mine.pos, points)} point${pointsFor(mine.pos, points) === 1 ? '' : 's'}` : ''}` : '';
    this.openResults('RACE RESULTS', sub, ['Pos', '', 'Driver', 'Grid', 'Laps', 'Time / gap', 'Best lap', 'Pits', 'Pts', ''], rows,
      this.weekend ? [['restart', 'RERUN RACE'], ['menu', 'BACK TO MENU']] : [['restart', 'RESTART'], ['menu', 'BACK TO MENU']]);
  }

  private showQualiResults(world: WorldState): void {
    this.resultsShown = 'quali';
    const rows = qualiResults(world.quali!).map((r) => {
      const d = this.driver(world, r.car);
      return `<tr class="${r.car === 0 ? 'me' : ''}"><td>${r.pos}</td><td><span class="sw" style="background:${d.swatch}"></span></td><td>${d.name}</td><td>${r.bestLap ? lapText(r.bestLap) : 'NO TIME'}</td><td>${r.gap ? `+${r.gap.toFixed(3)}` : ''}</td><td>${r.laps}</td></tr>`;
    });
    this.openResults('QUALIFYING', `This is the grid for the ${this.weekend?.laps ?? ''}-lap race.`, ['Pos', '', 'Driver', 'Best lap', 'Gap', 'Laps'], rows,
      [['race', 'START RACE'], ['menu', 'BACK TO MENU']]);
  }
}
