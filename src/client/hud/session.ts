// Session timing for the player's car: tile colours, splits, PBs, averages. Pure apart from the
// storage it's handed (localStorage in the game, a Map in tests). Times come from sim events; this
// only classifies and remembers them.
//
// Colours (card 04, v0.16 timing.js):
//   purple  best known on this track + spec: every team's stored PB and this session (card 09: global)
//   green   personal best for this track + spec + team
//   yellow  slower than that PB
//   invalid the sector/lap was voided (track limits, barrier)
import type { TimingEvent } from '../../sim';

export type TileColor = 'none' | 'purple' | 'green' | 'yellow' | 'invalid';
export interface Tile {
  time: number | undefined;
  color: TileColor;
  /** vs PB before this time, seconds (negative = faster). */
  split: number | undefined;
}
export interface Best {
  lap: number | undefined;
  sectors: Array<number | undefined>;
}
export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  keys(): string[];
}

const PREFIX = 'jsr.pb.';
const empty = (n: number): Best => ({ lap: undefined, sectors: Array.from({ length: n }, () => undefined) });
const min = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

export class Session {
  /** Sector tiles (S1..Sn) then the lap tile. */
  tiles: Tile[] = [];
  lastLap: number | undefined;
  completedLaps = 0;
  private validLapTimes: number[] = [];
  private pb: Best;
  /** Best this session across every car on this spec (feeds purple along with stored PBs). */
  private sessionBest: Best;

  constructor(
    private readonly store: KeyValueStore,
    private track: string,
    private spec: string,
    private team: string,
    private readonly sectorCount = 3,
  ) {
    this.pb = this.load(team);
    this.sessionBest = empty(sectorCount);
    this.clearTiles();
  }

  private key(team: string, spec = this.spec): string {
    return `${PREFIX}${this.track}.${spec}.${team}`;
  }

  private load(team: string): Best {
    try {
      const raw = this.store.getItem(this.key(team));
      if (raw) {
        const b = JSON.parse(raw) as Best;
        return { lap: b.lap ?? undefined, sectors: Array.from({ length: this.sectorCount }, (_, i) => b.sectors?.[i] ?? undefined) };
      }
    } catch {
      // corrupt or blocked: start fresh
    }
    return empty(this.sectorCount);
  }

  private save(): void {
    try {
      this.store.setItem(this.key(this.team), JSON.stringify(this.pb));
    } catch {
      // not persisted; fine
    }
  }

  /** Best known for this track + spec: every team's stored PB plus this session. */
  private overall(): Best {
    const out: Best = { lap: this.sessionBest.lap, sectors: [...this.sessionBest.sectors] };
    const prefix = `${PREFIX}${this.track}.${this.spec}.`;
    for (const k of this.store.keys()) {
      if (!k.startsWith(prefix)) continue;
      try {
        const b = JSON.parse(this.store.getItem(k) ?? 'null') as Best | null;
        if (!b) continue;
        out.lap = min(out.lap, b.lap ?? undefined);
        out.sectors = out.sectors.map((s, i) => min(s, b.sectors?.[i] ?? undefined));
      } catch {
        // skip a bad entry
      }
    }
    return out;
  }

  private classify(time: number, invalid: boolean, pb: number | undefined, overall: number | undefined): TileColor {
    if (invalid) return 'invalid';
    if (overall === undefined || time < overall) return 'purple';
    if (pb === undefined || time < pb) return 'green';
    return 'yellow';
  }

  clearTiles(): void {
    this.tiles = Array.from({ length: this.sectorCount + 1 }, () => ({ time: undefined, color: 'none' as TileColor, split: undefined }));
  }

  /** Feed a sim timing event. `mine` = it's the player's car (others only feed the session best). */
  onEvent(e: TimingEvent, mine: boolean): void {
    if (e.type === 'sector') {
      if (e.sector >= this.sectorCount) return;
      if (!mine) {
        if (!e.invalid) this.sessionBest.sectors[e.sector] = min(this.sessionBest.sectors[e.sector], e.time);
        return;
      }
      if (e.sector === 0) this.clearTiles(); // a new lap's first sector wipes the previous lap's tiles (v0.16)
      const pb = this.pb.sectors[e.sector];
      this.tiles[e.sector] = {
        time: e.time,
        color: this.classify(e.time, e.invalid, pb, this.overall().sectors[e.sector]),
        split: pb === undefined || e.invalid ? undefined : e.time - pb,
      };
      if (!e.invalid) {
        this.pb.sectors[e.sector] = min(pb, e.time);
        this.sessionBest.sectors[e.sector] = min(this.sessionBest.sectors[e.sector], e.time);
        this.save();
      }
      return;
    }
    if (!mine) {
      if (!e.invalid) this.sessionBest.lap = min(this.sessionBest.lap, e.time);
      return;
    }
    const pb = this.pb.lap;
    this.tiles[this.sectorCount] = {
      time: e.time,
      color: this.classify(e.time, e.invalid, pb, this.overall().lap),
      split: pb === undefined || e.invalid ? undefined : e.time - pb,
    };
    this.lastLap = e.time;
    this.completedLaps++;
    if (!e.invalid) {
      this.validLapTimes.push(e.time);
      this.pb.lap = min(pb, e.time);
      this.sessionBest.lap = min(this.sessionBest.lap, e.time);
      this.save();
    }
  }

  get personalBest(): Best {
    return this.pb;
  }

  /** Average of valid completed laps this session ("even the slow ones", v0.16). */
  get average(): number | undefined {
    return this.validLapTimes.length ? this.validLapTimes.reduce((a, b) => a + b, 0) / this.validLapTimes.length : undefined;
  }

  /** Sum of PB sectors, if every sector has one. */
  get theoreticalBest(): number | undefined {
    return this.pb.sectors.every((s) => s !== undefined) ? (this.pb.sectors as number[]).reduce((a, b) => a + b, 0) : undefined;
  }

  /** Spec change: times reset (and PBs switch to the new spec's). */
  changeSpec(spec: string): void {
    this.spec = spec;
    this.resetSession();
  }

  /** Team change: session times kept so teams can be compared; PBs switch to the new team's. */
  changeTeam(team: string): void {
    this.team = team;
    this.pb = this.load(team);
  }

  resetSession(): void {
    this.validLapTimes = [];
    this.lastLap = undefined;
    this.completedLaps = 0;
    this.sessionBest = empty(this.sectorCount);
    this.pb = this.load(this.team);
    this.clearTiles();
  }
}

/** localStorage as a KeyValueStore (with key listing). */
export function browserStore(): KeyValueStore {
  return {
    getItem: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        // full or blocked
      }
    },
    keys: () => {
      try {
        return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}
