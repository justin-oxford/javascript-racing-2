// Contact split (AI overtaking round 4 / Car damage): car-to-car contacts as INCIDENTS between two cars, each
// classed by its peak closing speed along the contact normal (Planck pre-solve, the same number damage uses):
// a TAP / rub below the heavy-hit threshold (config/damage.json thresholdMps), a HEAVY HIT at or over it.
// One incident per pair of cars: it starts with their first touch and ends once they've been apart gapTicks,
// so a long scrape is one rub, not one contact per tick it re-touches. Wall and barrier hits are logged too.
// Use: const log = contactLog(ctx); after every step(): log.tick(world); at the end log.finish(), log.summary().
import type { SimContext, WorldState } from '../src/sim/index.ts';

/** at the peak: car b's position in car a's frame (lon ahead +, lat right +), both speeds (m/s), the angle between headings (deg). */
export interface Incident { a: number; b: number; startTick: number; peakMps: number; lon: number; lat: number; va: number; vb: number; angDeg: number }

export function contactLog(ctx: SimContext, thresholdMps = ctx.damage.thresholdMps, gapTicks = 15) {
  const open = new Map<number, { inc: Incident; last: number }>();
  const done: Incident[] = [];
  const wallPeaks: number[] = [];
  const wallOpen = new Map<number, { peak: number; last: number }>();
  const close = (key: number) => { done.push(open.get(key)!.inc); open.delete(key); };
  return {
    thresholdMps,
    incidents: done,
    wallPeaks,
    tick(w: WorldState) {
      const t = w.tick;
      for (const h of ctx.cache.hits) {
        if (h.kind !== 'car') {
          const o = wallOpen.get(h.car);
          if (o && t - o.last <= gapTicks) { o.peak = Math.max(o.peak, h.speed); o.last = t; }
          else { if (o) wallPeaks.push(o.peak); wallOpen.set(h.car, { peak: h.speed, last: t }); }
          continue;
        }
        // The other car: the nearest one to the contact point.
        let j = -1, bd = Infinity;
        w.cars.forEach((c, k) => { if (k === h.car) return; const d = Math.hypot(c.x - h.x, c.y - h.y); if (d < bd) { bd = d; j = k; } });
        if (j < 0) continue;
        const a = Math.min(h.car, j), b = Math.max(h.car, j), key = a * 1000 + b;
        const geo = () => {
          const A = w.cars[a]!, B = w.cars[b]!, fx = Math.sin(A.heading), fy = -Math.cos(A.heading);
          let ang = ((B.heading - A.heading) * 180) / Math.PI; ang = ((ang % 360) + 540) % 360 - 180;
          return { lon: (B.x - A.x) * fx + (B.y - A.y) * fy, lat: (B.x - A.x) * -fy + (B.y - A.y) * fx, va: Math.hypot(A.vx, A.vy), vb: Math.hypot(B.vx, B.vy), angDeg: ang };
        };
        const o = open.get(key);
        if (o) { if (h.speed > o.inc.peakMps) Object.assign(o.inc, { peakMps: h.speed }, geo()); o.last = t; }
        else open.set(key, { inc: { a, b, startTick: t, peakMps: h.speed, ...geo() }, last: t });
      }
      // Still touching (resting contact closes at 0, so it records no hit) keeps an incident open.
      for (const [key, o] of open) {
        if (w.cars[o.inc.a]!.carContact && w.cars[o.inc.b]!.carContact) o.last = t;
        else if (t - o.last > gapTicks) close(key);
      }
      for (const [car, o] of wallOpen) if (t - o.last > gapTicks) { wallPeaks.push(o.peak); wallOpen.delete(car); }
    },
    finish() {
      for (const key of [...open.keys()]) close(key);
      for (const [car, o] of wallOpen) { wallPeaks.push(o.peak); wallOpen.delete(car); }
    },
    get taps() { return done.filter((i) => i.peakMps < thresholdMps).length; },
    get heavy() { return done.filter((i) => i.peakMps >= thresholdMps).length; },
    summary() { return `contacts ${done.length}: taps ${this.taps}, heavy hits ${this.heavy} (>= ${thresholdMps} m/s closing)`; },
  };
}

/** Peak closing speeds bucketed (m/s), for picking the threshold. */
export function histogram(peaks: readonly number[], edges = [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 15]): string {
  const counts = new Array(edges.length + 1).fill(0) as number[];
  for (const p of peaks) { let k = edges.findIndex((e) => p < e); if (k < 0) k = edges.length; counts[k]!++; }
  return counts.map((c, k) => `${k === 0 ? '<' + edges[0] : k === edges.length ? '>=' + edges.at(-1) : edges[k - 1] + '-' + edges[k]}: ${c}`).join(', ');
}
