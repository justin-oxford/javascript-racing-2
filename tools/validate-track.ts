// Check an authored track against SYS — Track authoring spec.
// Usage: npm run validate-track -- <id>
// Reports: file sizes, mask off-palette pixels, wall leaks (out of bounds touching a drivable surface,
// with coordinates), racing surface under the top-100px HUD bar, thin walls, overhead transparency.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { snapToPalette } from '../src/sim/index.ts';
import { surfaces, TRACKS_DIR } from './load-track-node.ts';

const SPEC = { width: 2560, height: 1440, hudBarPx: 100, minWallPx: 6 };

const id = process.argv[2];
if (!id) {
  console.error('usage: npm run validate-track -- <id>');
  process.exit(1);
}
const dir = join(TRACKS_DIR, id);
const idx = (name: string) => surfaces.findIndex((s) => s.id === name);
const WALL = idx('wall'), BARRIER = idx('tyreBarrier'), OOB = idx('outOfBounds');
const solid = (s: number) => s === WALL || s === BARRIER;
const drivable = (s: number) => !solid(s) && s !== OOB;
let problems = 0;
const warn = (msg: string) => { problems++; console.log(`  ✗ ${msg}`); };
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

/** Group pixel indices into 8-connected clusters; return bounding box + count for each, biggest first. */
function clusters(pixels: number[], w: number): Array<{ n: number; x0: number; y0: number; x1: number; y1: number }> {
  const set = new Set(pixels);
  const out = [];
  for (const start of pixels) {
    if (!set.has(start)) continue;
    set.delete(start);
    const stack = [start];
    let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i - x) / w;
      n++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (x + dx < 0 || x + dx >= w) continue; // don't wrap across rows
          const j = (y + dy) * w + (x + dx);
          if (set.has(j)) { set.delete(j); stack.push(j); }
        }
    }
    out.push({ n, x0, y0, x1, y1 });
  }
  return out.sort((a, b) => b.n - a.n);
}
const box = (c: { x0: number; y0: number; x1: number; y1: number }) =>
  c.x0 === c.x1 && c.y0 === c.y1 ? `(${c.x0}, ${c.y0})` : `x ${c.x0}-${c.x1}, y ${c.y0}-${c.y1}`;

console.log(`Track "${id}" (${dir})`);

// ---- files + sizes
const files: Record<string, PNG | undefined> = {};
for (const f of ['mask.png', 'background.png', 'overhead.png']) {
  const p = join(dir, f);
  files[f] = existsSync(p) ? PNG.sync.read(readFileSync(p)) : undefined;
}
console.log('\nFiles');
const mask = files['mask.png'];
if (!mask) {
  warn('mask.png missing (required)');
  process.exit(1);
}
for (const [f, png] of Object.entries(files)) {
  if (!png) { console.log(`  - ${f}: not present${f === 'mask.png' ? '' : ' (optional)'}`); continue; }
  const size = `${png.width}x${png.height}`;
  if (png.width !== SPEC.width || png.height !== SPEC.height) warn(`${f}: ${size}, spec is ${SPEC.width}x${SPEC.height}`);
  else if (png.width !== mask.width || png.height !== mask.height) warn(`${f}: ${size} doesn't match mask`);
  else ok(`${f}: ${size}`);
}

// ---- palette
const { width: w, height: h } = mask;
const snapped = snapToPalette(mask.data, w, h, surfaces);
const m = snapped.mask.data;
console.log('\nMask palette');
if (snapped.offPalette === 0) ok('every pixel is an exact palette colour');
else {
  const off: number[] = [];
  const pal = surfaces.map((s) => parseInt(s.color.slice(1), 16));
  for (let i = 0; i < w * h; i++) {
    const a = mask.data[i * 4 + 3]!;
    const rgb = (mask.data[i * 4]! << 16) | (mask.data[i * 4 + 1]! << 8) | mask.data[i * 4 + 2]!;
    if (a < 255 || !pal.includes(rgb)) off.push(i);
  }
  // Did snapping invent a surface? An off-palette pixel snapped to something none of its exact-colour
  // neighbours are (e.g. a red/green kerb edge turning into gravel) is a real gameplay change.
  const isExact = new Uint8Array(w * h).fill(1);
  for (const i of off) isExact[i] = 0;
  const invented: number[] = [];
  for (const i of off) {
    const x = i % w;
    const near = new Set<number>();
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const j = i + dy * w + dx;
        if (x + dx >= 0 && x + dx < w && j >= 0 && j < w * h && isExact[j]) near.add(snapped.mask.data[j]!);
      }
    if (near.size && !near.has(snapped.mask.data[i]!)) invented.push(i);
  }
  if (invented.length) {
    const ic = clusters(invented, w);
    warn(`${invented.length} edge pixels snapped to a surface none of their neighbours have: ${ic.slice(0, 6).map((c) => `${box(c)} -> ${surfaces[snapped.mask.data[(c.y0 * w) + c.x0]!]?.id ?? '?'}`).join('; ')}`);
  } else ok('snapping only ever picked a neighbouring surface (anti-aliased edges resolve cleanly)');
  const cl = clusters(off, w);
  warn(`${snapped.offPalette} off-palette pixels (${((100 * snapped.offPalette) / (w * h)).toFixed(3)}%), snapped to nearest; ${cl.length} patch(es). Largest: ${cl.slice(0, 5).map((c) => `${c.n}px at ${box(c)}`).join('; ')}`);
}
const counts = surfaces.map((s, i) => [s.id, m.reduce((n, v) => n + (v === i ? 1 : 0), 0)] as const);
console.log('  coverage: ' + counts.filter(([, n]) => n > 0).map(([s, n]) => `${s} ${((100 * n) / (w * h)).toFixed(1)}%`).join(', '));

// ---- closed walls: flood the DRIVING AREA (the non-solid region around the spawn, else the biggest
// asphalt region) and see whether it reaches out of bounds or the image edge.
console.log('\nWalls closed?');
const jsonPath = join(dir, 'track.json');
const spawn = existsSync(jsonPath) ? (JSON.parse(readFileSync(jsonPath, 'utf8')) as { spawn?: { x: number; y: number } }).spawn : undefined;
const region = new Int32Array(w * h).fill(-1);
function flood(seed: number, label: number): number[] {
  const out: number[] = [];
  const st = [seed];
  while (st.length) {
    const i = st.pop()!;
    if (region[i] !== -1 || solid(m[i]!)) continue;
    region[i] = label;
    out.push(i);
    const x = i % w;
    if (x > 0) st.push(i - 1);
    if (x < w - 1) st.push(i + 1);
    if (i >= w) st.push(i - w);
    if (i < w * (h - 1)) st.push(i + w);
  }
  return out;
}
let area: number[] = [];
if (spawn) area = flood(Math.floor(spawn.y) * w + Math.floor(spawn.x), 0);
else {
  // No track.json yet: biggest connected non-solid region that contains asphalt.
  const asphalt = idx('asphalt');
  let label = 0;
  for (let i = 0; i < w * h; i++) {
    if (region[i] !== -1 || m[i] !== asphalt) continue;
    const r = flood(i, label++);
    if (r.length > area.length) area = r;
  }
}
const inArea = new Uint8Array(w * h);
for (const i of area) inArea[i] = 1;
const doors = area.filter((i) => {
  const x = i % w, y = (i - x) / w;
  return m[i] === OOB || x === 0 || y === 0 || x === w - 1 || y === h - 1;
});
console.log(`  driving area: ${area.length} px${spawn ? ' (around the spawn)' : ' (biggest asphalt region)'}`);
if (!doors.length) ok('closed: the driving area never reaches out of bounds or the image edge');
else {
  const cl = clusters(doors, w);
  warn(`LEAK: the driving area reaches out of bounds / the image edge at ${cl.slice(0, 10).map((c) => `${box(c)} [${c.n}px]`).join('; ')}${cl.length > 10 ? `; +${cl.length - 10} more` : ''}`);
}
// Drivable paint the cars can never reach (outside the walls, or in sealed-off pockets). Harmless; FYI.
const stray: number[] = [];
for (let i = 0; i < w * h; i++) if (!inArea[i] && drivable(m[i]!)) stray.push(i);
if (stray.length) {
  const cl = clusters(stray, w);
  console.log(`  - info: ${stray.length} drivable-coloured px outside the driving area (unreachable, harmless) in ${cl.length} region(s). Largest: ${cl.slice(0, 5).map((c) => `${box(c)} [${c.n}px]`).join('; ')}`);
}

// ---- HUD bar
console.log('\nTop HUD bar');
const hud: number[] = [];
for (let y = 0; y < SPEC.hudBarPx; y++) for (let x = 0; x < w; x++) if (drivable(m[y * w + x]!)) hud.push(y * w + x);
if (!hud.length) ok(`no drivable surface in the top ${SPEC.hudBarPx} px`);
else warn(`${hud.length} drivable pixels under the HUD bar (y < ${SPEC.hudBarPx}): ${clusters(hud, w).slice(0, 5).map(box).join('; ')}`);

// ---- thin walls: a wall pixel is thin if no disc of diameter minWallPx made entirely of wall covers it.
// (Distance transform -> disc centres -> grow them back; works for walls at any angle and ignores
// the square corners at line ends.) Only reported where the wall touches drivable surface.
console.log('\nWall thickness');
{
  const R = SPEC.minWallPx / 2;
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = solid(m[i]!) ? INF : 0;
  const D1 = 1, D2 = Math.SQRT2; // chamfer distance to the nearest non-solid pixel (outside the image counts as wall)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      if (x > 0) d[i] = Math.min(d[i]!, d[i - 1]! + D1);
      if (y > 0) {
        d[i] = Math.min(d[i]!, d[i - w]! + D1);
        if (x > 0) d[i] = Math.min(d[i]!, d[i - w - 1]! + D2);
        if (x < w - 1) d[i] = Math.min(d[i]!, d[i - w + 1]! + D2);
      }
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      if (x < w - 1) d[i] = Math.min(d[i]!, d[i + 1]! + D1);
      if (y < h - 1) {
        d[i] = Math.min(d[i]!, d[i + w]! + D1);
        if (x < w - 1) d[i] = Math.min(d[i]!, d[i + w + 1]! + D2);
        if (x > 0) d[i] = Math.min(d[i]!, d[i + w - 1]! + D2);
      }
    }
  // Disc centres: at least R from any non-solid pixel (pixel centres, so R - 0.5 tolerance).
  const covered = new Uint8Array(w * h);
  const r = Math.ceil(R);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (d[y * w + x]! < R - 0.5) continue;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && dx * dx + dy * dy <= R * R + 0.5) covered[yy * w + xx] = 1;
        }
    }
  const thin: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!solid(m[i]!) || covered[i]) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const xx = x + dx!, yy = y + dy!;
        return xx >= 0 && yy >= 0 && xx < w && yy < h && inArea[yy * w + xx];
      })) thin.push(i);
    }
  if (!thin.length) ok(`walls facing the driving area are at least ${SPEC.minWallPx} px thick`);
  else {
    const cl = clusters(thin, w);
    warn(`${cl.length} wall section(s) thinner than ${SPEC.minWallPx} px facing the driving area: ${cl.slice(0, 8).map((c) => `${box(c)} [${c.n}px]`).join('; ')}${cl.length > 8 ? `; +${cl.length - 8} more` : ''}`);
  }
}

// ---- pits
console.log('\nPits');
const boxes = clusters(Array.from({ length: w * h }, (_, i) => i).filter((i) => m[i] === idx('pitBox')), w);
const lane = counts.find(([s]) => s === 'pitLane')![1];
if (boxes.length) ok(`${boxes.length} pit box(es): ${boxes.map((c) => `${c.x1 - c.x0 + 1}x${c.y1 - c.y0 + 1} at ${box(c)}`).join('; ')}`);
else warn('no pit box');
if (lane) ok(`pit lane present (${lane} px)`);
else warn('no pit lane');

// ---- overhead transparency
console.log('\nOverhead');
const ov = files['overhead.png'];
if (!ov) console.log('  - not present (optional)');
else {
  let clear = 0, partial = 0;
  for (let i = 0; i < ov.width * ov.height; i++) {
    const a = ov.data[i * 4 + 3]!;
    if (a === 0) clear++;
    else if (a < 255) partial++;
  }
  const n = ov.width * ov.height;
  if (clear === 0 && partial === 0) warn('overhead.png is fully opaque: it would cover the whole track. Export with transparency on.');
  else ok(`transparent ${((100 * clear) / n).toFixed(1)}%, semi-transparent ${((100 * partial) / n).toFixed(1)}%, opaque ${((100 * (n - clear - partial)) / n).toFixed(1)}%`);
}

console.log(`\n${problems ? `${problems} problem(s) found.` : 'All checks passed.'}`);
