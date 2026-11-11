import { TICK_DT } from '../sim';

/** Never simulate more than this much wall time per frame (tab was backgrounded, debugger paused...). */
const MAX_FRAME_SECONDS = 0.25;

export interface LoopHooks {
  /** Advance the sim exactly one fixed tick. */
  tick(): void;
  /** Draw. alpha in [0,1) is how far between the previous and current sim state we are. */
  render(alpha: number, frameSeconds: number): void;
}

/**
 * Fixed-timestep loop: sim at TICK_HZ via an accumulator, render on requestAnimationFrame.
 * Physics never sees frame time.
 */
export function startLoop(hooks: LoopHooks): () => void {
  let last = performance.now();
  let accumulator = 0;
  let handle = 0;

  const frame = (now: number): void => {
    const frameSeconds = Math.min((now - last) / 1000, MAX_FRAME_SECONDS);
    last = now;
    accumulator += frameSeconds;
    while (accumulator >= TICK_DT) {
      hooks.tick();
      accumulator -= TICK_DT;
    }
    hooks.render(accumulator / TICK_DT, frameSeconds);
    handle = requestAnimationFrame(frame);
  };

  handle = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(handle);
}
