// Online view (card 07): pure helpers, no DOM. The rest of the client is written around "car 0 is me"
// (camera, HUD, labels, results). Online, my car can be any index on the server, so every world the
// client draws is permuted to put my car first. And remote cars are drawn in the past, between two
// snapshots (SnapBuffer), so they move smoothly whatever the network does.
import { TICK_HZ, type RaceState, type SimEvent, type WorldState } from '../../sim';

const TICK_MS = 1000 / TICK_HZ;

/** view index -> server index, with `you` first (you < 0: spectating, no change). */
export function viewOrder(cars: number, you: number): number[] {
  const all = Array.from({ length: cars }, (_, i) => i);
  return you < 0 || you >= cars ? all : [you, ...all.filter((i) => i !== you)];
}

/** A server world with the cars re-indexed by `perm` (view index -> server index). */
export function permuteWorld(w: WorldState, perm: readonly number[]): WorldState {
  const inv: number[] = [];
  perm.forEach((s, v) => (inv[s] = v));
  const ev = (e: SimEvent): SimEvent => ({ ...e, car: inv[e.car] ?? e.car });
  const race: RaceState | undefined = w.race && { ...w.race, cars: perm.map((s) => w.race!.cars[s]!), order: w.race.order.map((s) => inv[s]!) };
  return { ...w, cars: perm.map((s) => w.cars[s]!), events: w.events.map(ev), ...(race ? { race } : {}) };
}

export interface Timed { tick: number }

/**
 * Snapshots in tick order, and the server clock as seen from here. The clock offset follows the
 * quickest arrivals (a late, jittered snapshot doesn't drag it), creeps up if the link gets slower,
 * and the time we draw at glides to it (never jumps).
 */
export class SnapBuffer<T extends Timed> {
  readonly snaps: T[] = [];
  /** arrival ms - tick ms, filtered. */
  private offset: number | undefined;
  /** What render time uses: follows `offset` at most `glideMs` per call. */
  private smooth: number | undefined;
  /** Ticks already handed out by take(). */
  private consumed = -Infinity;

  constructor(private readonly keep = 60, private readonly glideMs = 1) {}

  push(s: T, nowMs: number): void {
    const last = this.snaps[this.snaps.length - 1];
    if (last && s.tick <= last.tick) return;
    this.snaps.push(s);
    if (this.snaps.length > this.keep) this.snaps.shift();
    const o = nowMs - s.tick * TICK_MS;
    this.offset = this.offset === undefined || o < this.offset ? o : this.offset + (o - this.offset) * 0.02;
    if (this.smooth === undefined) this.smooth = this.offset;
  }

  get latest(): T | undefined {
    return this.snaps[this.snaps.length - 1];
  }

  /** The server tick to draw at, `delayMs` behind the newest the clock says should have arrived. */
  renderTick(nowMs: number, delayMs: number): number | undefined {
    if (this.offset === undefined || this.smooth === undefined) return undefined;
    const d = this.offset - this.smooth;
    this.smooth += Math.max(-this.glideMs, Math.min(this.glideMs, d));
    return (nowMs - this.smooth - delayMs) / TICK_MS;
  }

  /** The two snapshots either side of tick `t` and how far between them (clamped to what we have). */
  bracket(t: number): { a: T; b: T; alpha: number } | undefined {
    const s = this.snaps;
    if (!s.length) return undefined;
    if (t <= s[0]!.tick) return { a: s[0]!, b: s[0]!, alpha: 0 };
    for (let k = 1; k < s.length; k++) {
      const a = s[k - 1]!, b = s[k]!;
      if (t <= b.tick) return { a, b, alpha: (t - a.tick) / (b.tick - a.tick) };
    }
    const z = s[s.length - 1]!;
    return { a: z, b: z, alpha: 1 }; // ran out: hold the newest (no guessing ahead)
  }

  /** Snapshots up to tick `t` not handed out before, oldest first (events, effects, sound). */
  take(t: number): T[] {
    const out = this.snaps.filter((s) => s.tick > this.consumed && s.tick <= t);
    if (out.length) this.consumed = out[out.length - 1]!.tick;
    return out;
  }

  clear(): void {
    this.snaps.length = 0;
    this.offset = this.smooth = undefined;
    this.consumed = -Infinity;
  }
}
