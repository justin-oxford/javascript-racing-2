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
  // A jump (reset to track, back to pits): draw it where it is now, don't slide it across the track.
  if ((curr.x - prev.x) ** 2 + (curr.y - prev.y) ** 2 > 10 * 10) return curr;
  return {
    x: lerp(prev.x, curr.x, alpha),
    y: lerp(prev.y, curr.y, alpha),
    heading: lerpAngle(prev.heading, curr.heading, alpha),
  };
}

export interface DrawLayers {
  /** On the dynamic layer, below cars (debug mask, line flash). Track-pixel space. */
  underCars?: (ctx: CanvasRenderingContext2D) => void;
  /** On the dynamic layer, above cars (smoke, dust, sparks). Track-pixel space. */
  overCars?: (ctx: CanvasRenderingContext2D) => void;
  /** On the dynamic layer, topmost (debug + editor). Track-pixel space. */
  overlay?: (ctx: CanvasRenderingContext2D) => void;
  /** Night: drawn after the night tint, with additive blending (rear lights). Track-pixel space. */
  lights?: (ctx: CanvasRenderingContext2D) => void;
  /** Screen-space text box, top-left. */
  text?: string | undefined;
  /** Push the text box down this many backing pixels (below the HUD bar). */
  textTop?: number;
}

export interface CarLook {
  /** Track pixels per metre: the sim is in metres, the canvas in track pixels. */
  pxPerMeter: number;
  lengthM: number;
  /** The body (sprite) centre is this far ahead of the car's position (its CG), metres. */
  bodyOffsetM: number;
  widthM: number;
  /** Draw car `index` with ctx at its centre, rotated to its heading (track pixels). false = not drawn. */
  drawCar(ctx: CanvasRenderingContext2D, car: CarState, index: number, lengthPx: number, devicePerTrackPx: number): boolean;
}

/**
 * Three stacked canvases, all in the track's pixel space (e.g. 2560x1440), fitted to the window at the
 * track's aspect ratio and rendered at devicePixelRatio:
 *
 *   overhead  (top)    bridges/canopy, pre-scaled once; pointer-events off
 *   dynamic   (middle) the `canvas` passed in: cleared and redrawn every frame (cars, smoke, overlays)
 *   static    (bottom) background + timing lines + rubber + skid marks
 *
 * PERFORMANCE: drawing big track-sized images every frame is what made the game lag (each 2560x1440
 * layer cost ~15 ms/frame to scale down, and even 1:1 screen-sized copies cost several ms each).
 * Now the browser's compositor layers the canvases for free; each frame only touches the small
 * moving things. The static layer is rebuilt only when something moves (resize, editor line drag,
 * hot reload, marks cleared); new skid marks are painted straight into it.
 */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 1;
  private bg: CanvasImageSource;
  private readonly staticCanvas = document.createElement('canvas');
  private readonly staticCtx: CanvasRenderingContext2D;
  private staticDirty = true;
  /** Draws timing lines, marks history etc. onto the static layer during a rebuild (track px space). */
  staticPainter: ((ctx: CanvasRenderingContext2D) => void) | undefined;
  private overheadImg: CanvasImageSource | undefined;
  private readonly overheadCanvas = document.createElement('canvas');
  private overheadDirty = true;
  /** Night tint (track-size RGBA: ambient colour, alpha = how dark), pre-scaled to the device like the overhead. */
  private shadeImg: CanvasImageSource | undefined;
  private readonly shadeCanvas = document.createElement('canvas');
  private shadeDirty = true;
  /** Around each car (track px), where the night tint is applied: the car, its smoke and sparks. */
  shadeRegionPx = 100;
  rebuilds = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly trackWidth: number,
    readonly trackHeight: number,
    background: CanvasImageSource,
  ) {
    this.bg = background;
    this.staticCtx = this.staticCanvas.getContext('2d', { alpha: false })!;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas not supported');
    this.ctx = ctx;
    // Stack: static under the dynamic canvas, overhead above it.
    const stage = document.createElement('div');
    stage.className = 'stage';
    canvas.replaceWith(stage);
    this.staticCanvas.className = 'layer static';
    this.overheadCanvas.className = 'layer overhead';
    canvas.classList.add('layer', 'dynamic');
    stage.append(this.staticCanvas, canvas, this.overheadCanvas);
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
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    const stage = this.canvas.parentElement!;
    stage.style.width = `${cssW}px`;
    stage.style.height = `${cssH}px`;
    for (const c of [this.canvas, this.staticCanvas, this.overheadCanvas]) {
      c.style.width = `${cssW}px`;
      c.style.height = `${cssH}px`;
      c.width = w;
      c.height = h;
    }
    this.scale = w / this.trackWidth;
    this.staticDirty = true;
    this.overheadDirty = true;
    this.shadeDirty = true;
  }

  /** Night tint image (undefined = day). */
  set nightShade(img: CanvasImageSource | undefined) {
    this.shadeImg = img;
    this.shadeDirty = true;
    this.overheadDirty = true; // the overhead art (trees, bridges) is tinted once, at rebuild
  }
  get night(): boolean {
    return !!this.shadeImg;
  }

  /** Background art, or the blockout canvas while a track has no art. */
  get background(): CanvasImageSource {
    return this.bg;
  }
  set background(b: CanvasImageSource) {
    this.bg = b;
    this.invalidateStatic();
  }

  set overhead(img: CanvasImageSource | undefined) {
    this.overheadImg = img;
    this.overheadDirty = true;
  }

  /** Rebuild the static layer before the next frame (lines moved, marks cleared, hot reload...). */
  invalidateStatic(): void {
    this.staticDirty = true;
  }

  /** Paint straight onto the static layer (new skid marks), in track-pixel space. Skipped if a rebuild is due anyway. */
  paintStatic(fn: (ctx: CanvasRenderingContext2D) => void): void {
    if (this.staticDirty) return;
    const c = this.staticCtx;
    c.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    fn(c);
  }

  private rebuildStatic(): void {
    const c = this.staticCtx;
    c.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    c.globalAlpha = 1;
    c.imageSmoothingEnabled = true;
    c.drawImage(this.bg, 0, 0, this.trackWidth, this.trackHeight);
    this.staticPainter?.(c);
    this.staticDirty = false;
    this.rebuilds++;
  }

  private rebuildShade(): void {
    this.shadeDirty = false;
    const c = this.shadeCanvas;
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    if (this.shadeImg) g.drawImage(this.shadeImg, 0, 0, c.width, c.height);
  }

  private rebuildOverhead(): void {
    this.overheadDirty = false;
    const c = this.overheadCanvas.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.overheadCanvas.width, this.overheadCanvas.height);
    if (this.overheadImg) c.drawImage(this.overheadImg, 0, 0, this.overheadCanvas.width, this.overheadCanvas.height);
    // Night: the overhead layer is day art over the cars; tint it like them (only where it has pixels).
    if (this.overheadImg && this.shadeImg) {
      c.globalCompositeOperation = 'source-atop';
      c.drawImage(this.shadeImg, 0, 0, this.overheadCanvas.width, this.overheadCanvas.height);
      c.globalCompositeOperation = 'source-over';
    }
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
    if (this.staticDirty) this.rebuildStatic();
    if (this.overheadDirty) this.rebuildOverhead();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.imageSmoothingEnabled = true;
    layers.underCars?.(ctx);

    const ppm = look.pxPerMeter;
    const w = look.widthM * ppm, l = look.lengthM * ppm;
    curr.cars.forEach((car, i) => {
      const c = interpolatePose(prev.cars[i], car, alpha);
      ctx.save();
      ctx.translate(c.x * ppm, c.y * ppm);
      ctx.rotate(c.heading);
      ctx.translate(0, -look.bodyOffsetM * ppm); // heading 0 points up (-y): the body centre is ahead
      if (car.rejoin?.ghost) ctx.globalAlpha = 0.45; // just reset to track: ghosted until clear (no contact)
      if (!look.drawCar(ctx, car, i, l, this.scale)) {
        ctx.fillStyle = '#e8e8e8';
        ctx.fillRect(-w / 2, -l / 2, w, l);
      }
      ctx.restore();
    });

    layers.overCars?.(ctx);
    // NIGHT: tint what the game drew toward the ambient colour by the darkness at each spot ('source-atop':
    // only where something was drawn). One composite, clipped to the areas around the cars, not the screen.
    if (this.shadeImg) {
      if (this.shadeDirty) this.rebuildShade();
      ctx.save();
      ctx.beginPath();
      const r = this.shadeRegionPx;
      for (let i = 0; i < curr.cars.length; i++) {
        const c = interpolatePose(prev.cars[i], curr.cars[i]!, alpha);
        ctx.rect(c.x * ppm - r, c.y * ppm - r, 2 * r, 2 * r);
      }
      ctx.clip();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-atop';
      ctx.drawImage(this.shadeCanvas, 0, 0);
      ctx.restore();
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      layers.lights?.(ctx);
      ctx.restore();
    }
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
