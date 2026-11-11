import type { CarInput, InputSource } from '../../sim';

/**
 * Dev-only test driver (?cars=N): donuts with brake stabs, so every car smokes, marks and squeals.
 * Stand-in until AI (card 05).
 */
export class DonutInput implements InputSource {
  constructor(private readonly seed: number) {}

  read(tick: number): CarInput {
    const phase = (tick + this.seed * 37) % 360;
    if (phase > 300) return { throttle: 0, brake: 1, steer: 0 }; // lock up
    return { throttle: 1, brake: 0, steer: this.seed % 2 ? 1 : -1 };
  }
}
