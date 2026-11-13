// @vitest-environment node
// Race strategy card: compounds, the pit board, stops, fuel weight, race-length scaling.
import { describe, expect, it } from 'vitest';
import strategyJson from '../../config/strategy.json';
import { aiCompound, aiStartCompound, compoundGrip, compoundWear, consumableScale, defaultPitPlan, FUEL_TO_END, fuelGrip, startStop, stopDone, stopFuelTarget, validPitPlan, type StrategyConfig } from './strategy';

const cfg = strategyJson as StrategyConfig;

describe('strategy', () => {
  it('compounds: soft grips most and wears fastest, hard the reverse', () => {
    expect(compoundGrip('soft', cfg)).toBeGreaterThan(compoundGrip('medium', cfg));
    expect(compoundGrip('medium', cfg)).toBeGreaterThan(compoundGrip('hard', cfg));
    expect(compoundWear('soft', cfg)).toBeGreaterThan(compoundWear('medium', cfg));
    expect(compoundWear('medium', cfg)).toBeGreaterThan(compoundWear('hard', cfg));
  });

  it('fuel weight: grip falls as the tank fills; no effect without loadSensitivity', () => {
    expect(fuelGrip(800, 110, 0.23)).toBeLessThan(fuelGrip(800, 10, 0.23));
    expect(fuelGrip(800, 0, 0.23)).toBe(1);
    expect(fuelGrip(800, 110, undefined)).toBe(1);
  });

  it('race length: matched scales short races up, never long ones down; off and practice are 1', () => {
    expect(consumableScale('off', 5, cfg)).toBe(1);
    expect(consumableScale(undefined, 5, cfg)).toBe(1);
    expect(consumableScale('matched', undefined, cfg)).toBe(1);
    expect(consumableScale('matched', 5, cfg)).toBeCloseTo(cfg.raceLength.refLaps / 5);
    expect(consumableScale('matched', cfg.raceLength.refLaps * 3, cfg)).toBe(1);
  });

  it('pit board input is checked: malformed keeps the current plan, fuel clamped to the tank', () => {
    const cur = defaultPitPlan(cfg);
    expect(validPitPlan({ compound: 'ultra', fuelKg: 5, tyres: true, repair: true }, cur, 110)).toBe(cur);
    expect(validPitPlan(undefined, cur, 110)).toBe(cur);
    expect(validPitPlan({ compound: 'soft', fuelKg: 500, tyres: false, repair: false }, cur, 110)).toEqual({ compound: 'soft', fuelKg: 110, tyres: false, repair: false });
    expect(validPitPlan({ compound: 'hard', fuelKg: FUEL_TO_END, tyres: true, repair: true }, cur, 110).fuelKg).toBe(FUEL_TO_END);
  });

  it('stop fuel: a fixed amount on top; "to the end" from the burn so far (+ margin), full without a race', () => {
    const plan = { ...defaultPitPlan(cfg), fuelKg: 15 };
    expect(stopFuelTarget(plan, 20, 110, 10, 7, cfg)).toBe(35);
    expect(stopFuelTarget({ ...plan, fuelKg: FUEL_TO_END }, 20, 110, 10, 7, cfg)).toBeCloseTo((10 + cfg.service.fuelEndMarginLaps) * 7);
    expect(stopFuelTarget({ ...plan, fuelKg: FUEL_TO_END }, 20, 110, undefined, undefined, cfg)).toBe(110);
    expect(stopFuelTarget({ ...plan, fuelKg: FUEL_TO_END }, 90, 110, 1, 7, cfg)).toBe(90); // never drains
    // Race length matched (x4): the margin is in the reference race's laps, so a quarter of a lap here.
    expect(stopFuelTarget({ ...plan, fuelKg: FUEL_TO_END }, 5, 110, 2, 28, cfg, 4)).toBeCloseTo((2 + cfg.service.fuelEndMarginLaps / 4) * 28);
  });

  it('a stop is done when the tyres are fitted, the fuel is in and any asked-for repair is finished', () => {
    const s = startStop({ ...defaultPitPlan(cfg), compound: 'soft' }, 50, true, cfg);
    expect(s.fitting).toBe('soft');
    expect(s.tyreLeftSec).toBe(cfg.service.tyreChangeSec);
    expect(stopDone(s, 50, false)).toBe(false); // tyres still going on
    expect(stopDone({ ...s, fitting: null }, 50, true)).toBe(false); // still repairing
    expect(stopDone({ ...s, fitting: null }, 50, false)).toBe(true);
    expect(stopDone({ ...s, fitting: null }, 40, false)).toBe(false); // fuel not in yet
    expect(stopDone(null, 50, false)).toBe(false);
  });

  it('AI tyres: the grippiest that lasts the laps left; the longest-lasting if none does; a seeded start pick', () => {
    expect(aiCompound(3, 1, cfg)).toBe('soft');
    expect(aiCompound(cfg.compounds.soft.lifeLaps + 1, 1, cfg)).toBe('medium');
    expect(aiCompound(999, 1, cfg)).toBe('hard');
    expect(aiCompound(cfg.compounds.soft.lifeLaps - 1, 3, cfg)).not.toBe('soft'); // wear x3: soft won't last
    expect(new Set([0.1, 0.9].map((r) => aiStartCompound(10, 1, cfg, r))).size).toBe(2);
  });
});
