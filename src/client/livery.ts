// Cars drawn from the template layers (livery card, phase 1).
// Draw order: generated soft drop shadow -> 4 tyres (fronts turned by the sim's wheel angle) ->
// body (bg_no_tyres) -> paint layer tinted to the team's primary -> shadows layer (minus helmet) ->
// helmet tinted per driver.
// Each team x helmet is composited ONCE at template size (256x512), then cached downscaled to its
// on-screen size x devicePixelRatio, stepping down in halves (scaling 256x512 to ~40 px every frame
// shimmers). Caches rebuild only when the on-screen size changes (zoom, resize, DPR).
import type { CarState, PhysicsConfig } from '../sim';
import liveryJson from '../../config/livery.json';

export type LiveryConfig = typeof liveryJson;

type Canvas = HTMLCanvasElement;
const canvas = (w: number, h: number): Canvas => Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) });
const c2d = (c: Canvas) => c.getContext('2d')!;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`livery: failed to load ${url}`));
    img.src = url;
  });
}

/** Downscale in halves, then one high-quality final step: crisp, no shimmer. */
function downscale(src: Canvas, w: number, h: number): Canvas {
  // (Never 0, negative or NaN: the halving below would never stop.)
  w = Math.max(1, Number.isFinite(w) ? w : 1); h = Math.max(1, Number.isFinite(h) ? h : 1);
  let cur = src;
  while (cur.width / 2 >= w * 1.0001 && cur.height / 2 >= h) {
    const half = canvas(cur.width / 2, cur.height / 2);
    const g = c2d(half);
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = canvas(w, h);
  const g = c2d(out);
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, out.width, out.height);
  return out;
}

export class Liveries {
  private body!: Canvas;
  private paint!: Canvas;
  /** Shadows layer with the helmet cut out, and the helmet alone as greyscale shading (alpha kept). */
  private shading!: Canvas;
  private helmetShade!: Canvas;
  private tyre!: Canvas;
  private dropShadow!: Canvas;
  /** Full-size composites by team colour + helmet colour (+ livery). */
  private readonly full = new Map<string, Canvas>();
  /** Livery card phase 2: a livery image per team (over the paint, under the shading), and a version so a
   *  new one (the garage) re-composites. */
  private readonly liveryImg = new Map<string, { img: CanvasImageSource; v: number }>();
  private liveryV = 0;
  /** Downscaled caches by key + device size. */
  private readonly sized = new Map<string, { size: number; canvas: Canvas }>();
  /** Template pixels from the car's centre (the sprite is centred on the car body). */
  private readonly cx: number;
  private readonly cy: number;
  private readonly carLenPx: number;
  helmetPixels = 0;

  constructor(private readonly cfg: LiveryConfig) {
    const t = cfg.template;
    this.cx = (t.carLeft + t.carRight + 1) / 2;
    this.cy = (t.carTop + t.carBottom + 1) / 2;
    this.carLenPx = t.carBottom - t.carTop + 1;
  }

  async load(siteUrl: (p: string) => string): Promise<this> {
    const f = this.cfg.files;
    const [body, paint, shadows, tyre] = await Promise.all([f.body, f.paint, f.shadows, f.tyre].map((p) => loadImage(siteUrl(p))));
    const toCanvas = (img: HTMLImageElement) => { const c = canvas(img.width, img.height); c2d(c).drawImage(img, 0, 0); return c; };
    this.body = toCanvas(body!);
    this.paint = toCanvas(paint!);
    this.tyre = toCanvas(tyre!);
    this.splitHelmet(toCanvas(shadows!));
    this.dropShadow = this.makeDropShadow();
    return this;
  }

  /** The helmet is the only coloured part of the shadows layer: move it to its own (tintable) layer. */
  private splitHelmet(shadows: Canvas): void {
    const { hueMin, hueMax, minChroma } = this.cfg.helmet;
    const g = c2d(shadows);
    const img = g.getImageData(0, 0, shadows.width, shadows.height);
    const helmet = new ImageData(shadows.width, shadows.height);
    const d = img.data, h = helmet.data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]!, gg = d[i + 1]!, b = d[i + 2]!, a = d[i + 3]!;
      if (a === 0) continue;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      if (mx - mn < minChroma) continue;
      let hue = mx === r ? ((gg - b) / (mx - mn)) * 60 : mx === gg ? (2 + (b - r) / (mx - mn)) * 60 : (4 + (r - gg) / (mx - mn)) * 60;
      if (hue < 0) hue += 360;
      if (hue < hueMin || hue > hueMax) continue;
      // Keep the shading (brightness), drop the pink: a white-to-black helmet, tinted later by multiply.
      h[i] = h[i + 1] = h[i + 2] = mx;
      h[i + 3] = a;
      d[i + 3] = 0;
      n++;
    }
    this.helmetPixels = n;
    g.putImageData(img, 0, 0);
    this.shading = shadows;
    this.helmetShade = canvas(shadows.width, shadows.height);
    c2d(this.helmetShade).putImageData(helmet, 0, 0);
  }

  /** Soft drop shadow from the car's silhouette (body + tyres), blurred. */
  private makeDropShadow(): Canvas {
    const { width: w, height: h } = this.cfg.template;
    const { offsetX, offsetY, blur, alpha } = this.cfg.shadow;
    const pad = blur * 3;
    const sil = canvas(w + pad * 2, h + pad * 2);
    const g = c2d(sil);
    for (const [x = 0, y = 0] of Object.values(this.cfg.template.tyres)) g.drawImage(this.tyre, pad + x - this.tyre.width / 2, pad + y - this.tyre.height / 2);
    g.drawImage(this.body, pad, pad);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = '#000';
    g.fillRect(0, 0, sil.width, sil.height);
    const out = canvas(sil.width, sil.height);
    const o = c2d(out);
    o.filter = `blur(${blur}px)`;
    o.globalAlpha = alpha;
    o.drawImage(sil, offsetX, offsetY);
    return out;
  }

  /** Set (or clear) a team's livery image; the next draw re-composites. */
  setLivery(teamId: string, img: CanvasImageSource | undefined): void {
    if (img) this.liveryImg.set(teamId, { img, v: ++this.liveryV });
    else this.liveryImg.delete(teamId);
  }

  /** Load each team's livery PNG (teams.json "livery"), if any; missing files are skipped with a warning. */
  async loadLiveries(teams: ReadonlyArray<{ id: string; livery?: string | undefined }>, siteUrl: (p: string) => string): Promise<void> {
    await Promise.all(teams.filter((t) => t.livery).map((t) => loadImage(siteUrl(t.livery!)).then((img) => this.setLivery(t.id, img), (e) => console.warn(String(e)))));
  }

  /** The car minus tyres and shadow, tinted: body, paint, livery, shading, helmet. */
  private composite(primary: string, helmet: string, livery?: { img: CanvasImageSource; v: number }): Canvas {
    const key = `${primary}|${helmet}|${livery?.v ?? 0}`;
    let c = this.full.get(key);
    if (c) return c;
    const { width: w, height: h } = this.cfg.template;
    const tint = (layer: Canvas, colour: string, mode: GlobalCompositeOperation) => {
      const t = canvas(w, h), g = c2d(t);
      g.drawImage(layer, 0, 0);
      g.globalCompositeOperation = mode;
      g.fillStyle = colour;
      g.fillRect(0, 0, w, h);
      if (mode === 'multiply') { g.globalCompositeOperation = 'destination-in'; g.drawImage(layer, 0, 0); }
      return t;
    };
    c = canvas(w, h);
    const g = c2d(c);
    g.drawImage(this.body, 0, 0);
    g.drawImage(tint(this.paint, primary, 'source-in'), 0, 0); // paint layer is pure white + alpha
    if (livery) {
      // The livery only where there's bodywork to paint (the paint layer's alpha).
      const l = canvas(w, h), lg = c2d(l);
      lg.drawImage(livery.img, 0, 0, w, h);
      lg.globalCompositeOperation = 'destination-in';
      lg.drawImage(this.paint, 0, 0);
      g.drawImage(l, 0, 0);
    }
    g.drawImage(this.shading, 0, 0);
    g.drawImage(tint(this.helmetShade, helmet, 'multiply'), 0, 0);
    this.full.set(key, c);
    return c;
  }

  private sizedCopy(key: string, src: Canvas, scale: number): Canvas {
    const size = Math.round(scale * 1000) / 1000;
    const hit = this.sized.get(key);
    if (hit && hit.size === size) return hit.canvas;
    const out = downscale(src, src.width * size, src.height * size);
    this.sized.set(key, { size, canvas: out });
    return out;
  }

  /**
   * Draw a car. ctx is already translated to the car's centre and rotated to its heading, in track
   * pixels; `lengthPx` is the car's length in track pixels; `devicePerTrackPx` = backing pixels per track pixel.
   */
  draw(ctx: CanvasRenderingContext2D, car: Pick<CarState, 'steerAngle'>, colours: { primary: string; helmet: string; team?: string }, lengthPx: number, devicePerTrackPx: number, physics: PhysicsConfig): void {
    const s = lengthPx / this.carLenPx; // track px per template px
    const dev = s * devicePerTrackPx; // backing px per template px
    const { width: w, height: h, tyres } = this.cfg.template;
    const pad = (this.dropShadow.width - w) / 2;

    const shadow = this.sizedCopy('shadow', this.dropShadow, dev);
    ctx.drawImage(shadow, (-this.cx - pad) * s, (-this.cy - pad) * s, this.dropShadow.width * s, this.dropShadow.height * s);

    const tyre = this.sizedCopy('tyre', this.tyre, dev);
    const tw = this.tyre.width * s, th = this.tyre.height * s;
    const steer = car.steerAngle;
    for (const [name, [x = 0, y = 0]] of Object.entries(tyres)) {
      const px = (x - this.cx) * s, py = (y - this.cy) * s;
      if (name === 'fl' || name === 'fr') {
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(steer);
        ctx.drawImage(tyre, -tw / 2, -th / 2, tw, th);
        ctx.restore();
      } else ctx.drawImage(tyre, px - tw / 2, py - th / 2, tw, th);
    }

    const liv = colours.team ? this.liveryImg.get(colours.team) : undefined;
    const key = `${colours.primary}|${colours.helmet}|${liv?.v ?? 0}`;
    const body = this.sizedCopy(key, this.composite(colours.primary, colours.helmet, liv), dev);
    ctx.drawImage(body, -this.cx * s, -this.cy * s, w * s, h * s);
  }
}
