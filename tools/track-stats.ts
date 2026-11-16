// Layout numbers for a track (Oxford redesign card: before/after report), from its generated racing line.
// Usage: npm run track-stats -- <id> [--json]   (or: --file path/to/track.json, e.g. an old version)
//   lap length (racing line), main straight (the straight through start/finish) and the longest straight,
//   the slowest corner (reference-car speed from racingLineSpeed, and the line's radius there), and the
//   tightest radius anywhere. Straight = a full-throttle run of the reference speed profile (corner exit to
//   the next braking point).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TrackJson } from '../src/sim/index.ts';
import { TRACKS_DIR } from './load-track-node.ts';

export interface TrackStats {
  points: number;
  lapM: number;
  mainStraightM: number | undefined;
  longestStraightM: number;
  longestStraightAt: [number, number];
  slowest: { point: number; kph: number; radiusM: number } | undefined;
  tightest: { point: number; radiusM: number };
}

export function trackStats(json: TrackJson): TrackStats {
  const L = json.racingLine, n = L.length, k = json.pxPerMeter;
  const P = (i: number) => L[((i % n) + n) % n]!;
  const seg = (i: number) => Math.hypot(P(i + 1).x - P(i).x, P(i + 1).y - P(i).y) / k;
  let lap = 0;
  for (let i = 0; i < n; i++) lap += seg(i);
  // Radius at point i: arc length over heading change across +/- SPAN points (~+/-8 m): smooths point noise.
  const SPAN = 4;
  const head = (i: number) => Math.atan2(P(i + 1).y - P(i).y, P(i + 1).x - P(i).x);
  const radius = (i: number) => {
    let turn = 0, arc = 0;
    for (let j = i - SPAN; j < i + SPAN; j++) {
      let d = head(j + 1) - head(j);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      turn += d; arc += seg(j);
    }
    return Math.abs(turn) < 1e-9 ? Infinity : arc / Math.abs(turn);
  };
  const R = Array.from({ length: n }, (_, i) => radius(i));
  // Straights = full-throttle runs on the reference speed profile: consecutive points where the speed
  // doesn't drop (the racing line swings across the road on a straight, so its radius isn't a good test).
  // A run goes from a corner's slowest point to the next braking point.
  const v = json.racingLineSpeed;
  const runs: Array<{ from: number; to: number; m: number }> = [];
  if (v?.length === n) {
    const up = Array.from({ length: n }, (_, i) => v[(i + 1) % n]! >= v[i]! - 0.05);
    const start = up.findIndex((u) => !u);
    if (start >= 0)
      for (let j = 1; j <= n; j++) {
        const i = (start + j) % n;
        if (!up[i]) continue;
        const prevUp = up[(i - 1 + n) % n];
        if (j > 1 && prevUp && runs.length) { const r = runs[runs.length - 1]!; r.to = (i + 1) % n; r.m += seg(i); }
        else runs.push({ from: i, to: (i + 1) % n, m: seg(i) });
      }
  }
  const longest = runs.reduce((a, b) => (b.m > a.m ? b : a), { from: 0, to: 0, m: 0 });
  // Main straight: the run containing the line point nearest the start/finish line's middle.
  let main: number | undefined;
  const sf = json.timingLines?.startFinish;
  if (sf) {
    const mx = (sf.a.x + sf.b.x) / 2, my = (sf.a.y + sf.b.y) / 2;
    let bi = 0, bd = Infinity;
    L.forEach((p, i) => { const d = (p.x - mx) ** 2 + (p.y - my) ** 2; if (d < bd) { bd = d; bi = i; } });
    const inRun = (r: { from: number; to: number }) => (r.from <= r.to ? bi >= r.from && bi <= r.to : bi >= r.from || bi <= r.to);
    main = runs.find(inRun)?.m;
  }
  let slowest: TrackStats['slowest'];
  if (v?.length === n) {
    const i = v.reduce((bi, s, j) => (s < v[bi]! ? j : bi), 0);
    let r = Infinity;
    for (let d = -4; d <= 4; d++) r = Math.min(r, R[(i + d + n) % n]!);
    slowest = { point: i, kph: v[i]! * 3.6, radiusM: r };
  }
  const ti = R.reduce((bi, r, j) => (r < R[bi]! ? j : bi), 0);
  return { points: n, lapM: lap, mainStraightM: main, longestStraightM: longest.m, longestStraightAt: [longest.from, longest.to], slowest, tightest: { point: ti, radiusM: R[ti]! } };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/track-stats.ts')) {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--file');
  const id = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--file');
  const path = fi >= 0 ? args[fi + 1]! : id ? join(TRACKS_DIR, id, 'track.json') : undefined;
  if (!path) { console.error('usage: npm run track-stats -- <id> [--json] | --file track.json'); process.exit(1); }
  const s = trackStats(JSON.parse(readFileSync(path, 'utf8')) as TrackJson);
  if (args.includes('--json')) console.log(JSON.stringify(s));
  else {
    console.log(`${path}`);
    console.log(`  racing line: ${s.points} points, lap ${s.lapM.toFixed(0)} m`);
    console.log(`  main straight (full throttle through start/finish): ${s.mainStraightM === undefined ? '—' : `${s.mainStraightM.toFixed(0)} m`}`);
    console.log(`  longest full-throttle run: ${s.longestStraightM.toFixed(0)} m (line points ${s.longestStraightAt[0]}–${s.longestStraightAt[1]})`);
    console.log(`  slowest corner: ${s.slowest ? `${s.slowest.kph.toFixed(0)} kph at line point ${s.slowest.point}, radius ${s.slowest.radiusM.toFixed(1)} m` : '— (no racingLineSpeed)'}`);
    console.log(`  tightest radius: ${s.tightest.radiusM.toFixed(1)} m at line point ${s.tightest.point}`);
  }
}
