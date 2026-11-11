import type { CarState, WorldState } from '../sim';

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Interpolate heading along the shortest arc. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

function interpolateCar(prev: CarState | undefined, curr: CarState, alpha: number): CarState {
  if (!prev) return curr;
  return {
    x: lerp(prev.x, curr.x, alpha),
    y: lerp(prev.y, curr.y, alpha),
    heading: lerpAngle(prev.heading, curr.heading, alpha),
    speed: lerp(prev.speed, curr.speed, alpha),
  };
}

/**
 * Canvas whose drawing space is the track's pixel space (e.g. 1280x566),
 * displayed fitted to the window at the track's aspect ratio, rendered at devicePixelRatio.
 */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly trackWidth: number,
    private readonly trackHeight: number,
    private readonly background: HTMLImageElement,
    private readonly carSprite: HTMLImageElement,
  ) {
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

  draw(prev: WorldState, curr: WorldState, alpha: number, debugText?: string): void {
    const { ctx } = this;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.drawImage(this.background, 0, 0, this.trackWidth, this.trackHeight);

    const sw = this.carSprite.naturalWidth;
    const sh = this.carSprite.naturalHeight;
    curr.cars.forEach((car, i) => {
      const c = interpolateCar(prev.cars[i], car, alpha);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.heading);
      ctx.drawImage(this.carSprite, -sw / 2, -sh / 2, sw, sh);
      ctx.restore();
    });

    if (debugText) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const px = Math.round(12 * (window.devicePixelRatio || 1));
      ctx.font = `${px}px monospace`;
      ctx.textBaseline = 'top';
      const lines = debugText.split('\n');
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, px * 22, (lines.length + 0.5) * px * 1.25);
      ctx.fillStyle = '#fff';
      lines.forEach((l, i) => ctx.fillText(l, px / 2, px / 4 + i * px * 1.25));
    }
  }
}
