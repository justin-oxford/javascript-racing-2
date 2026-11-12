// Race overlay (card 06): start lights, the running-order ticker under the top bar, and the results screen.
// Ticker: lap, P1-P3 pinned, the rest of the field scrolling when it doesn't fit, your place + intervals on the right.
// Reads world.race; never writes sim state. Restart / back-to-menu go out through callbacks.
import { raceResults, type CarCatalog, type WorldState } from '../../sim';
import { gapText, lapHead, playerIntervals, runningOrder, type OrderEntry } from './running-order';
import './race-hud.css';

export interface RaceHudCallbacks {
  onRestart(): void;
  onMenu(): void;
}

const time = (t: number): string => {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(3).padStart(6, '0');
  return m ? `${m}:${s}` : (t).toFixed(3);
};

export class RaceHud {
  private readonly el: Record<string, HTMLElement> = {};
  private lastTicker = 0;
  /** Ticker scroll: one copy of the scrolling set is this wide (CSS px); 0 = it fits, no scrolling. */
  private reelWidth = 0;
  private scrollPx = 0;
  private lastFrame = 0;
  /** Ticker scroll speed, CSS px per second at 1280 wide (scales with the HUD). */
  static scrollSpeed = 45;
  private resultsShown = false;

  constructor(
    parent: HTMLElement,
    private readonly catalog: CarCatalog,
    private readonly siteUrl: (p: string) => string,
    private readonly cb: RaceHudCallbacks,
    /** Track size in track px and its scale, so the ticker can tell when a car is underneath it. */
    private readonly trackPx: () => { height: number; pxPerMeter: number },
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
      </div>
      <div class="note" data-id="note"></div>
      <div class="results" data-id="results">
        <div class="title">RESULTS</div>
        <table><thead><tr><th>Pos</th><th></th><th>Driver</th><th>Laps</th><th>Time / gap</th><th>Best lap</th><th>Pits</th><th></th></tr></thead><tbody data-id="rows"></tbody></table>
        <div class="buttons"><button data-id="restart">RESTART</button><button data-id="menu">BACK TO MENU</button></div>
      </div>`;
    parent.appendChild(root);
    root.querySelectorAll<HTMLElement>('[data-id]').forEach((e) => (this.el[e.dataset.id!] = e));
    this.el.restart!.addEventListener('click', () => this.cb.onRestart());
    this.el.menu!.addEventListener('click', () => this.cb.onMenu());
    this.el.root = root;
    this.hide();
  }

  hide(): void {
    this.el.root!.style.display = 'none';
    this.resultsShown = false;
    this.el.results!.classList.remove('open');
  }

  private driver(world: WorldState, car: number): { name: string; swatch: string } {
    const team = this.catalog.teams.find((t) => t.id === world.cars[car]!.build.team);
    return { name: car === 0 ? 'YOU' : (team?.name ?? '?'), swatch: team ? team.colors.primary : '#888' };
  }

  /** `note`: a line under the ticker (e.g. shared pit boxes). */
  update(world: WorldState, note = ''): void {
    const race = world.race;
    if (!race) return this.hide();
    this.el.root!.style.display = '';
    this.el.note!.textContent = note;

    // Lights: five pairs light up one by one; all go out at the start. Shown until a moment after.
    const lightsOn = race.phase === 'grid' || race.phase === 'lights';
    const sinceStart = race.startTime >= 0 ? world.tick / 60 - race.startTime : 0;
    this.el.lights!.style.display = lightsOn || (race.phase === 'racing' && sinceStart < 1.5) ? '' : 'none';
    this.el.lights!.querySelectorAll('.light').forEach((l, k) => l.classList.toggle('on', lightsOn && k < race.lights));

    // Ticker text: ~8x a second is plenty.
    const now = performance.now();
    if (now - this.lastTicker > 120) {
      this.lastTicker = now;
      this.fillTicker(world);
    }
    // A car under the ticker (the top straight on Oxford): fade it so the car shows through.
    const root = this.el.root!.getBoundingClientRect(), tk = this.el.ticker!.getBoundingClientRect();
    const { height, pxPerMeter } = this.trackPx();
    const limitM = ((tk.bottom - root.top + 10) / root.height) * height / pxPerMeter;
    this.el.ticker!.classList.toggle('see-through', world.cars.some((c) => c.y < limitM));
    // Ticker scroll: every frame, a seamless loop over two copies of the set.
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    if (this.reelWidth > 0) {
      const u = this.el.ticker!.getBoundingClientRect().width / 1280;
      this.scrollPx = (this.scrollPx + RaceHud.scrollSpeed * u * dt) % this.reelWidth;
    } else this.scrollPx = 0;
    this.el.tkReel!.style.transform = `translateX(${-this.scrollPx}px)`;

    if (race.phase === 'results' && !this.resultsShown) this.showResults(world);
    if (race.phase !== 'results' && this.resultsShown) { this.resultsShown = false; this.el.results!.classList.remove('open'); }
  }

  private chip(e: OrderEntry): string {
    const flag = e.state === 'finished' ? '<span class="chq"></span>' : e.state === 'pit' ? '<span class="pit">PIT</span>' : '';
    return `<span class="chip${e.me ? ' me' : ''}" title="${e.name}"><b class="p">${e.pos}</b><span class="sw" style="background:${e.swatch}"></span><span class="n">${e.code}</span>${flag}<span class="g">${e.gap}</span></span>`;
  }

  private fillTicker(world: WorldState): void {
    const order = runningOrder(world, this.catalog);
    this.el.tkHead!.textContent = lapHead(world);
    this.el.tkTop!.innerHTML = order.slice(0, 3).map((e) => this.chip(e)).join('');
    const rest = order.slice(3).map((e) => this.chip(e)).join('');
    const a = this.el.tkSetA!, b = this.el.tkSetB!;
    a.innerHTML = rest;
    // Scroll only when the rest of the field doesn't fit; the second copy makes the loop seamless.
    const fits = a.scrollWidth <= this.el.tkScroll!.clientWidth;
    b.innerHTML = fits ? '' : rest;
    this.reelWidth = fits ? 0 : a.getBoundingClientRect().width;
    this.el.tkScroll!.classList.toggle('scrolling', !fits);
    const me = playerIntervals(world);
    this.el.tkMe!.innerHTML = !me ? '' : `<span class="mp">P${me.pos}<small>/${me.of}</small></span>`
      + `<span class="iv"><small>AHEAD</small>${me.ahead || (me.pos === 1 ? 'LEADER' : '---')}</span>`
      + `<span class="iv"><small>BEHIND</small>${me.behind || '---'}</span>`;
  }

  private showResults(world: WorldState): void {
    const race = world.race!;
    this.resultsShown = true;
    this.el.rows!.innerHTML = raceResults(race).map((r) => {
      const d = this.driver(world, r.car);
      const t = !r.finished ? 'DNF' : r.pos === 1 ? time(r.time) : gapText(r.gap);
      return `<tr class="${r.car === 0 ? 'me' : ''}"><td>${r.pos}</td><td><span class="sw" style="background:${d.swatch}"></span></td><td>${d.name}</td><td>${r.laps}</td><td>${t}</td><td>${r.bestLap ? time(r.bestLap) : '---'}</td><td>${r.pitStops}</td><td>${r.jumpStart ? '<span class="jump">JUMP START</span>' : ''}</td></tr>`;
    }).join('');
    this.el.results!.classList.add('open');
  }
}
