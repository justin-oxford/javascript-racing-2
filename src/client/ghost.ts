// Ghost car (Replays card): your personal-best lap on this track and spec, replayed as a translucent car with
// no collision while you practise. Recorded as POSES (position + heading every tick, centimetre / milliradian
// precision), not inputs: it replays exactly whatever traffic you had and survives physics changes (an input
// replay would drift the moment the physics or the surroundings differ). ~1 800 ticks a lap, a few KB.
// Saved per profile, track and spec; downloadable as a file to share, loadable from one.

export interface GhostFile {
  kind: 'jr2-ghost';
  v: 1;
  track: string;
  spec: string;
  /** Who drove it (profile name) and the lap time, seconds. */
  driver: string;
  lapTime: number;
  /** Ticks per second the poses were recorded at. */
  hz: number;
  /** x (cm), y (cm), heading (mrad) per tick, flattened. */
  poses: number[];
}

export interface GhostStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** A file's ghost if it's one, for this track (another track's ghost would be meaningless). */
export function parseGhost(text: string, track: string): GhostFile | string {
  try {
    const g = JSON.parse(text) as Partial<GhostFile>;
    if (g.kind !== 'jr2-ghost' || g.v !== 1 || !Array.isArray(g.poses) || typeof g.lapTime !== 'number' || typeof g.hz !== 'number') return 'not a ghost file';
    if (g.track !== track) return `that ghost is for ${String(g.track)}, not ${track}`;
    return g as GhostFile;
  } catch {
    return 'not a ghost file';
  }
}

export class Ghost {
  /** This lap's poses so far (car 0, from the line). */
  private lap: number[] = [];
  private recording = false;
  ghost: GhostFile | undefined;
  visible = true;

  constructor(private readonly store: GhostStore, private track: string, private spec: string) {
    this.ghost = this.load();
  }

  private key(): string {
    return `ghost.${this.track}.${this.spec}`;
  }

  private load(): GhostFile | undefined {
    const raw = this.store.getItem(this.key());
    if (!raw) return undefined;
    const g = parseGhost(raw, this.track);
    return typeof g === 'string' ? undefined : g;
  }

  /** Another spec (or profile store): its own ghost. */
  switchTo(store: GhostStore, track: string, spec: string): void {
    Object.assign(this, { store, track, spec });
    this.ghost = this.load();
    this.lap = [];
    this.recording = false;
  }

  /** Every tick, car 0's pose once its lap has started; `crossed` = it just crossed the line. */
  tick(x: number, y: number, heading: number, started: boolean, crossed: boolean): void {
    if (crossed || !started) { this.lap = []; this.recording = started; }
    if (this.recording) this.lap.push(Math.round(x * 100), Math.round(y * 100), Math.round(heading * 1000));
  }

  /** A lap finished (before tick() resets the buffer): keep it if it's valid and the quickest. */
  onLap(time: number, invalid: boolean, driver: string, hz: number): boolean {
    if (invalid || this.lap.length < 30 || (this.ghost && this.ghost.lapTime <= time)) return false;
    this.ghost = { kind: 'jr2-ghost', v: 1, track: this.track, spec: this.spec, driver, lapTime: time, hz, poses: this.lap.slice() };
    try { this.store.setItem(this.key(), JSON.stringify(this.ghost)); } catch { /* storage full: keep it for this session */ }
    return true;
  }

  /** Load a shared ghost (replaces this track + spec's, if it's quicker or `force`). */
  use(g: GhostFile): void {
    this.ghost = { ...g, track: this.track, spec: this.spec };
    try { this.store.setItem(this.key(), JSON.stringify(this.ghost)); } catch { /* keep in memory */ }
  }

  /** The ghost's pose `sec` seconds into its lap (interpolated), or undefined past its end. */
  poseAt(sec: number): { x: number; y: number; heading: number } | undefined {
    const g = this.ghost;
    if (!g || sec < 0) return undefined;
    const f = sec * g.hz, i = Math.floor(f), n = g.poses.length / 3;
    if (i >= n - 1) return undefined;
    const t = f - i, p = g.poses;
    const a = i * 3, b = a + 3;
    let dh = p[b + 2]! - p[a + 2]!;
    if (dh > Math.PI * 1000) dh -= 2 * Math.PI * 1000;
    if (dh < -Math.PI * 1000) dh += 2 * Math.PI * 1000;
    return { x: (p[a]! + (p[b]! - p[a]!) * t) / 100, y: (p[a + 1]! + (p[b + 1]! - p[a + 1]!) * t) / 100, heading: (p[a + 2]! + dh * t) / 1000 };
  }

  download(): void {
    if (!this.ghost) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(this.ghost)], { type: 'application/json' }));
    a.download = `ghost-${this.track}-${this.spec}-${this.ghost.lapTime.toFixed(3)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
