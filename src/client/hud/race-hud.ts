// Race overlay (card 06): start lights, the timing tower (P1-P10), and the results screen.
// Reads world.race; never writes sim state. Restart / back-to-menu go out through callbacks.
import { raceGap, raceResults, type CarCatalog, type Gap, type WorldState } from '../../sim';
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
const gapText = (g: Gap | undefined): string => (!g ? '' : g.laps ? `+${g.laps} LAP${g.laps > 1 ? 'S' : ''}` : `+${g.seconds.toFixed(3)}`);

export class RaceHud {
  private readonly el: Record<string, HTMLElement> = {};
  private lastTower = 0;
  private resultsShown = false;

  constructor(
    parent: HTMLElement,
    private readonly catalog: CarCatalog,
    private readonly siteUrl: (p: string) => string,
    private readonly cb: RaceHudCallbacks,
  ) {
    const root = document.createElement('div');
    root.className = 'race-hud';
    root.innerHTML = `
      <div class="lights" data-id="lights">${[0, 1, 2, 3, 4].map(() => '<div class="light"><i></i><i></i></div>').join('')}</div>
      <div class="tower" data-id="tower"></div>
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
    return { name: car === 0 ? 'YOU' : (team?.name ?? '?'), swatch: team ? `url("${this.siteUrl(team.sprite)}")` : 'none' };
  }

  /** `note`: a line under the tower (e.g. shared pit boxes). */
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

    // Tower: ~8x a second is plenty for text.
    const now = performance.now();
    if (now - this.lastTower > 120) {
      this.lastTower = now;
      const leader = race.cars[race.order[0]!]!;
      const lapNow = Math.min(race.laps, Math.max(1, Math.floor(leader.finished ? leader.finishLaps : leader.progress) + 1));
      const head = race.phase === 'grid' || race.phase === 'lights' ? 'GRID' : race.phase === 'racing' ? `LAP ${lapNow}/${race.laps}` : 'FINISH';
      const rows = race.order.slice(0, 10).map((car, k) => {
        const d = this.driver(world, car), rc = race.cars[car]!;
        const gap = k === 0 ? (rc.finished ? 'FLAG' : '') : gapText(raceGap(race, car, race.order[0]!));
        const flag = rc.finished ? '<span class="chq"></span>' : world.cars[car]!.inPitLane ? '<span class="pit">PIT</span>' : '';
        return `<div class="row${car === 0 ? ' me' : ''}"><span class="pos">${k + 1}</span><span class="sw" style="background-image:${d.swatch}"></span><span class="name">${d.name}</span>${flag}<span class="gap">${gap}</span></div>`;
      });
      // The player outside the top 10 still gets a row.
      const myPos = race.order.indexOf(0);
      if (myPos >= 10) rows.push(`<div class="row me"><span class="pos">${myPos + 1}</span><span class="sw" style="background-image:${this.driver(world, 0).swatch}"></span><span class="name">YOU</span><span class="gap">${gapText(raceGap(race, 0, race.order[0]!))}</span></div>`);
      // And the player's interval to the car ahead.
      const ahead = myPos > 0 ? gapText(raceGap(race, 0, race.order[myPos - 1]!)) : '';
      this.el.tower!.innerHTML = `<div class="head">${head}</div>${rows.join('')}${ahead ? `<div class="ahead">to car ahead <b>${ahead}</b></div>` : ''}`;
    }

    if (race.phase === 'results' && !this.resultsShown) this.showResults(world);
    if (race.phase !== 'results' && this.resultsShown) { this.resultsShown = false; this.el.results!.classList.remove('open'); }
  }

  private showResults(world: WorldState): void {
    const race = world.race!;
    this.resultsShown = true;
    this.el.rows!.innerHTML = raceResults(race).map((r) => {
      const d = this.driver(world, r.car);
      const t = !r.finished ? 'DNF' : r.pos === 1 ? time(r.time) : gapText(r.gap);
      return `<tr class="${r.car === 0 ? 'me' : ''}"><td>${r.pos}</td><td><span class="sw" style="background-image:${d.swatch}"></span></td><td>${d.name}</td><td>${r.laps}</td><td>${t}</td><td>${r.bestLap ? time(r.bestLap) : '---'}</td><td>${r.pitStops}</td><td>${r.jumpStart ? '<span class="jump">JUMP START</span>' : ''}</td></tr>`;
    }).join('');
    this.el.results!.classList.add('open');
  }
}
