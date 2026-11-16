// A close-up of a track's racing line (Racing line optimizer card: the hairpin before / after), like the K
// overlay: the art, the racing line (cyan dots), the EXIT line (orange dots) and the car's footprint either side
// of the racing line (half its width + the footprint margin, white). Points failing a hard rule are magenta.
// Usage: npm run line-shot -- <id> --x 1250 --y 850 --w 380 --h 320 [--scale 2] [--file other-track.json] --out file.png
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import racingLineJson from '../config/racing-line.json' with { type: 'json' };
import { buildStats, footprintCheck, turnCheck, type Point, type TrackJson } from '../src/sim/index.ts';
import { catalog, loadTrackNode, simContextNode, TRACKS_DIR } from './load-track-node.ts';

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const id = args[0]!;
const L = loadTrackNode(id), ctx = simContextNode(L);
const json: TrackJson = opt('file') ? (JSON.parse(readFileSync(opt('file')!, 'utf8')) as TrackJson) : L.track.json;
const ppm = json.pxPerMeter, S = Number(opt('scale', '2'));
const X0 = Number(opt('x')), Y0 = Number(opt('y')), W = Number(opt('w')), H = Number(opt('h'));
const art = PNG.sync.read(readFileSync(join(TRACKS_DIR, id, json.files.background ?? 'background.png')));
const o = new PNG({ width: W * S, height: H * S });
for (let y = 0; y < H * S; y++) for (let x = 0; x < W * S; x++) { const s = ((Y0 + Math.floor(y / S)) * art.width + X0 + Math.floor(x / S)) * 4, d = (y * W * S + x) * 4; for (let c = 0; c < 3; c++) o.data[d + c] = art.data[s + c]!; o.data[d + 3] = 255; }
const dot = (x: number, y: number, c: number[], r: number) => { const cx = (x - X0) * S, cy = (y - Y0) * S; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { if (dx * dx + dy * dy > r * r) continue; const xx = Math.round(cx + dx), yy = Math.round(cy + dy); if (xx < 0 || yy < 0 || xx >= W * S || yy >= H * S) continue; const k = (yy * W * S + xx) * 4; o.data[k] = c[0]!; o.data[k + 1] = c[1]!; o.data[k + 2] = c[2]!; } };
const stats = buildStats(ctx.physics.defaultCar, catalog), half = ctx.physics.car.widthM / 2 + (racingLineJson.footprintMarginM ?? 0.2);
const draw = (pts: readonly Point[] | undefined, col: number[], edges: boolean) => {
  if (!pts?.length) return;
  const fp = new Set(footprintCheck(L.track, pts, ctx.physics.car.widthM / 2, racingLineJson.footprintMarginM ?? 0.2).bad.flatMap((b) => [b.i, (b.i + 1) % pts.length]));
  const tc = new Set(turnCheck(pts.map((p) => p.x / ppm), pts.map((p) => p.y / ppm), ctx.physics, stats, racingLineJson.turnRatioMin ?? 0.99).bad);
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!, l = Math.hypot(b.x - a.x, b.y - a.y) || 1, nx = -(b.y - a.y) / l, ny = (b.x - a.x) / l;
    for (let s = 0; s < 8; s++) {
      const x = a.x + ((b.x - a.x) * s) / 8, y = a.y + ((b.y - a.y) * s) / 8;
      if (edges) { dot(x + nx * half * ppm, y + ny * half * ppm, [255, 255, 255], 1); dot(x - nx * half * ppm, y - ny * half * ppm, [255, 255, 255], 1); }
    }
    dot(a.x, a.y, fp.has(i) || tc.has(i) ? [255, 0, 255] : col, fp.has(i) || tc.has(i) ? 4 : 3);
  }
};
draw(json.racingLineExit, [255, 150, 0], false);
draw(json.racingLine, [60, 220, 255], true);
writeFileSync(opt('out')!, PNG.sync.write(o));
console.log(`wrote ${opt('out')}`);
