// Client-side prediction (card 07 step 6): my car runs here on my own inputs, so steering answers at once.
// It's the same pure sim as the server's: on every snapshot, start again from the server's world at that
// tick and replay the inputs the server hasn't used yet (seq > ack). The other cars in this local world
// carry on with the controls they last had (a short guess ahead; they're DRAWN from snapshots, in the past).
// Whatever my car moved by in that rewind is the correction; the caller blends it out on screen.
import { step, type CarInput, type SimContext, type WorldState } from '../../sim';
import type { InputMsg } from '../../server/protocol';

export interface Correction { dx: number; dy: number; dh: number }

/** Never replay more than this many inputs (no acks for 4 s: the link is gone, don't stall the frame). */
const MAX_PENDING = 240;

export class Predictor {
  /** The predicted world (server car order) and the one a tick before it, to draw between. */
  world: WorldState | undefined;
  prev: WorldState | undefined;
  /** Inputs sent but not yet used by the server, oldest first. */
  private pending: InputMsg[] = [];
  /** Ticks stepped, for the cost readout. */
  stepped = 0;

  /** `keep`: what snapshots don't carry and the sim needs (the track surface, session settings). */
  constructor(private readonly ctx: SimContext, readonly you: number, private readonly keep: Pick<WorldState, 'surface' | 'settings'>) {}

  start(world: WorldState): void {
    this.world = this.prev = world;
    this.pending = [];
  }

  /** One client tick: my numbered input, applied locally at once. */
  tick(input: InputMsg): void {
    this.pending.push(input);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    if (!this.world) return;
    this.prev = this.world;
    this.world = this.advance(this.world, input);
  }

  /**
   * A snapshot: the server's world after its tick (my car in full) and the last input of mine it used.
   * Returns how far my predicted car moves because of it (old - new), undefined before the first.
   */
  reconcile(server: WorldState, ack: number): Correction | undefined {
    this.pending = this.pending.filter((p) => p.seq > ack);
    const old = this.world;
    // Snapshots leave out the wake trails and the track surface: carry ours over.
    let w: WorldState = {
      ...server,
      cars: server.cars.map((c, i) => {
        const t = old?.cars[i]?.trail;
        return t && !c.trail ? { ...c, trail: t } : c;
      }),
      ...(this.keep.surface && !server.surface ? { surface: this.keep.surface } : {}),
      ...(this.keep.settings && !server.settings ? { settings: this.keep.settings } : {}),
    };
    let p = w;
    for (const input of this.pending) {
      p = w;
      w = this.advance(w, input);
    }
    this.prev = p;
    this.world = w;
    const a = old?.cars[this.you], b = w.cars[this.you];
    if (!a || !b) return undefined;
    return { dx: a.x - b.x, dy: a.y - b.y, dh: Math.atan2(Math.sin(a.heading - b.heading), Math.cos(a.heading - b.heading)) };
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  private advance(w: WorldState, mine: CarInput): WorldState {
    this.stepped++;
    // Everyone else: their controls as last seen (held). Mine: this tick's input.
    const inputs = w.cars.map((c, i): CarInput => (i === this.you ? mine : { throttle: c.controls.throttle, brake: c.controls.brake, steer: c.controls.steer }));
    return step(w, inputs, this.ctx);
  }
}
