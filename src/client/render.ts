import type { CarState, Pose, WorldState } from '../sim';

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Interpolate heading along the shortest arc. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

/** Sim pose between two ticks, in METRES. */
export function interpolatePose(prev: CarState | undefined, curr: CarState, alpha: number): Pose {
  if (!prev) return curr;
  return {
    x: lerp(prev.x, curr.x, alpha),
    y: lerp(prev.y, curr.y, alpha),
    heading: lerpAngle(prev.heading, curr.heading, alpha),
  };
}

export interface DrawLayers {
  /** Above the background, below cars (mask overlay). Track-pixel space. */
  underCars?: (ctx: CanvasRenderingContext2D) => void;
  /** Above cars (overhead layer). Track-pixel space. */
  overCars?: (ctx: CanvasRenderingContext2D) => void;
  /** Topmost (debug + editor). Track-pixel space. */
  overlay?: (ctx: CanvasRenderingContext2D) => void;
  /** Screen-space text box, top-left. */
  text?: string | undefined;
  /** Push the text box down this many backing pixels (below the HUD bar). */
  textTop?: number;
}

export interface CarLook {
  /** Track pixels per metre: the sim is in metres, the canvas in track pixels. */
  pxPerMeter: number;
  lengthM: number;
  widthM: number;
  sprite(car: CarState): CanvasImageSource | undefined;
}

/**
 * Canvas whose drawing space is the track's pixel space (e.g. 2560x1440),
 * displayed fitted to the window at the track's aspect ratio, rendered at devicePixelRatio.
 */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 1;
  /** Background art, or the blockout canvas while a track has no art. */
  background: CanvasImageSource;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly trackWidth: number,
    readonly trackHeight: number,
    background: CanvasImageSource,
  ) {
    this.background = background;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas not supported');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // Fires when the window moves between screens with different DPR.
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => this.resize(), { once: true });
  }

  resize(): void {
    const aspect = this.trackWidth / this.trackHeight;
    let cssW = window.innerWidth;
    let cssH = cssW / aspect;
    if (cssH > window.innerHeight) {
      cssH = window.innerHeight;
      cssW = cssH * aspect;
    }
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.scale = this.canvas.width / this.trackWidth;
  }

  /** Mouse event -> track pixel coordinates. */
  toTrack(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * this.trackWidth, y: ((e.clientY - r.top) / r.height) * this.trackHeight };
  }

  /** How many track pixels one CSS pixel covers (for hit-testing and line widths). */
  trackPxPerCssPx(): number {
    return this.trackWidth / this.canvas.getBoundingClientRect().width;
  }

  draw(prev: WorldState, curr: WorldState, alpha: number, look: CarLook, layers: DrawLayers = {}): void {
    const { ctx } = this;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.background, 0, 0, this.trackWidth, this.trackHeight);
    layers.underCars?.(ctx);

    const ppm = look.pxPerMeter;
    const w = look.widthM * ppm, l = look.lengthM * ppm;
    curr.cars.forEach((car, i) => {
      const c = interpolatePose(prev.cars[i], car, alpha);
      ctx.save();
      ctx.translate(c.x * ppm, c.y * ppm);
      ctx.rotate(c.heading);
      const sprite = look.sprite(car);
      if (sprite) ctx.drawImage(sprite, -w / 2, -l / 2, w, l);
      else {
        ctx.fillStyle = '#e8e8e8';
        ctx.fillRect(-w / 2, -l / 2, w, l);
      }
      ctx.restore();
    });

    layers.overCars?.(ctx);
    layers.overlay?.(ctx);

    if (layers.text) {
      ctx.setTransform(1, 0, 0, 1, 0, layers.textTop ?? 0);
      const px = Math.round(12 * (window.devicePixelRatio || 1));
      ctx.font = `${px}px monospace`;
      ctx.textBaseline = 'top';
      const lines = layers.text.split('\n');
      const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + px;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(0, 0, width, (lines.length + 0.5) * px * 1.25);
      ctx.fillStyle = '#fff';
      lines.forEach((line, i) => ctx.fillText(line, px / 2, px / 4 + i * px * 1.25));
    }
  }
}
