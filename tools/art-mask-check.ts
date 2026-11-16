// Art vs mask (Oxford redesign card): does the painting match the mask? Colour-based, so it's a pointer
// to spots worth a look, not a verdict.
// Usage: npm run art-mask-check -- <id> [--png out.png] [--min 300]
//   For each mask class (road = asphalt/pit lane/pit box, kerb, grass, gravel, wall = wall/tyre barrier) it
//   takes the art's typical colour (median over pixels well inside that class), then flags pixels the art
//   paints clearly as ANOTHER class. Pixels within 4 px of a class edge are skipped (antialiasing, kerb
//   paint). Flagged pixels are grouped into spots; each spot >= --min px is listed with its box, its size in
//   m², the nearest racing-line point and what the mask says vs what the art looks like.
//   --png: the art dimmed, flagged pixels coloured by what the ART looks like (road grey-blue, grass green,
//   gravel yellow, wall white, kerb red), each listed spot boxed in magenta.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { snapToPalette, type TrackJson } from '../src/sim/index.ts';
import { surfaces, TRACKS_DIR } from './load-track-node.ts';

const args = process.argv.slice(2);
const id = args[0];
if (!id) {
  console.error('usage: npm run art-mask-check -- <id> [--png out.png] [--min 300]');
  process.exit(1);
}
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const MIN = Number(opt('min') ?? 300);
const dir = join(TRACKS_DIR, id);
const json = JSON.parse(readFileSync(join(dir, 'track.json'), 'utf8')) as TrackJson;
const maskPng = PNG.sync.read(readFileSync(join(dir, json.files.mask)));
const artFile = join(dir, json.files.background ?? 'background.png');
if (!existsSync(artFile)) { console.log('no background art: nothing to compare'); process.exit(0); }
const art = PNG.sync.read(readFileSync(artFile));
const W = maskPng.width, H = maskPng.height;
if (art.width !== W || art.height !== H) { console.log(`✗ art is ${art.width}x${art.height}, mask ${W}x${H}`); process.exit(1); }
const { mask } = snapToPalette(maskPng.data, W, H, surfaces);

// Mask surface -> comparison class (-1 = ignored: out of bounds).
const CLASSES = ['road', 'kerb', 'grass', 'gravel', 'wall'] as const;
const CLASS_OF: Record<string, number> = { asphalt: 0, pitLane: 0, pitBox: 0, kerb: 1, grass: 2, gravel: 3, wall: 4, tyreBarrier: 4 };
const surfClass = surfaces.map((s) => CLASS_OF[s.id] ?? -1);
const cls = new Int8Array(W * H);
for (let i = 0; i < W * H; i++) cls[i] = surfClass[mask.data[i]!] ?? -1;

// Distance (px, chessboard, capped at 5) to a pixel of another class: skip the edges.
const EDGE = 4;
const near = new Uint8Array(W * H);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const i = y * W + x, c = cls[i]!;
    let edge = false;
    for (let dy = -EDGE; dy <= EDGE && !edge; dy += 1) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -EDGE; dx <= EDGE; dx += EDGE) { // cross-ish sample: cheap, catches every edge
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        if (cls[yy * W + xx] !== c) { edge = true; break; }
      }
    }
    if (!edge) for (let dx = -EDGE; dx <= EDGE && !edge; dx++) {
      const xx = x + dx;
      if (xx >= 0 && xx < W && cls[y * W + xx] !== c) edge = true;
    }
    near[i] = edge ? 1 : 0;
  }

// Each class's typical art colour: per-channel median over its interior pixels.
const median = (v: number[]) => { v.sort((a, b) => a - b); return v[v.length >> 1] ?? 0; };
const centre: Array<[number, number, number] | undefined> = CLASSES.map((_, k) => {
  const r: number[] = [], g: number[] = [], b: number[] = [];
  for (let i = 0; i < W * H; i += 3) {
    if (cls[i] !== k || near[i]) continue;
    r.push(art.data[i * 4]!); g.push(art.data[i * 4 + 1]!); b.push(art.data[i * 4 + 2]!);
  }
  return r.length > 50 ? [median(r), median(g), median(b)] : undefined;
});
console.log(`Art vs mask, "${id}" (${W}x${H}, ${json.pxPerMeter} px/m)`);
console.log('  typical art colour per mask class: ' + CLASSES.map((c, k) => `${c} ${centre[k] ? `rgb(${centre[k]!.join(',')})` : '—'}`).join(', '));

// Flag: the art pixel is much nearer another class's colour than its own.
const d2 = (i: number, c: [number, number, number]) => {
  const r = art.data[i * 4]! - c[0], g = art.data[i * 4 + 1]! - c[1], b = art.data[i * 4 + 2]! - c[2];
  return r * r + g * g + b * b;
};
const looks = new Int8Array(W * H).fill(-1);
const flagged: number[] = [];
for (let i = 0; i < W * H; i++) {
  const c = cls[i]!;
  if (c < 0 || near[i] || !centre[c]) continue;
  const own = d2(i, centre[c]!);
  if (own < 45 * 45) continue; // close enough to its own colour
  let best = -1, bestD = Infinity;
  for (let k = 0; k < CLASSES.length; k++) {
    if (k === c || !centre[k]) continue;
    const d = d2(i, centre[k]!);
    if (d < bestD) { bestD = d; best = k; }
  }
  if (best >= 0 && bestD * 4 < own) { looks[i] = best; flagged.push(i); } // 2x nearer the other colour
}

// Spots: 8-connected groups of flagged pixels with the same (mask, art) pair; small gaps bridged by
// grouping on a 4 px grid first.
const CELL = 4, GW = Math.ceil(W / CELL), GH = Math.ceil(H / CELL);
const cellPair = new Map<number, Map<number, number>>(); // cell -> pair -> count
for (const i of flagged) {
  const x = i % W, y = (i - x) / W, cell = Math.floor(y / CELL) * GW + Math.floor(x / CELL);
  const pair = cls[i]! * 10 + looks[i]!;
  let m = cellPair.get(cell);
  if (!m) cellPair.set(cell, (m = new Map()));
  m.set(pair, (m.get(pair) ?? 0) + 1);
}
interface Spot { pair: number; n: number; x0: number; y0: number; x1: number; y1: number }
const spots: Spot[] = [];
const seen = new Set<string>();
for (const [cell, pairs] of cellPair)
  for (const pair of pairs.keys()) {
    const k0 = `${cell}:${pair}`;
    if (seen.has(k0)) continue;
    seen.add(k0);
    const stack = [cell];
    const s: Spot = { pair, n: 0, x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % GW, cy = (c - cx) / GW;
      s.n += cellPair.get(c)!.get(pair)!;
      s.x0 = Math.min(s.x0, cx * CELL); s.y0 = Math.min(s.y0, cy * CELL);
      s.x1 = Math.max(s.x1, cx * CELL + CELL - 1); s.y1 = Math.max(s.y1, cy * CELL + CELL - 1);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
          const nc = ny * GW + nx, k = `${nc}:${pair}`;
          if (!seen.has(k) && cellPair.get(nc)?.has(pair)) { seen.add(k); stack.push(nc); }
        }
    }
    spots.push(s);
  }
const big = spots.filter((s) => s.n >= MIN).sort((a, b) => b.n - a.n);
const line = json.racingLine ?? [];
const nearestPoint = (x: number, y: number) => {
  let bi = -1, bd = Infinity;
  line.forEach((p, i) => { const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d < bd) { bd = d; bi = i; } });
  return bi < 0 ? '—' : `line point ${bi} (${(Math.sqrt(bd) / json.pxPerMeter).toFixed(0)} m away)`;
};
const m2 = (n: number) => (n / json.pxPerMeter ** 2).toFixed(1);
const total = flagged.length;
console.log(`  flagged ${total} px (${m2(total)} m²) in ${spots.length} spot(s); ${big.length} spot(s) of ${MIN}+ px:`);
for (const s of big) {
  const mk = CLASSES[Math.floor(s.pair / 10)]!, lk = CLASSES[s.pair % 10]!;
  const cx = (s.x0 + s.x1) >> 1, cy = (s.y0 + s.y1) >> 1;
  console.log(`  - mask ${mk}, art looks ${lk}: ${s.n} px (${m2(s.n)} m²) at x ${s.x0}-${s.x1}, y ${s.y0}-${s.y1}; ${nearestPoint(cx, cy)}`);
}
if (!big.length) console.log('  ✓ no spot big enough to list');

const out = opt('png');
if (out) {
  const COL: Array<[number, number, number]> = [[110, 140, 255], [255, 40, 40], [40, 230, 40], [255, 230, 0], [255, 255, 255]];
  const o = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) {
    const L = looks[i]!;
    for (let ch = 0; ch < 3; ch++) o.data[i * 4 + ch] = L >= 0 ? COL[L]![ch]! : art.data[i * 4 + ch]! * 0.35;
    o.data[i * 4 + 3] = 255;
  }
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4; o.data[i] = 255; o.data[i + 1] = 0; o.data[i + 2] = 255;
  };
  for (const s of big)
    for (let t = 0; t < 3; t++) {
      for (let x = s.x0 - 6 - t; x <= s.x1 + 6 + t; x++) { put(x, s.y0 - 6 - t); put(x, s.y1 + 6 + t); }
      for (let y = s.y0 - 6 - t; y <= s.y1 + 6 + t; y++) { put(s.x0 - 6 - t, y); put(s.x1 + 6 + t, y); }
    }
  writeFileSync(out, PNG.sync.write(o));
  console.log(`  wrote ${out}`);
}
