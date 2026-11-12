// Car labels (toggle with L or the menu): a small tag above each car with its race position, or its
// position + team code. Drawn on the dynamic canvas in track space but sized in CSS pixels, upright
// whatever way the car points. Reads world state only.
import type { WorldState } from '../../sim';
import { interpolatePose } from '../render';
import type { OrderEntry } from './running-order';

export type LabelMode = 'off' | 'position' | 'name';
export const LABEL_MODES: readonly LabelMode[] = ['off', 'position', 'name'];

export function nextLabelMode(m: LabelMode): LabelMode {
  return LABEL_MODES[(LABEL_MODES.indexOf(m) + 1) % LABEL_MODES.length]!;
}

/**
 * `order`: the running order (empty in practice: then 'position' shows nothing, 'name' shows codes).
 * `codes`: per car, for practice. `lw`: track px per CSS px. `liftPx`: how far above the car's centre, track px.
 */
export function drawCarLabels(
  c: CanvasRenderingContext2D,
  prev: WorldState,
  curr: WorldState,
  alpha: number,
  mode: LabelMode,
  order: readonly OrderEntry[],
  codes: readonly { code: string; swatch: string }[],
  ppm: number,
  lw: number,
  liftPx: number,
): void {
  if (mode === 'off') return;
  const byCar = new Map(order.map((e) => [e.car, e]));
  const fontPx = 10 * lw;
  c.save();
  c.font = `${fontPx}px "Formula1 Bold", system-ui, sans-serif`;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  curr.cars.forEach((car, i) => {
    const e = byCar.get(i);
    if (!e && (mode === 'position' || !codes[i])) return;
    const pos = e ? String(e.pos) : '';
    const code = mode === 'name' ? (e?.code ?? codes[i]!.code) : '';
    const swatch = e?.swatch ?? codes[i]?.swatch ?? '#888';
    const me = i === 0;
    const p = interpolatePose(prev.cars[i], car, alpha);
    const pad = 3 * lw, gap = 3 * lw, stripe = 3 * lw, h = 13 * lw;
    const wPos = pos ? c.measureText(pos).width : 0;
    const wCode = code ? c.measureText(code).width : 0;
    const w = stripe + pad + wPos + (pos && code ? gap : 0) + wCode + pad;
    const x = p.x * ppm - w / 2, y = p.y * ppm - liftPx - h;
    c.globalAlpha = 0.9;
    c.fillStyle = me ? '#e63946' : 'rgba(20, 20, 20, 0.85)';
    c.beginPath();
    c.roundRect(x, y, w, h, 2 * lw);
    c.fill();
    c.fillStyle = swatch;
    c.fillRect(x, y, stripe, h);
    c.globalAlpha = 1;
    let tx = x + stripe + pad;
    c.fillStyle = '#f1faee';
    if (pos) { c.fillText(pos, tx, y + h / 2 + 0.5 * lw); tx += wPos + gap; }
    if (code) { c.globalAlpha = 0.8; c.fillText(code, tx, y + h / 2 + 0.5 * lw); }
  });
  c.restore();
}
