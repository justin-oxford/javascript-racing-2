// Race overlay (card 06 + race weekend): start lights, the ticker under the top bar, and the results screens.
// Ticker, by session:
//   race:        LAP n/N | P1-P3 pinned | the rest scrolling if it doesn't fit | your place + intervals
//   qualifying:  clock   | P1-P3 by best lap | the rest | your place, best lap, END SESSION
//   weekend practice: RACE WEEKEND - PRACTICE | GO TO QUALIFYING
// Reads world.race / world.quali; never writes sim state. Choices go out through callbacks.
import { pointsFor, qualiResults, qualiTimeLeft, raceResults, TICK_DT, type CarCatalog, type RaceConfig, type WorldState } from '../../sim';
import { gapText, lapHead, lapText, playerIntervals, qualiEntries, runningOrder, type OrderEntry } from './running-order';
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
    parent: HTMLElement,
    private readonly catalog: CarCatalog,
    private readonly cb: RaceHudCallbacks,
    /** Track size in track px and its scale, so the ticker can tell when a car is underneath it. */
    private readonly trackPx: () => { height: number; pxPerMeter: number },
    private readonly raceCfg: () => RaceConfig,
  ) {
    const root = document.createElement('div');
    root.className = 'race-hud';
    root.innerHTML = `
      <div class="lights" data-id="lights">${[0, 1, 2, 3, 4].map(() => '<div class="light"><i></i><i></i></div>').join('')}</div>
      <div class="ticker" data-id="ticker">
        <div class="tk-head" data-id="tkHead">GRID</div>
        <div class="tk-top" data-id="tkTop"></div>
        <div class="tk-scroll" data-id="tkScroll"><div class="tk-reel" data-id="tkReel"><div class="tk-set" data-id="tkSetA"></div><div class="tk-set" data-id="tkSetB"></div></div></div>
        <div class="tk-me" data-id="tkMe"></div>
        <button class="tk-btn" data-id="tkBtn"></button>
      </div>
      <div class="note" data-id="note"></div>
      <div class="results" data-id="results">
        <div class="title" data-id="resTitle">RESULTS</div>
        <div class="sub" data-id="resSub"></div>
        <table><thead data-id="resHead"></thead><tbody data-id="rows"></tbody></table>
        <div class="buttons" data-id="resButtons"></div>
      </div>`;
    parent.appendChild(root);
    root.querySelectorAll<HTMLElement>('[data-id]').forEach((e) => (this.el[e.dataset.id!] = e));
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
    this.hide();
  }

  hide(): void {
    this.el.root!.style.display = 'none';
    this.mode = '';
    this.closeResults();
  }

  private closeResults(): void {
    this.resultsShown = '';
    this.el.results!.classList.remove('open');
  }

  private driver(world: WorldState, car: number): { name: string; swatch: string } {
    const team = this.catalog.teams.find((t) => t.id === world.cars[car]!.build.team);
    return { name: car === 0 ? 'YOU' : (team?.name ?? '?'), swatch: team ? team.colors.primary : '#888' };
  }

  /** `note`: a line under the ticker (e.g. shared pit boxes). */
  update(world: WorldState, note = ''): void {
    const mode = world.race ? 'race' : world.quali ? 'quali' : this.weekend?.stage === 'practice' ? 'practice' : '';
    if (!mode) return this.hide();
    if (mode !== this.mode) { this.mode = mode; this.closeResults(); this.lastTicker = 0; }
    this.el.root!.style.display = '';
    this.el.root!.dataset.mode = mode;
    this.el.note!.textContent = note;

    // Lights (race only): five pairs light up one by one; all go out at the start. Shown until a moment after.
    const race = world.race;
    const lightsOn = !!race && (race.phase === 'grid' || race.phase === 'lights');
    const sinceStart = race && race.startTime >= 0 ? world.tick / 60 - race.startTime : 0;
    this.el.lights!.style.display = lightsOn || (race?.phase === 'racing' && sinceStart < 1.5) ? '' : 'none';
    this.el.lights!.querySelectorAll('.light').forEach((l, k) => l.classList.toggle('on', lightsOn && k < race!.lights));

    // Ticker text: ~8x a second is plenty.
    const now = performance.now();
    if (now - this.lastTicker > 120) {
      this.lastTicker = now;
      if (mode === 'practice') this.fillPractice();
      else this.fillTicker(world, mode);
    }
    // A car under the ticker (the top straight on Oxford): fade it so the car shows through.
    const root = this.el.root!.getBoundingClientRect(), tk = this.el.ticker!.getBoundingClientRect();
    const { height, pxPerMeter } = this.trackPx();
    const limitM = (((tk.bottom - root.top + 10) / root.height) * height) / pxPerMeter;
    this.el.ticker!.classList.toggle('see-through', world.cars.some((c) => c.y < limitM));
    // Ticker scroll: every frame, a seamless loop over two copies of the set.
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    if (this.reelWidth > 0) {
      const u = this.el.ticker!.getBoundingClientRect().width / 1280;
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

  private fillPractice(): void {
    this.el.tkHead!.textContent = 'RACE WEEKEND';
    this.el.tkTop!.innerHTML = '<span class="chip"><b>PRACTICE</b></span>';
    this.el.tkSetA!.innerHTML = `<span class="chip">Learn the track and try setups (stop in a pit box). Then qualifying: best lap sets the grid for ${this.weekend?.laps ?? '?'} laps.</span>`;
    this.el.tkSetB!.innerHTML = '';
    this.reelWidth = 0;
    this.el.tkScroll!.classList.remove('scrolling');
    this.el.tkMe!.innerHTML = '';
    this.setButton('GO TO QUALIFYING');
  }

  private fillTicker(world: WorldState, mode: 'race' | 'quali'): void {
    const order = mode === 'race' ? runningOrder(world, this.catalog) : qualiEntries(world, this.catalog);
    if (mode === 'race') this.el.tkHead!.textContent = lapHead(world);
    else {
      const q = world.quali!;
      const left = qualiTimeLeft(q, world.tick, TICK_DT);
      this.el.tkHead!.textContent = q.phase === 'running' ? `Q ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}` : 'FLAG';
    }
    this.el.tkTop!.innerHTML = order.slice(0, 3).map((e) => this.chip(e)).join('');
    const rest = order.slice(3).map((e) => this.chip(e)).join('');
    const a = this.el.tkSetA!, b = this.el.tkSetB!;
    a.innerHTML = rest;
    // Scroll only when the rest of the field doesn't fit; the second copy makes the loop seamless.
    const fits = a.scrollWidth <= this.el.tkScroll!.clientWidth;
    b.innerHTML = fits ? '' : rest;
    this.reelWidth = fits ? 0 : a.getBoundingClientRect().width;
    this.el.tkScroll!.classList.toggle('scrolling', !fits);

    if (mode === 'race') {
      const me = playerIntervals(world);
      this.el.tkMe!.innerHTML = !me ? '' : `<span class="mp">P${me.pos}<small>/${me.of}</small></span>`
        + `<span class="iv"><small>AHEAD</small>${me.ahead || (me.pos === 1 ? 'LEADER' : '---')}</span>`
        + `<span class="iv"><small>BEHIND</small>${me.behind || '---'}</span>`;
      this.setButton('');
    } else {
      const q = world.quali!, mine = q.cars[0]!, k = q.order.indexOf(0);
      const pole = q.cars[q.order[0]!]!.bestLap;
      this.el.tkMe!.innerHTML = `<span class="mp">P${k + 1}<small>/${q.order.length}</small></span>`
        + `<span class="iv"><small>BEST</small>${mine.bestLap ? lapText(mine.bestLap) : '---'}</span>`
        + `<span class="iv"><small>TO POLE</small>${!mine.bestLap ? '---' : k === 0 ? 'POLE' : `+${(mine.bestLap - pole).toFixed(3)}`}</span>`;
      this.setButton(q.phase === 'results' ? '' : mine.done ? 'FAST-FORWARDING' : 'END SESSION');
      this.el.tkBtn!.toggleAttribute('disabled', mine.done);
    }
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
      return `<tr class="${r.car === 0 ? 'me' : ''}"><td>${r.pos}</td><td><span class="sw" style="background:${d.swatch}"></span></td><td>${d.name}</td><td>${from} ${moved}</td><td>${r.laps}</td><td>${t}</td><td>${r.bestLap ? lapText(r.bestLap) : '---'}</td><td>${r.pitStops}</td><td><b>${pts || ''}</b></td><td>${r.jumpStart ? '<span class="jump">JUMP START</span>' : ''}</td></tr>`;
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
