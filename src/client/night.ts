// Night races (POLISH card): client-side lighting hooks for Justin's night art. No sim changes.
// - shadeImage(): the tint the renderer lays over everything the game draws (cars, smoke, sparks): the
//   ambient colour at alpha (1 - light) x darkness, light from the track's floodlight map (white = lit).
// - previewNight(): until real night art exists, ?night=preview fakes it from the day background and
//   floodlight pools along the racing line, so the look can be judged.
// - drawRearLights(): the red glow at each car's gearbox (after the tint, additive).
import type { CarState, Point, WorldState } from '../sim';
import { interpolatePose } from './render';

export interface NightConfig {
  ambient: string;
  darkness: number;
  regionM: number;
  rearLight: { color: string; radiusM: number; alpha: number; backM: number };
  preview: { darken: number; poolRadiusM: number; poolEveryM: number };
}

const canvas = (w: number, h: number): HTMLCanvasElement => Object.assign(document.createElement('canvas'), { width: w, height: h });

/** Track-size tint: ambient colour, alpha = (1 - lightmap) x darkness (lightmap: greyscale, white = lit). */
export function shadeImage(w: number, h: number, cfg: NightConfig, lightmap?: CanvasImageSource): HTMLCanvasElement {
  // Built at a quarter size and scaled up: the light falls off smoothly anyway, and it's 16x less work.
  const sw = Math.max(1, Math.round(w / 4)), sh = Math.max(1, Math.round(h / 4));
  const c = canvas(sw, sh), g = c.getContext('2d', { willReadFrequently: true })!;
  let light: Uint8ClampedArray | undefined;
  if (lightmap) {
    g.drawImage(lightmap, 0, 0, sw, sh);
    light = g.getImageData(0, 0, sw, sh).data;
  }
  g.fillStyle = cfg.ambient;
  g.fillRect(0, 0, 1, 1);
  const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
  const img = g.createImageData(sw, sh), d = img.data;
  for (let i = 0; i < sw * sh; i++) {
    const lit = light ? (light[i * 4]! + light[i * 4 + 1]! + light[i * 4 + 2]!) / (3 * 255) : 0;
    d[i * 4] = r!; d[i * 4 + 1] = gg!; d[i * 4 + 2] = b!;
    d[i * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, (1 - lit) * cfg.darkness)));
  }
  g.putImageData(img, 0, 0);
  const out = canvas(w, h);
  out.getContext('2d')!.drawImage(c, 0, 0, w, h);
  return out;
}

/** ?night=preview: the day art darkened and cooled, with floodlight pools every poolEveryM along the
 *  racing line where the day art shows through; and the matching lightmap (white = lit). */
export function previewNight(day: CanvasImageSource, w: number, h: number, line: readonly Point[], ppm: number, cfg: NightConfig): { background: HTMLCanvasElement; lightmap: HTMLCanvasElement } {
  const pools: Point[] = [];
  let run = Infinity;
  for (let i = 0; i < line.length; i++) {
    const a = line[i]!, b = line[(i + 1) % line.length]!;
    run += Math.hypot(b.x - a.x, b.y - a.y) / ppm;
    if (run >= cfg.preview.poolEveryM) { pools.push(a); run = 0; }
  }
  const r = cfg.preview.poolRadiusM * ppm;
  /** Radial pools: `inner` alpha at the centre fading to 0, in `rgb`. */
  const paintPools = (g: CanvasRenderingContext2D, rgb: string, inner: number) => {
    for (const p of pools) {
      const grad = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      grad.addColorStop(0, `rgba(${rgb}, ${inner})`);
      grad.addColorStop(0.55, `rgba(${rgb}, ${inner * 0.75})`);
      grad.addColorStop(1, `rgba(${rgb}, 0)`);
      g.fillStyle = grad;
      g.fillRect(p.x - r, p.y - r, 2 * r, 2 * r);
    }
  };
  const lightmap = canvas(w, h), lg = lightmap.getContext('2d')!;
  lg.fillStyle = '#000';
  lg.fillRect(0, 0, w, h);
  paintPools(lg, '255, 255, 255', 1);
  // Night painting: the day art multiplied down to a cool dark...
  const d = cfg.preview.darken;
  const background = canvas(w, h), bg = background.getContext('2d')!;
  bg.drawImage(day, 0, 0, w, h);
  bg.globalCompositeOperation = 'multiply';
  bg.fillStyle = `rgb(${Math.round(255 * d * 0.8)}, ${Math.round(255 * d * 0.9)}, ${Math.min(255, Math.round(255 * d * 1.3))})`;
  bg.fillRect(0, 0, w, h);
  // ...with the day art back in the floodlight pools (pool alpha as a mask over the day art).
  const pool = canvas(w, h), pg = pool.getContext('2d')!;
  paintPools(pg, '0, 0, 0', 0.85);
  pg.globalCompositeOperation = 'source-in';
  pg.drawImage(day, 0, 0, w, h);
  bg.globalCompositeOperation = 'source-over';
  bg.drawImage(pool, 0, 0);
  return { background, lightmap };
}

/** Red glow at each car's gearbox, additive (call with globalCompositeOperation 'lighter'). */
export function drawRearLights(c: CanvasRenderingContext2D, prev: WorldState, curr: WorldState, alpha: number, ppm: number, cfg: NightConfig): void {
  const rl = cfg.rearLight, r = rl.radiusM * ppm;
  curr.cars.forEach((car: CarState, i) => {
    const p = interpolatePose(prev.cars[i], car, alpha);
    // Behind the CG along the heading (heading 0 = up = -y).
    const x = (p.x - Math.sin(p.heading) * rl.backM) * ppm, y = (p.y + Math.cos(p.heading) * rl.backM) * ppm;
    const grad = c.createRadialGradient(x, y, 0, x, y, r);
    const a = rl.alpha * (car.controls.brake > 0.1 ? 1 : 0.6); // brighter under braking
    grad.addColorStop(0, `rgba(${rl.color}, ${a})`);
    grad.addColorStop(1, `rgba(${rl.color}, 0)`);
    c.fillStyle = grad;
    c.fillRect(x - r, y - r, 2 * r, 2 * r);
  });
}
