import { describe, expect, it } from 'vitest';
import { applyCar, applySwitches, parseSwitches, reverseGridOrder, switchLabel } from './url-switches';

describe('URL switches', () => {
  it('parses and combines', () => {
    expect(parseSwitches('?brain=lookahead&watch=1&dirty=5')).toEqual({ brain: 'lookahead', watch: true, dirty: 0.05 });
    expect(parseSwitches('?scale=0&race=5&grid=reverse')).toEqual({ watch: false, scale: false, race: 5, grid: 'reverse' });
    expect(parseSwitches('?brain=x&scale=2&dirty=&watch=0')).toEqual({ watch: false });
  });
  it('overrides the config only where given, and labels what runs', () => {
    const ai = { brain: 'rules', scale: { oxford: { enabled: true } } }, slip = { dirtyAir: { maxDownforceLoss: 0.05 } };
    applySwitches(parseSwitches('?brain=lookahead&scale=0'), ai, slip);
    expect(ai).toEqual({ brain: 'lookahead', scale: { oxford: { enabled: false } } });
    expect(slip.dirtyAir.maxDownforceLoss).toBe(0.05);
    applySwitches(parseSwitches('?dirty=10'), ai, slip);
    expect(slip.dirtyAir.maxDownforceLoss).toBeCloseTo(0.1);
    expect(switchLabel(parseSwitches('?dirty=10&watch=1'), ai, slip)).toBe('brain lookahead · scale 0 · dirty 10% · watch');
    expect(switchLabel(parseSwitches(''), ai, slip)).toBe('');
  });
  it('reverse grid: slowest planned lap first, fastest last', () => {
    expect(reverseGridOrder([80, 82, 79, 81])).toEqual([1, 3, 0, 2]);
  });
  it('?car=v1 puts the old car over the live config, sections whole, and labels it', () => {
    const sw = parseSwitches('?car=v1');
    expect(sw.car).toBe('v1');
    expect(parseSwitches('?car=v2').car).toBeUndefined();
    const physics: Record<string, unknown> = { tyres: { baseGrip: 3, newThing: 1 }, fuel: { tankKg: 110 } };
    const specs: Record<string, unknown> = { setup: { a: 2 }, specs: { C1: {} } };
    const base = applyCar({ physics: { tyres: { baseGrip: 2.11 } }, specs: { setup: { a: 1 } }, baseSetup: { oxford: { frontWingDeg: 15 } } }, physics, specs);
    expect(physics).toEqual({ tyres: { baseGrip: 2.11 }, fuel: { tankKg: 110 } });
    expect(specs).toEqual({ setup: { a: 1 }, specs: { C1: {} } });
    expect(base).toEqual({ oxford: { frontWingDeg: 15 } });
    expect(switchLabel(sw, { brain: 'rules' }, { dirtyAir: { maxDownforceLoss: 0.05 } })).toBe('car v1 · brain rules · scale 0 · dirty 5%');
  });
});
