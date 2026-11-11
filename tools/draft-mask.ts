// Draft gameplay mask from a track background (card 02, step 1).
// Usage: node tools/draft-mask.ts <background.jpg> <out mask-draft.png> [hints.json]
// Rough by design: Justin paints the real mask over it. Expect errors around lettering,
// hatching, trees and pit markings.
//
// hints.json (optional, per track): { "pitBoxes": [{ x0, y0, x1, y1 }], "pitLaneSeeds": [{ x, y }] } in image pixels.
import { readFileSync, writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import surfacesConfig from '../config/surfaces.json' with { type: 'json' };

const [src, out, hintsPath] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node tools/draft-mask.ts <background.jpg> <out.png> [hints.json]');
  process.exit(1);
}
interface Rect { x0: number; y0: number; x1: number; y1: number }
const hints: { pitBoxes?: Rect[]; pitLaneSeeds?: Array<{ x: number; y: number }> } = hintsPath ? JSON.parse(readFileSync(hintsPath, 'utf8')) : {};

const hex = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
const colorOf = Object.fromEntries(surfacesConfig.surfaces.map((s) => [s.id, hex(s.color)]));
type Cls = 'asphalt' | 'pitLane' | 'pitBox' | 'kerb' | 'grass' | 'wall' | 'outOfBounds';

const img = jpeg.decode(readFileSync(src), { useTArray: true });
const { width: w, height: h, data } = img;
let cls: Cls[] = new Array(w * h);
const at = (x: number, y: number): Cls | undefined => (x >= 0 && y >= 0 && x < w && y < h ? cls[y * w + x] : undefined);
const near = (x: number, y: number, r: number, want: Cls): boolean => {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (at(x + dx, y + dy) === want) return true;
  return false;
};

// 1. Per-pixel colour classification.
for (let i = 0; i < w * h; i++) {
  const r = data[i * 4]!, g = data[i * 4 + 1]!, b = data[i * 4 + 2]!;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  let c: Cls;
  if (r > 140 && r > g * 1.8 && r > b * 1.8) c = 'kerb';
  else if (max > 205 && sat < 0.12) c = 'wall'; // white painted boundary lines
  else if (sat > 0.18 && g >= r * 0.85 && g > b * 1.15) c = 'grass'; // grass + tree canopy
  else if (sat < 0.12 && max >= 134 && max <= 175) c = 'pitLane'; // pit lane is painted lighter than the racing surface (~110)
  else c = 'asphalt'; // greys, yellow paint, dark shadow
  cls[i] = c;
}

// 2. Smooth asphalt/pit-lane speckle: 5x5 majority between the two.
{
  const next = cls.slice();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = cls[y * w + x];
      if (c !== 'asphalt' && c !== 'pitLane') continue;
      let a = 0, p = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const n = at(x + dx, y + dy);
          if (n === 'asphalt') a++;
          else if (n === 'pitLane') p++;
        }
      next[y * w + x] = p > a ? 'pitLane' : 'asphalt';
    }
  cls = next;
}

// 3. White pixels touching red are kerb stripes, not walls.
{
  const fix: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (cls[y * w + x] === 'wall' && near(x, y, 3, 'kerb')) fix.push(y * w + x);
  for (const i of fix) cls[i] = 'kerb';
}

// 4. Thin painted lines (timing lines, garage boxes, pit entry lines) with the same driveable
//    surface on both sides are paint, not walls. Checked at 4, 8 and 16 px either side so a real wall
//    with a dark gutter beside it (Indiana's pit wall) isn't mistaken for paint.
{
  const fix: Array<[number, Cls]> = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (cls[y * w + x] !== 'wall') continue;
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const side = (R: number): Cls | undefined => {
          const a = at(x - dx * R, y - dy * R), b = at(x + dx * R, y + dy * R);
          return a && a === b && (a === 'asphalt' || a === 'pitLane') ? a : undefined;
        };
        const a = side(4);
        if (a && side(8) === a && side(16) === a) { fix.push([y * w + x, a]); break; }
      }
    }
  for (const [i, c] of fix) cls[i] = c;
}

// 5. Out of bounds: flood inward from every border pixel through anything that isn't a wall
//    (walls dilated by 1 px so JPEG gaps don't leak the fill onto the track).
{
  const barrier = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (near(x, y, 1, 'wall')) barrier[y * w + x] = 1;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop()!;
    if (seen[i] || barrier[i]) continue;
    seen[i] = 1;
    const x = i % w, y = (i - x) / w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  for (let i = 0; i < w * h; i++) if (seen[i]) cls[i] = 'outOfBounds';
  // Wall pixels with no driveable surface within 3 px are hatching/edge noise outside the track.
  const fix: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (cls[y * w + x] === 'wall' && near(x, y, 2, 'outOfBounds') && !near(x, y, 3, 'asphalt') && !near(x, y, 3, 'pitLane') && !near(x, y, 3, 'grass'))
        fix.push(y * w + x);
  for (const i of fix) cls[i] = 'outOfBounds';
}

// 6. Pit lane = only the light-grey region connected to a hinted pit box; stray light patches are asphalt.
if (hints.pitBoxes?.length) {
  const keep = new Uint8Array(w * h);
  const stack: number[] = [];
  for (const r of hints.pitBoxes) stack.push(Math.round((r.y0 + r.y1) / 2) * w + Math.round((r.x0 + r.x1) / 2));
  for (const p of hints.pitLaneSeeds ?? []) stack.push(p.y * w + p.x);
  while (stack.length) {
    const i = stack.pop()!;
    if (keep[i] || cls[i] !== 'pitLane') continue;
    keep[i] = 1;
    const x = i % w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (i >= w) stack.push(i - w);
    if (i < w * (h - 1)) stack.push(i + w);
  }
  for (let i = 0; i < w * h; i++) if (cls[i] === 'pitLane' && !keep[i]) cls[i] = 'asphalt';
}

// 7. Pit boxes from hints (can't be told apart by colour).
for (const r of hints.pitBoxes ?? [])
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (at(x, y) === 'pitLane') cls[y * w + x] = 'pitBox';

// 8. Write.
const png = new PNG({ width: w, height: h });
const counts: Record<string, number> = {};
for (let i = 0; i < w * h; i++) {
  const c = colorOf[cls[i]!]!;
  png.data[i * 4] = c[0]; png.data[i * 4 + 1] = c[1]; png.data[i * 4 + 2] = c[2]; png.data[i * 4 + 3] = 255;
  counts[cls[i]!] = (counts[cls[i]!] ?? 0) + 1;
}
writeFileSync(out, PNG.sync.write(png));
console.log(`wrote ${out} (${w}x${h})`);
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(12)} ${((100 * v) / (w * h)).toFixed(1)}%`);
if ((counts.outOfBounds ?? 0) / (w * h) > 0.5) console.warn('WARNING: out-of-bounds fill covers over half the image; a wall line probably has a gap.');
