import { nextEngineMode, type CarInput, type EngineMode, type InputSource } from '../../sim';
import { DEFAULT_KEYBINDS, type BindAction, type Keybinds } from '../menu/keybinds';

/** Discrete, non-driving actions. */
export type KeyboardAction =
  | { type: 'toggleDebug' }
  | { type: 'cycleVfx' }
  | { type: 'mute' }
  | { type: 'cycleLabels' }
  | { type: 'pause' }
  | { type: 'gridSlot'; slot: number };

/** Keys that would scroll the page if not stopped. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

/**
 * Keyboard as the first InputSource. Digital keys map to full 0/1 input. Bindings are by physical key
 * (e.code), so they work on any layout, and come from the player's profile (menu/keybinds.ts); the
 * defaults are the v0.16 ones. Esc is always pause. While `suspended` (a menu is open) it drives nothing.
 */
export class KeyboardInput implements InputSource {
  private readonly down = new Set<string>();
  private readonly listeners: Array<(a: KeyboardAction) => void> = [];
  /** The engine mode this driver has picked (sent every tick; the sim keeps the car's). */
  engineMode: EngineMode = 'standard';
  /** A menu is open: no driving, no game keys (Esc still reaches the listeners). */
  suspended = false;
  private binds: Keybinds = DEFAULT_KEYBINDS;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (this.suspended && e.code !== 'Escape') return;
      if (SCROLL_KEYS.has(e.code) || this.drivingKey(e.code)) e.preventDefault(); // stop arrows/space scrolling the page
      if (!e.repeat) this.handleAction(e.code);
      this.down.add(e.code);
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    // Don't leave keys stuck "down" when the tab loses focus.
    target.addEventListener('blur', () => this.down.clear());
  }

  setBindings(b: Keybinds): void {
    this.binds = b;
  }

  /** Forget held keys (opening a menu mid-corner shouldn't leave the throttle down). */
  release(): void {
    this.down.clear();
  }

  onAction(listener: (a: KeyboardAction) => void): void {
    this.listeners.push(listener);
  }

  read(_tick: number): CarInput {
    if (this.suspended) return { throttle: 0, brake: 0, steer: 0, engineMode: this.engineMode };
    const any = (a: BindAction): boolean => this.binds[a].some((c) => this.down.has(c));
    return {
      throttle: any('throttle') ? 1 : 0,
      brake: any('brake') ? 1 : 0,
      steer: (any('right') ? 1 : 0) - (any('left') ? 1 : 0),
      reset: any('reset'),
      engineMode: this.engineMode,
      deploy: any('deploy'),
    };
  }

  private drivingKey(code: string): boolean {
    return (['throttle', 'brake', 'left', 'right', 'deploy'] as const).some((a) => this.binds[a].includes(code));
  }

  private handleAction(code: string): void {
    const is = (a: BindAction) => this.binds[a].includes(code);
    let action: KeyboardAction | undefined;
    if (code === 'Escape') action = { type: 'pause' };
    else if (is('engineMode')) this.engineMode = nextEngineMode(this.engineMode);
    else if (is('debug')) action = { type: 'toggleDebug' };
    else if (is('vfx')) action = { type: 'cycleVfx' };
    else if (is('mute')) action = { type: 'mute' };
    else if (is('labels')) action = { type: 'cycleLabels' };
    else if (/^(Digit|Numpad)[0-9]$/.test(code)) action = { type: 'gridSlot', slot: Number(code.slice(-1)) };
    if (action) for (const l of this.listeners) l(action);
  }
}
