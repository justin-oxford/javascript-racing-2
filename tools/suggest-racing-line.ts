// Suggest a racing line: start from the track's centre path, then smooth it like a stretched elastic band
// (each point pulled toward its neighbours' midpoint), which cuts toward apexes, while keeping every point
// at least `margin` from the edge of the racing surface (asphalt + kerb). A seed for the AI (card 05);
// Justin can drag points in the editor.
// Usage: npm run suggest-racing-line -- <id> [--write] [--spacing 40] [--margin-m 2.2] [--iterations 400]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatTrackJson } from '../src/client/editor/format.ts';
import type { Point, TrackJson } from '../src/sim/index.ts';
import { lapGeometry } from './lap-distance.ts';
import { loadTrackNode, surfaces, TRACKS_DIR } from './load-track-node.ts';

const args = process.argv.slice(2);
const id = args[0];
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
if (!id) {
  console.error('usage: npm run suggest-racing-line -- <id> [--write] [--spacing px] [--margin-m m] [--iterations n]');
  process.exit(1);
}
const { track } = loadTrackNode(id);
const { width: w, height: h, data } = track.mask;
const ppm = track.json.pxPerMeter;
const spacing = opt('spacing', 40);
const margin = opt('margin-m', 2.2) * ppm; // car half-width + a little
const iterations = opt('iterations', 400);

// Distance (px) from every racing-surface pixel to the nearest non-racing pixel (chamfer 3-4).
const racing = new Set(['asphalt', 'kerb'].map((s) => surfaces.findIndex((x) => x.id === s)));
const edge = new Float32Array(w * h);
for (let i = 0; i < w * h; i++) edge[i] = racing.has(data[i]!) ? 1e9 : 0;
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!edge[i]) continue;
    let v = edge[i]!;
    if (x > 0) v = Math.min(v, edge[i - 1]! + 1);
    if (y > 0) {
      v = Math.min(v, edge[i - w]! + 1);
      if (x > 0) v = Math.min(v, edge[i - w - 1]! + 1.414);
      if (x < w - 1) v = Math.min(v, edge[i - w + 1]! + 1.414);
    }
    edge[i] = v;
  }
for (let y = h - 1; y >= 0; y--)
  for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!edge[i]) continue;
    let v = edge[i]!;
    if (x < w - 1) v = Math.min(v, edge[i + 1]! + 1);
    if (y < h - 1) {
      v = Math.min(v, edge[i + w]! + 1);
      if (x < w - 1) v = Math.min(v, edge[i + w + 1]! + 1.414);
      if (x > 0) v = Math.min(v, edge[i + w - 1]! + 1.414);
    }
    edge[i] = v;
  }
const edgeAt = (p: Point) => {
  const x = Math.round(p.x), y = Math.round(p.y);
  return x < 0 || y < 0 || x >= w || y >= h ? 0 : edge[y * w + x]!;
};
/** Step a point uphill on the edge distance until it's `margin` inside (or can't get further). */
function keepInside(p: Point): Point {
  let q = p;
  for (let k = 0; k < 40 && edgeAt(q) < margin; k++) {
    const gx = edgeAt({ x: q.x + 1, y: q.y }) - edgeAt({ x: q.x - 1, y: q.y });
    const gy = edgeAt({ x: q.x, y: q.y + 1 }) - edgeAt({ x: q.x, y: q.y - 1 });
    const g = Math.hypot(gx, gy);
    if (!g) break;
    q = { x: q.x + gx / g, y: q.y + gy / g };
  }
  return q;
}

const geo = lapGeometry(track);
let pts: Point[] = [];
for (let d = 0; d < geo.lap - spacing / 2; d += spacing) pts.push(geo.centreAt(d));
const n = pts.length;

// Elastic band: pull toward neighbours' midpoint, then push back inside the margin. Re-space every
// so often so points don't bunch up on the inside of corners.
const resample = (p: Point[]): Point[] => {
  const cum = [0];
  for (let i = 1; i <= p.length; i++) cum.push(cum[i - 1]! + Math.hypot(p[i % p.length]!.x - p[i - 1]!.x, p[i % p.length]!.y - p[i - 1]!.y));
  const total = cum[p.length]!, out: Point[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (total * k) / n;
    while (cum[j + 1]! < s) j++;
    const a = p[j]!, b = p[(j + 1) % p.length]!, f = (s - cum[j]!) / (cum[j + 1]! - cum[j]! || 1);
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  }
  return out;
};
// Phase 1: a few plain (Laplacian) passes to get off the centre and settle.
// Phase 2: bi-Laplacian smoothing, which minimises curvature rather than length: it opens corners up
// (outside -> apex -> outside) instead of hugging the inside.
const step = (fn: (i: number) => Point) => { pts = pts.map((_, i) => keepInside(fn(i))); };
const at = (i: number) => pts[((i % n) + n) % n]!;
for (let it = 0; it < 40; it++)
  step((i) => { const p = at(i), a = at(i - 1), b = at(i + 1); return { x: p.x + 0.5 * ((a.x + b.x) / 2 - p.x), y: p.y + 0.5 * ((a.y + b.y) / 2 - p.y) }; });
for (let it = 0; it < iterations * 5; it++) {
  step((i) => {
    const p = at(i), a = at(i - 1), b = at(i + 1), aa = at(i - 2), bb = at(i + 2);
    // -(p[i-2] - 4p[i-1] + 6p[i] - 4p[i+1] + p[i+2]) / 6 : moves each point to reduce the change in curvature
    return {
      x: p.x - (0.08 * (aa.x - 4 * a.x + 6 * p.x - 4 * b.x + bb.x)) ,
      y: p.y - (0.08 * (aa.y - 4 * a.y + 6 * p.y - 4 * b.y + bb.y)),
    };
  });
  if (it % 50 === 49) pts = resample(pts).map(keepInside);
}

// Report: length, tightest radius, minimum clearance.
let length = 0, minR = Infinity, minEdge = Infinity;
for (let i = 0; i < n; i++) {
  const a = pts[(i - 1 + n) % n]!, p = pts[i]!, b = pts[(i + 1) % n]!;
  length += Math.hypot(b.x - p.x, b.y - p.y);
  const ax = p.x - a.x, ay = p.y - a.y, bx = b.x - p.x, by = b.y - p.y;
  const cross = ax * by - ay * bx, la = Math.hypot(ax, ay), lb = Math.hypot(bx, by), lc = Math.hypot(b.x - a.x, b.y - a.y);
  const r = Math.abs(cross) > 1e-9 ? (la * lb * lc) / (2 * Math.abs(cross)) : Infinity;
  minR = Math.min(minR, r);
  minEdge = Math.min(minEdge, edgeAt(p));
}
const round = (v: number) => Math.round(v * 2) / 2;
const line = pts.map((p) => ({ x: round(p.x), y: round(p.y) }));
console.log(`${id}: racing line ${n} points, ${(length / ppm).toFixed(0)} m (centre path ${(geo.lap / ppm).toFixed(0)} m shortest-inside),` +
  ` tightest radius ${(minR / ppm).toFixed(1)} m, min clearance to edge ${(minEdge / ppm).toFixed(2)} m (margin ${(margin / ppm).toFixed(1)} m)`);

if (args.includes('--write')) {
  const path = join(TRACKS_DIR, id, 'track.json');
  const json = JSON.parse(readFileSync(path, 'utf8')) as TrackJson;
  json.racingLine = line;
  writeFileSync(path, formatTrackJson(json));
  console.log(`  written to tracks/${id}/track.json`);
}
