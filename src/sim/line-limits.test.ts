// @vitest-environment node
// Racing line optimizer: hard track and turning limits. Every authored track's racing line and EXIT line keep the
// car's whole footprint on drivable surface (rule 1) and are never tighter than the live car can turn at the
// speed the profile plans there (rule 2). And the checks themselves catch the hairpin cut they were made for.
import { describe, expect, it } from 'vitest';
import racingLineJson from '../../config/racing-line.json';
import { listTracks } from '../../tools/track-list';
import { catalog, loadTrackNode, simContextNode, TRACKS_DIR } from '../../tools/load-track-node';
import { buildStats, cornerTable, footprintCheck, normalizeSetup, turnCheck, type Point } from './index';

// Player-facing tracks (fixtures like Indiana, a drafted test mask, are reported by track-fit but not held to this).
const tracks = listTracks(TRACKS_DIR).map((t) => t.id).filter((id) => { const j = loadTrackNode(id).track.json; return !j.fixture && j.racingLine.length > 2; });
const margin = racingLineJson.footprintMarginM ?? 0.2;
const toM = (pts: readonly Point[], ppm: number) => ({ x: pts.map((p) => p.x / ppm), y: pts.map((p) => p.y / ppm) });

describe('racing line hard limits', () => {
  it.each(tracks)('%s: the racing line and EXIT line keep the car\'s footprint on drivable surface', (id) => {
    const L = loadTrackNode(id), ctx = simContextNode(L), j = L.track.json;
    for (const pts of [j.racingLine, j.racingLineExit ?? []]) {
      if (pts.length < 3) continue;
      const f = footprintCheck(L.track, pts, ctx.physics.car.widthM / 2, margin);
      expect(f.bad, `room ${f.minRoomM.toFixed(2)} m at point ${f.at}`).toEqual([]);
    }
  });

  it.each(tracks)('%s: the racing line and EXIT line are never tighter than the car can turn at the planned speed', { timeout: 60_000 }, (id) => {
    const L = loadTrackNode(id), ctx = simContextNode(L), j = L.track.json;
    // Against the car's MEASURED cornering limits on the track's base setup (as the AI plans).
    const build = { ...ctx.physics.defaultCar, setup: normalizeSetup(j.baseSetup ?? ctx.physics.defaultCar.setup, catalog.specs.setup) };
    const stats = buildStats(build, catalog), table = cornerTable(ctx, build);
    for (const pts of [j.racingLine, j.racingLineExit ?? []]) {
      if (pts.length < 3) continue;
      const m = toM(pts, j.pxPerMeter), t = turnCheck(m.x, m.y, ctx.physics, stats, racingLineJson.turnRatioMin ?? 0.99, table);
      expect(t.bad, `ratio ${t.minRatio.toFixed(3)} at point ${t.at}: path ${t.pathRadiusM.toFixed(1)} m, car ${t.carRadiusM.toFixed(1)} m at ${t.kph.toFixed(0)} kph`).toEqual([]);
    }
  });

  it('the checks catch a point on an island tip and a kink tighter than the car can turn', () => {
    const L = loadTrackNode('oxford'), ctx = simContextNode(L), j = L.track.json, ppm = j.pxPerMeter;
    const stats = buildStats(ctx.physics.defaultCar, catalog);
    // Put one point on grass well off the road: the footprint check flags its segments.
    const line = j.racingLine.map((p) => ({ ...p }));
    const off = { x: 1442, y: 993 }; // the middle-right hairpin's island tip (Oxford v2, the old line point 101)
    line[50] = off;
    expect(footprintCheck(L.track, line, ctx.physics.car.widthM / 2, margin).bad.map((b) => b.i)).toContain(50);
    // A 3 m-radius circle is tighter than the car can turn at any speed (its lock at walking pace); a 20 m one isn't.
    const circle = (r: number) => { const n = Math.max(12, Math.round((2 * Math.PI * r) / 1)); return { x: Array.from({ length: n }, (_, i) => r * Math.cos((2 * Math.PI * i) / n)), y: Array.from({ length: n }, (_, i) => r * Math.sin((2 * Math.PI * i) / n)) }; };
    const c3 = circle(3), c20 = circle(20);
    expect(turnCheck(c3.x, c3.y, ctx.physics, stats).bad.length).toBeGreaterThan(0);
    expect(turnCheck(c20.x, c20.y, ctx.physics, stats).bad).toEqual([]);
  });
});
