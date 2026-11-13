// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bindKey, completeKeybinds, DEFAULT_KEYBINDS, keyConflicts, keyLabel, unbindKey } from './keybinds';
import { cleanName, nameCode, pbPrefix, prefixedStore, ProfileStore, type KeyValueStore } from './profile';

const memory = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const ids = () => { let n = 0; return () => `id${++n}`; };

describe('names', () => {
  it('trims, collapses spaces, caps at 16 characters without splitting a character', () => {
    expect(cleanName('  Justin   Oxford  ')).toBe('Justin Oxford');
    expect(cleanName('A'.repeat(30))).toHaveLength(16);
    expect(Array.from(cleanName('🏎️'.repeat(20))).length).toBeLessThanOrEqual(16);
    expect(cleanName('   ')).toBe('');
  });
  it('3-letter codes from the name, any script', () => {
    expect(nameCode('Justin Oxford')).toBe('JUS');
    expect(nameCode('Zoë')).toBe('ZOE');
    expect(nameCode('j.k')).toBe('JKX');
    expect(nameCode('Łukasz')).toBe('ŁUK');
    expect(nameCode('123')).toBe('XXX');
  });
});

describe('profile store', () => {
  it('makes a first profile from a seed, and keeps the pre-profile PBs for it', () => {
    const s = new ProfileStore(memory(), ids());
    const p = s.active({ name: 'Justin', settings: { ai: { count: 3, preset: 'hard' } } as never });
    expect(p).toMatchObject({ id: 'default', name: 'Justin', settings: { ai: { count: 3, preset: 'hard' }, damage: 'off', perf: 'team' } });
    expect(pbPrefix(p)).toBe('');
    expect(s.active()).toEqual(p);
  });

  it('several profiles: create, switch, rename, remove (never the last)', () => {
    const kv = memory(), s = new ProfileStore(kv, ids());
    const a = s.active({ name: 'A' });
    const b = s.create('Bea');
    expect(s.active().id).toBe(b.id);
    expect(pbPrefix(b)).toBe(`p.${b.id}.`);
    s.save({ ...b, name: '  Beatrice   the Fast and Furious ' });
    expect(s.active().name).toBe('Beatrice the Fas');
    s.setActive(a.id);
    expect(s.active().id).toBe(a.id);
    expect(s.remove(b.id).id).toBe(a.id);
    expect(s.list()).toHaveLength(1);
    expect(s.remove(a.id).id).toBe(a.id); // the last one stays
  });

  it('export / import round trip makes a new profile; junk is refused; bad fields fall back to defaults', () => {
    const s = new ProfileStore(memory(), ids());
    const a = s.save({ ...s.active({ name: 'Justin' }), helmet: '#123456', keybinds: bindKey(completeKeybinds({}), 'deploy', 'KeyQ') });
    const b = s.importJson(s.exportJson(a));
    expect(b.id).not.toBe(a.id);
    expect({ ...b, id: a.id }).toEqual(a);
    expect(() => s.importJson('{"hello":1}')).toThrow();
    const odd = s.importJson(JSON.stringify({ format: 'jr2-profile', profile: { name: 42, helmet: 'red', settings: { damage: 'max', race: { laps: -3 } }, keybinds: { throttle: 'KeyW' } } }));
    expect(odd).toMatchObject({ name: 'Player', helmet: '#f2c230', settings: { damage: 'off', race: { laps: 1 } } });
    expect(odd.keybinds.throttle).toEqual(DEFAULT_KEYBINDS.throttle);
  });

  it('prefixed store keeps one profile\'s data apart', () => {
    const kv = memory();
    prefixedStore(kv, 'p.x.').setItem('jr2.pb', '1');
    expect(kv.getItem('jr2.pb')).toBeNull();
    expect(kv.getItem('p.x.jr2.pb')).toBe('1');
  });
});

describe('keybinds', () => {
  it('defaults keep the v0.16 driving keys and have no conflicts', () => {
    expect(DEFAULT_KEYBINDS.throttle).toContain('KeyW');
    expect(DEFAULT_KEYBINDS.brake).toEqual(expect.arrayContaining(['KeyS', 'KeyZ', 'Space']));
    expect(keyConflicts(completeKeybinds({})).size).toBe(0);
  });
  it('a key on two actions is a conflict; Escape and Tab cannot be bound', () => {
    let b = bindKey(completeKeybinds({}), 'deploy', 'KeyW');
    expect(keyConflicts(b).get('KeyW')).toEqual(['throttle', 'deploy']);
    b = unbindKey(b, 'deploy', 'KeyW');
    expect(keyConflicts(b).size).toBe(0);
    expect(bindKey(b, 'reset', 'Escape')).toBe(b);
  });
  it('labels', () => {
    expect(['KeyW', 'ArrowUp', 'ShiftLeft', 'Digit3', 'Slash'].map(keyLabel)).toEqual(['W', '↑', 'L Shift', '3', '/']);
  });
});
