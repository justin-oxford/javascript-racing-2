// Latency simulator (card 07, dev): delay + jitter on every message, both directions, in the browser.
// A preset is the PING (round trip): each direction gets half of it, plus or minus the jitter.
// Order is kept, like a real WebSocket (TCP never reorders): jitter only bunches messages up.

/** Ping presets, ms. 0 = off. */
export const LAG_PRESETS = [0, 50, 100, 200] as const;
/** Jitter each way, as a share of the one-way delay. */
const JITTER = 0.2;

export class LatencySim {
  private lastOut = 0;
  private lastIn = 0;
  constructor(public pingMs = 0, private readonly rand: () => number = Math.random) {}

  /** Send something to the server (after the simulated delay). */
  out(send: () => void): void {
    this.lastOut = this.schedule(send, this.lastOut);
  }

  /** Deliver something from the server (after the simulated delay). */
  in(deliver: () => void): void {
    this.lastIn = this.schedule(deliver, this.lastIn);
  }

  private schedule(fn: () => void, last: number): number {
    if (this.pingMs <= 0) { fn(); return 0; }
    const now = performance.now();
    const oneWay = this.pingMs / 2;
    const at = Math.max(now + oneWay * (1 + JITTER * (this.rand() * 2 - 1)), last);
    setTimeout(fn, at - now);
    return at;
  }
}

/** The next preset after `ms` (the toggle). */
export const nextLag = (ms: number): number => LAG_PRESETS[(LAG_PRESETS.indexOf(ms as (typeof LAG_PRESETS)[number]) + 1) % LAG_PRESETS.length]!;
