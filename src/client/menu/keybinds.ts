// Rebindable controls (Main menu + profiles card). Pure data: which physical keys (KeyboardEvent.code)
// drive each action. Defaults keep the v0.16 bindings (SYS - Car model) plus the newer keys.

export type BindAction =
  | 'throttle' | 'brake' | 'left' | 'right'
  | 'reset' | 'engineMode' | 'deploy'
  | 'labels' | 'vfx' | 'mute' | 'debug';

export type Keybinds = Record<BindAction, string[]>;

export const BIND_ACTIONS: ReadonlyArray<{ id: BindAction; label: string }> = [
  { id: 'throttle', label: 'Throttle' },
  { id: 'brake', label: 'Brake / reverse' },
  { id: 'left', label: 'Steer left' },
  { id: 'right', label: 'Steer right' },
  { id: 'reset', label: 'Reset to track (hold)' },
  { id: 'engineMode', label: 'Engine mode' },
  { id: 'deploy', label: 'Battery deploy (hold)' },
  { id: 'labels', label: 'Car labels' },
  { id: 'vfx', label: 'Effects quality' },
  { id: 'mute', label: 'Mute' },
  { id: 'debug', label: 'Debug view' },
];

export const DEFAULT_KEYBINDS: Readonly<Keybinds> = Object.freeze({
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown', 'KeyZ', 'Space'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  reset: ['KeyR'],
  engineMode: ['KeyE'],
  deploy: ['ShiftLeft', 'ShiftRight', 'Slash'],
  labels: ['KeyL'],
  vfx: ['KeyV'],
  mute: ['KeyM'],
  debug: ['KeyK'],
});

/** Keys nobody can bind (they run the menus). */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(['Escape', 'Tab']);

/** A full set: defaults for anything missing or malformed (an old profile, a hand-edited import). */
export function completeKeybinds(raw: unknown): Keybinds {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<string, unknown>>;
  const out = {} as Keybinds;
  for (const { id } of BIND_ACTIONS) {
    const v = src[id];
    out[id] = Array.isArray(v) && v.every((k) => typeof k === 'string') ? (v as string[]).filter((k) => !RESERVED_KEYS.has(k)) : [...DEFAULT_KEYBINDS[id]];
  }
  return out;
}

/** Keys bound to more than one action: key -> the actions sharing it. */
export function keyConflicts(b: Keybinds): Map<string, BindAction[]> {
  const by = new Map<string, BindAction[]>();
  for (const { id } of BIND_ACTIONS) for (const k of b[id]) by.set(k, [...(by.get(k) ?? []), id]);
  for (const [k, ids] of [...by]) if (ids.length < 2) by.delete(k);
  return by;
}

/** Add a key to an action (if it isn't there already). Other actions keep it too: conflicts are shown, not silently fixed. */
export function bindKey(b: Keybinds, action: BindAction, code: string): Keybinds {
  if (RESERVED_KEYS.has(code) || b[action].includes(code)) return b;
  return { ...b, [action]: [...b[action], code] };
}

export function unbindKey(b: Keybinds, action: BindAction, code: string): Keybinds {
  return { ...b, [action]: b[action].filter((k) => k !== code) };
}

/** "KeyW" -> "W", "ArrowUp" -> "↑", "ShiftLeft" -> "L Shift"... for the menu. */
export function keyLabel(code: string): string {
  const named: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt', Slash: '/', Backslash: '\\', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`', Enter: 'Enter', Backspace: 'Backspace' };
  if (named[code]) return named[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return `Num ${code.slice(6)}`;
  return code;
}
