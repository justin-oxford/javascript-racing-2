import type { CarInput, InputSource } from '../../sim';

/** Discrete, non-driving actions from the v0.16 bindings. */
export type KeyboardAction =
  | { type: 'reset' }
  | { type: 'toggleDebug' }
  | { type: 'cycleVfx' }
  | { type: 'gridSlot'; slot: number };

// v0.16 bindings, by physical key (e.code), so they work on any keyboard layout.
// W/S are physical positions: on AZERTY, "KeyW" is the key labelled Z.
const THROTTLE = ['KeyW', 'ArrowUp'];
const BRAKE = ['KeyS', 'ArrowDown', 'KeyZ', 'Space'];
const LEFT = ['KeyA', 'ArrowLeft'];
const RIGHT = ['KeyD', 'ArrowRight'];
const RESET = 'KeyR';
const DEBUG = 'KeyK';
const VFX = 'KeyV';

const DRIVING_KEYS = new Set([...THROTTLE, ...BRAKE, ...LEFT, ...RIGHT]);

/** Keyboard as the first InputSource. Digital keys map to full 0/1 input. */
export class KeyboardInput implements InputSource {
  private readonly down = new Set<string>();
  private readonly listeners: Array<(a: KeyboardAction) => void> = [];

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (DRIVING_KEYS.has(e.code)) e.preventDefault(); // stop arrows/space scrolling the page
      if (!e.repeat) this.handleAction(e.code);
      this.down.add(e.code);
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    // Don't leave keys stuck "down" when the tab loses focus.
    target.addEventListener('blur', () => this.down.clear());
  }

  onAction(listener: (a: KeyboardAction) => void): void {
    this.listeners.push(listener);
  }

  read(_tick: number): CarInput {
    const any = (codes: string[]): boolean => codes.some((c) => this.down.has(c));
    return {
      throttle: any(THROTTLE) ? 1 : 0,
      brake: any(BRAKE) ? 1 : 0,
      steer: (any(RIGHT) ? 1 : 0) - (any(LEFT) ? 1 : 0),
    };
  }

  private handleAction(code: string): void {
    let action: KeyboardAction | undefined;
    if (code === RESET) action = { type: 'reset' };
    else if (code === DEBUG) action = { type: 'toggleDebug' };
    else if (code === VFX) action = { type: 'cycleVfx' };
    else if (/^(Digit|Numpad)[0-9]$/.test(code)) action = { type: 'gridSlot', slot: Number(code.slice(-1)) };
    if (action) for (const l of this.listeners) l(action);
  }
}
