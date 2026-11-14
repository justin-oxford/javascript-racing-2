// @vitest-environment node
// Wet weather card: the rain curve, the water layer (rain, the dry line, drying), wet-weather tyres, and a
// wet race that stays deterministic.
import { describe, expect, it } from 'vitest';
import weatherJson from '../../config/weather.json';
import strategyJson from '../../config/strategy.json';
import { loadTrackNode, simContextNode } from '../../tools/load-track-node';
import aiJson from '../../config/ai.json';
import { catalog } from '../../tools/load-track-node';
import { aiInputSource, buildRacingLine, compoundWaterGrip, compoundWear, createRaceWorld, newSurfaceGrid, rainAt, shower, step, updateWater, waterAt, type AiConfig, type StrategyConfig, type WeatherConfig, type WorldState } from './index';

const wx = weatherJson as unknown as WeatherConfig;
const st = strategyJson as unknown as StrategyConfig;
const loaded = loadTrackNode('oxford');
const ctx = simContextNode(loaded);

describe('weather', () => {
  it('rain curve: none when dry, steady when wet, a seeded shower when changeable', () => {
    expect(rainAt(100, 'dry', 1, wx)).toBe(0);
    expect(rainAt(100, 'wet', 1, wx)).toBe(wx.wet.intensity);
    const s = shower(7, wx);
    expect(rainAt(s.start - 1, 'changeable', 7, wx)).toBe(0);
    expect(rainAt((s.start + s.end) / 2, 'changeable', 7, wx)).toBeCloseTo(s.intensity);
    expect(rainAt(s.end + 1, 'changeable', 7, wx)).toBe(0);
    expect(shower(7, wx)).toEqual(s); // same seed, same shower
    expect(shower(8, wx)).not.toEqual(s);
  });

  it('water: rain wets the track, a wheel clears its cell (the dry line), and it dries without rain', () => {
    let g = newSurfaceGrid(ctx.track, ctx.evolution);
    for (let t = 0; t < 600; t++) g = updateWater(g, ctx.track, [], 1, 1 / 60, wx);
    const line = { x: loaded.track.json.racingLine[0]!.x / loaded.track.json.pxPerMeter, y: loaded.track.json.racingLine[0]!.y / loaded.track.json.pxPerMeter };
    const wet = waterAt(g, line.x, line.y);
    expect(wet).toBeGreaterThan(0.1);
    const wheel = { x: line.x, y: line.y, load: 1, usage: 0.5, wear: 0, outX: 0, outY: 0, corner: 0, moving: true, speed: 40 };
    let dry = g;
    for (let t = 0; t < 120; t++) dry = updateWater(dry, ctx.track, [wheel], 0, 1 / 60, wx);
    expect(waterAt(dry, line.x, line.y)).toBeLessThan(wet * 0.5); // driven over: clearing fast
    let left = g;
    for (let t = 0; t < 120; t++) left = updateWater(left, ctx.track, [], 0, 1 / 60, wx);
    const leftW = waterAt(left, line.x, line.y);
    expect(leftW).toBeLessThan(wet); // drying on its own, but slowly
    expect(leftW).toBeGreaterThan(waterAt(dry, line.x, line.y));
  });

  it('tyres: slicks best dry, inters best damp, wets best soaked; inters and wets overheat on a dry track', () => {
    const g = (c: 'medium' | 'inter' | 'wet', w: number) => compoundWaterGrip(c, w, st) * st.compounds[c].grip;
    expect(g('medium', 0)).toBeGreaterThan(g('inter', 0));
    expect(g('inter', 0.3)).toBeGreaterThan(g('medium', 0.3));
    expect(g('wet', 1)).toBeGreaterThan(g('inter', 1));
    expect(compoundWear('inter', st, 0)).toBeGreaterThan(compoundWear('inter', st, 1) * 2);
  });

  it('a changeable race: every car pits for wet-weather tyres and back, and every stop changes tyres (Bugs: 5-7 stops for 4 changes)', () => {
    const line = buildRacingLine(ctx.track)!, cfg = aiJson as unknown as AiConfig;
    let w: WorldState = createRaceWorld(ctx, [0, 1, 2, 3].map((i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id, compound: 'medium' as const })), { laps: 14, seed: 3, settings: { weather: 'changeable', weatherSeed: 3 } });
    const ai = [0, 1, 2, 3].map((i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => ({ ...cfg.presets[cfg.defaultPreset]!, mistakesPerMin: 0 }), () => cfg, 50 + i));
    const changes = [0, 0, 0, 0];
    for (let t = 0; t < 60 * 60 * 12 && w.race!.phase !== 'results'; t++) {
      const prev = w;
      w = step(w, ai.map((d) => d.read(w.tick)), ctx);
      w.cars.forEach((c, i) => { if (c.compound !== prev.cars[i]!.compound) changes[i]!++; });
    }
    ai.forEach((d, i) => {
      expect(d.state.pitStops).toBeGreaterThanOrEqual(2); // onto wet-weather tyres and back
      expect(d.state.pitStops).toBe(changes[i]);
    });
  }, 240_000);

  it('a wet race is deterministic: same seed, same water, same result', () => {
    const line = buildRacingLine(ctx.track)!, cfg = aiJson as unknown as AiConfig;
    const run = () => {
      let w: WorldState = createRaceWorld(ctx, [0, 1, 2, 3].map((i) => ({ ...ctx.physics.defaultCar, team: catalog.teams[i]!.id, compound: 'inter' as const })), { laps: 1, seed: 3, settings: { weather: 'wet', weatherSeed: 9 } });
      const ai = [0, 1, 2, 3].map((i) => aiInputSource(i, () => ({ world: w, ctx, line }), () => cfg.presets[cfg.defaultPreset]!, () => cfg, 30 + i));
      for (let t = 0; t < 60 * 90 && w.race!.phase !== 'results'; t++) w = step(w, ai.map((d) => d.read(w.tick)), ctx);
      return w;
    };
    const a = run(), b = run();
    expect(a.surface?.water?.some((v) => v > 0)).toBe(true);
    expect(b.race!.order).toEqual(a.race!.order);
    expect(b.tick).toBe(a.tick);
    expect(b.surface!.water).toEqual(a.surface!.water);
  }, 60_000);
});
