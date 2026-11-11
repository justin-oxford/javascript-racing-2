// Tyre VFX: skid marks, rubber, smoke, dust, stones, sparks. Client only: reads sim state after each
// tick, never feeds anything back. Particles are a fixed pool (struct of arrays); at the cap new ones
// are dropped, never the frame.
import type { CarState, PhysicsConfig, SimTrack, WorldState } from '../../sim';
import { wheelPositions } from '../../sim';
import { wheelFx, type VfxConfig } from './triggers';

export type VfxQuality = 'off' | 'low' | 'high';
const QUALITY_KEY = 'jsr.vfxQuality';

export function loadQuality(): VfxQuality {
  try {
    const q = localStorage.getItem(QUALITY_KEY);
    if (q === 'off' || q === 'low' || q === 'high') return q;
  } catch {
    // storage blocked: fall through to the default
  }
  return 'high';
}
function saveQuality(q: VfxQuality): void {
  try {
    localStorage.setItem(QUALITY_KEY, q);
  } catch {
    // not persisted; fine
  }
}

const enum Kind { Smoke, Grass, Gravel, Stone, Spark }
const COLOURS = ['220,220,220', '96,112,58', '186,166,116', '92,84,72', '255,196,80'];

export class Vfx {
  quality: VfxQuality = loadQuality();
  readonly skid: HTMLCanvasElement;
  readonly rubber: HTMLCanvasElement;
  private readonly skidCtx: CanvasRenderingContext2D;
  private readonly rubberCtx: CanvasRenderingContext2D;
  // Particle pool, struct of arrays. Positions/velocities in metres.
  private readonly cap: number;
  private readonly px: Float32Array; private readonly py: Float32Array;
  private readonly vx: Float32Array; private readonly vy: Float32Array;
  private readonly age: Float32Array; private readonly life: Float32Array;
  private readonly size: Float32Array; private readonly grow: Float32Array;
  private readonly alpha: Float32Array; private readonly kind: Uint8Array;
  private count = 0;
  /** Fractional emissions carried between ticks, per car x wheel x kind. */
  private carry = new Map<string, number>();
  dropped = 0;

  constructor(width: number, height: number, private readonly cfg: VfxConfig) {
    const make = () => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      return c;
    };
    this.skid = make();
    this.rubber = make();
    this.skidCtx = this.skid.getContext('2d')!;
    this.rubberCtx = this.rubber.getContext('2d')!;
    for (const c of [this.skidCtx, this.rubberCtx]) c.lineCap = 'round';
    this.cap = cfg.maxParticles;
    const f = () => new Float32Array(this.cap);
    this.px = f(); this.py = f(); this.vx = f(); this.vy = f(); this.age = f(); this.life = f();
    this.size = f(); this.grow = f(); this.alpha = f();
    this.kind = new Uint8Array(this.cap);
  }

  setQuality(q: VfxQuality): void {
    this.quality = q;
    saveQuality(q);
    if (q === 'off') this.count = 0;
  }

  cycleQuality(): VfxQuality {
    this.setQuality(this.quality === 'high' ? 'low' : this.quality === 'low' ? 'off' : 'high');
    return this.quality;
  }

  /** Green track: wipe marks and rubber (new session). */
  clear(): void {
    this.skidCtx.clearRect(0, 0, this.skid.width, this.skid.height);
    this.rubberCtx.clearRect(0, 0, this.rubber.width, this.rubber.height);
    this.count = 0;
  }

  get particles(): number {
    return this.count;
  }

  private emit(k: Kind, x: number, y: number, vx: number, vy: number, life: number, size: number, grow: number, alpha: number): void {
    if (this.count >= this.cap * (this.quality === 'low' ? 0.35 : 1)) {
      this.dropped++;
      return;
    }
    const i = this.count++;
    this.px[i] = x; this.py[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.age[i] = 0; this.life[i] = life; this.size[i] = size; this.grow[i] = grow; this.alpha[i] = alpha; this.kind[i] = k;
  }

  /** How many to emit this tick for a rate, carrying the fraction to the next tick. */
  private howMany(key: string, perSec: number): number {
    const scale = this.quality === 'low' ? 0.4 : 1;
    const v = (this.carry.get(key) ?? 0) + (perSec * scale) / 60;
    const n = Math.floor(v);
    this.carry.set(key, v - n);
    return n;
  }

  /** After each sim tick: marks, rubber and particle emission from what every wheel is doing. */
  onTick(prev: WorldState, curr: WorldState, track: SimTrack, physics: PhysicsConfig): void {
    if (this.quality === 'off') return;
    const ppm = track.json.pxPerMeter;
    const c = this.cfg;
    curr.cars.forEach((car, ci) => {
      const before = prev.cars[ci];
      if (!before) return;
      // A teleport (R, out-of-bounds reset) isn't a skid.
      if (Math.hypot(car.x - before.x, car.y - before.y) > 4) return;
      const p0 = wheelPositions(before, physics), p1 = wheelPositions(car, physics);
      for (const w of [0, 1, 2, 3] as const) {
        const fx = wheelFx(before, car, w, c, track.surfaces);
        const a = p0[w], b = p1[w];
        // Rubber: faint stamps that only build up where tyres are loaded.
        if (fx.rubber > 0 && this.quality === 'high') this.line(this.rubberCtx, a, b, ppm, c.skid.widthM, `rgba(18,18,18,${fx.rubber})`);
        // Skid marks.
        if (fx.mark > c.skid.minIntensity) {
          const dark = fx.lockup > 0 ? c.skid.lockupDarkness : 1;
          this.line(this.skidCtx, a, b, ppm, c.skid.widthM * (fx.lockup > 0 ? 1.1 : 1), `rgba(12,12,12,${Math.min(1, c.skid.alpha * fx.mark * dark)})`);
        }
        // Torn turf on grass.
        if (fx.offTrack === 'grass') this.line(this.skidCtx, a, b, ppm, c.skid.widthM * 1.2, `rgba(70,52,28,${c.dust.turfAlpha * fx.offIntensity})`);
        this.emitWheel(ci, w, car, b, fx);
      }
      this.emitSparks(ci, car, track, physics);
    });
  }

  private line(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, ppm: number, widthM: number, style: string): void {
    ctx.strokeStyle = style;
    ctx.lineWidth = widthM * ppm;
    ctx.beginPath();
    ctx.moveTo(a.x * ppm, a.y * ppm);
    ctx.lineTo(b.x * ppm, b.y * ppm);
    ctx.stroke();
  }

  private emitWheel(ci: number, w: number, car: CarState, at: { x: number; y: number }, fx: ReturnType<typeof wheelFx>): void {
    const s = this.cfg.smoke, d = this.cfg.dust;
    const rnd = () => (Math.random() - 0.5) * 2;
    const smokeRate = s.ratePerSec * fx.mark * (fx.lockup > 0 ? s.lockupBurst : 1) * (fx.spin > 0 ? 1.5 : 1);
    for (let n = this.howMany(`${ci}:${w}:s`, smokeRate); n > 0; n--)
      this.emit(Kind.Smoke, at.x, at.y, car.vx * s.drift + rnd() * s.spreadMps, car.vy * s.drift + rnd() * s.spreadMps,
        s.lifetimeSec * (0.7 + Math.random() * 0.6), s.sizeM * (0.6 + Math.random() * 0.5), s.growthPerSec, s.opacity);
    if (!fx.offTrack) return;
    const gravel = fx.offTrack === 'gravel';
    const rate = (gravel ? d.gravelRate : d.grassRate) * fx.offIntensity;
    for (let n = this.howMany(`${ci}:${w}:d`, rate); n > 0; n--)
      this.emit(gravel ? Kind.Gravel : Kind.Grass, at.x, at.y, car.vx * 0.15 + rnd() * 1.5, car.vy * 0.15 + rnd() * 1.5,
        d.lifetimeSec * (0.7 + Math.random() * 0.6), d.sizeM * (0.6 + Math.random() * 0.6), 1.6, d.opacity);
    if (gravel && this.quality === 'high')
      for (let n = this.howMany(`${ci}:${w}:g`, d.stonesPerSec * fx.offIntensity); n > 0; n--)
        // Stones fly backward off the tyre.
        this.emit(Kind.Stone, at.x, at.y, -car.vx * 0.25 + rnd() * 3, -car.vy * 0.25 + rnd() * 3, 0.35 + Math.random() * 0.3, 0.12, 0, 1);
  }

  /** Wall/barrier contact at speed: short streaks at the car corner touching the wall. */
  private emitSparks(ci: number, car: CarState, track: SimTrack, physics: PhysicsConfig): void {
    const sp = this.cfg.sparks;
    if (!(car.wallContact || car.barrierContact) || Math.abs(car.speed) * 3.6 < sp.minKph) return;
    const ppm = track.json.pxPerMeter;
    const f = { x: Math.sin(car.heading), y: -Math.cos(car.heading) }, r = { x: Math.cos(car.heading), y: Math.sin(car.heading) };
    const L = physics.car.lengthM / 2, W = physics.car.widthM / 2;
    // Pick the corner whose outward neighbour is wall; else the front corner on the side we're sliding.
    let best = { x: car.x + f.x * L, y: car.y + f.y * L };
    for (const [l, s] of [[L, -W], [L, W], [-L, -W], [-L, W]] as const) {
      const cx = car.x + f.x * l + r.x * s, cy = car.y + f.y * l + r.y * s;
      const ox = cx + (f.x * Math.sign(l) + r.x * Math.sign(s)) * 0.4, oy = cy + (f.y * Math.sign(l) + r.y * Math.sign(s)) * 0.4;
      const surf = track.mask.data[Math.floor(oy * ppm) * track.mask.width + Math.floor(ox * ppm)];
      if (surf === track.index.wall || surf === track.index.tyreBarrier) { best = { x: cx, y: cy }; break; }
    }
    const v = Math.hypot(car.vx, car.vy) || 1;
    for (let n = this.howMany(`${ci}:sp`, sp.perSec); n > 0; n--) {
      const k = sp.speedMps * (0.5 + Math.random());
      this.emit(Kind.Spark, best.x, best.y, (car.vx / v) * k + (Math.random() - 0.5) * 6, (car.vy / v) * k + (Math.random() - 0.5) * 6, sp.lifetimeSec * (0.5 + Math.random()), 0.08, 0, 1);
    }
  }

  /** Advance particles by real frame time (they're cosmetic; no fixed step needed). */
  update(dt: number): void {
    let i = 0;
    while (i < this.count) {
      this.age[i]! += dt;
      if (this.age[i]! >= this.life[i]!) {
        // Swap-remove with the last live particle.
        const last = --this.count;
        this.px[i] = this.px[last]!; this.py[i] = this.py[last]!; this.vx[i] = this.vx[last]!; this.vy[i] = this.vy[last]!;
        this.age[i] = this.age[last]!; this.life[i] = this.life[last]!; this.size[i] = this.size[last]!;
        this.grow[i] = this.grow[last]!; this.alpha[i] = this.alpha[last]!; this.kind[i] = this.kind[last]!;
        continue;
      }
      const drag = this.kind[i] === Kind.Spark || this.kind[i] === Kind.Stone ? 0.5 : 2.5;
      this.vx[i]! *= Math.max(0, 1 - drag * dt);
      this.vy[i]! *= Math.max(0, 1 - drag * dt);
      this.px[i]! += this.vx[i]! * dt;
      this.py[i]! += this.vy[i]! * dt;
      this.size[i]! += this.grow[i]! * dt;
      i++;
    }
  }

  /** Marks and rubber: above the background, below cars. */
  drawUnder(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.quality === 'off') return;
    const l = this.cfg.layers;
    ctx.save();
    ctx.globalAlpha = l.rubberOpacity;
    ctx.drawImage(this.rubber, 0, 0, w, h);
    ctx.globalAlpha = l.skidOpacity;
    ctx.drawImage(this.skid, 0, 0, w, h);
    ctx.restore();
  }

  /** Smoke, dust, stones, sparks: above cars. */
  drawOver(ctx: CanvasRenderingContext2D, ppm: number): void {
    if (this.quality === 'off' || !this.count) return;
    ctx.save();
    for (let i = 0; i < this.count; i++) {
      const t = this.age[i]! / this.life[i]!;
      const k = this.kind[i]!;
      const x = this.px[i]! * ppm, y = this.py[i]! * ppm;
      if (k === Kind.Spark) {
        ctx.strokeStyle = `rgba(${COLOURS[k]},${1 - t})`;
        ctx.lineWidth = 0.12 * ppm;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - this.vx[i]! * 0.03 * ppm, y - this.vy[i]! * 0.03 * ppm);
        ctx.stroke();
        continue;
      }
      // Puffs fade in fast, then out.
      const a = this.alpha[i]! * Math.min(1, t * 6) * (1 - t);
      ctx.fillStyle = `rgba(${COLOURS[k]},${a})`;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.05, this.size[i]!) * ppm * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
