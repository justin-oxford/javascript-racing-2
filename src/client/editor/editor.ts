// Track editor, dev only (?edit=1). Lines and points only: timing lines, racing line, grid, spawn.
// Edits the TrackJson object in place, so the running game sees changes immediately
// (e.g. R uses the new spawn). Unknown keys are untouched, so export is lossless.
import type { Point, Pose, TimingLine, TrackJson } from '../../sim';
import { drawPose, drawRacingLine, drawTimingLine, TIMING_COLORS } from '../debug-draw';
import type { Renderer } from '../render';
import { formatTrackJson } from './format';

type TimingKey = keyof TrackJson['timingLines'];
type Tool = 'select' | 'racing' | 'grid' | 'spawn' | TimingKey;

type Handle =
  | { kind: 'racing'; i: number }
  | { kind: 'grid'; i: number }
  | { kind: 'spawn' }
  | { kind: 'timing'; key: TimingKey; end: 'a' | 'b' };

const HIT_CSS_PX = 9;
const ROTATE_STEP = Math.PI / 36; // 5 degrees per Q/E press
const round = (n: number): number => Math.round(n * 2) / 2; // half-pixel precision

export class TrackEditor {
  maskOpacity = 0.35;
  private tool: Tool = 'select';
  private selected: Handle | undefined;
  private drag: { handle: Handle; aim: boolean } | undefined;
  private readonly panel: HTMLElement;
  private readonly status: HTMLElement;
  private readonly headingInput: HTMLInputElement;

  constructor(private readonly renderer: Renderer, private readonly json: TrackJson) {
    this.panel = this.buildPanel();
    this.status = this.panel.querySelector('[data-status]')!;
    this.headingInput = this.panel.querySelector('[data-heading]')!;
    document.body.appendChild(this.panel);

    const c = renderer.canvas;
    c.style.cursor = 'crosshair';
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', () => (this.drag = undefined));
    window.addEventListener('keydown', (e) => this.onKey(e));
    this.refresh();
  }

  // ---- export -------------------------------------------------------------

  exportText(): string {
    return formatTrackJson(this.json);
  }

  private async save(): Promise<void> {
    const res = await fetch(`/__editor/save-track/${this.json.id}`, { method: 'POST', body: this.exportText() });
    this.setStatus(res.ok ? `Saved tracks/${this.json.id}/track.json` : `Save failed: ${await res.text()}`);
  }

  private download(): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([this.exportText()], { type: 'application/json' }));
    a.download = 'track.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---- drawing ------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D, lw: number): void {
    const j = this.json;
    drawRacingLine(ctx, j.racingLine, lw);
    ctx.save();
    j.racingLine.forEach((p, i) => {
      const sel = this.isSelected({ kind: 'racing', i });
      ctx.fillStyle = sel ? '#fff' : '#00e5ff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, (sel ? 4 : 2.5) * lw, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
    for (const key of Object.keys(j.timingLines) as TimingKey[]) {
      const line = j.timingLines[key];
      drawTimingLine(ctx, line, TIMING_COLORS[key] ?? '#fff', key === 'startFinish' ? 'S/F' : key.toUpperCase(), lw);
      for (const end of ['a', 'b'] as const) this.dot(ctx, line[end], lw, this.isSelected({ kind: 'timing', key, end }), TIMING_COLORS[key] ?? '#fff');
    }
    j.grid.forEach((g, i) => drawPose(ctx, g, this.isSelected({ kind: 'grid', i }) ? '#ffee00' : '#ffffff', String(i + 1), lw));
    drawPose(ctx, j.spawn, this.isSelected({ kind: 'spawn' }) ? '#ffee00' : '#39ff14', 'R', lw);
  }

  private dot(ctx: CanvasRenderingContext2D, p: Point, lw: number, selected: boolean, color: string): void {
    ctx.save();
    ctx.fillStyle = selected ? '#fff' : color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(p.x, p.y, (selected ? 5 : 3.5) * lw, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ---- input --------------------------------------------------------------

  private onDown(e: PointerEvent): void {
    const p = this.renderer.toTrack(e);
    const tol = HIT_CSS_PX * this.renderer.trackPxPerCssPx();
    const j = this.json;
    const hit = this.hitTest(p, tol);

    if (this.tool === 'select' || (hit && this.tool !== 'spawn' && !this.isTimingTool(this.tool))) {
      this.selected = hit;
      if (hit) this.drag = { handle: hit, aim: e.shiftKey && (hit.kind === 'grid' || hit.kind === 'spawn') };
    } else if (this.tool === 'racing') {
      const seg = this.nearestSegment(p, tol);
      const pt = { x: round(p.x), y: round(p.y) };
      const i = seg === undefined ? j.racingLine.length : seg + 1;
      j.racingLine.splice(i, 0, pt);
      this.selected = { kind: 'racing', i };
      this.drag = { handle: this.selected, aim: false };
    } else if (this.tool === 'grid') {
      const heading = j.grid.at(-1)?.heading ?? j.spawn.heading;
      j.grid.push({ x: round(p.x), y: round(p.y), heading });
      this.selected = { kind: 'grid', i: j.grid.length - 1 };
      this.drag = { handle: this.selected, aim: false };
    } else if (this.tool === 'spawn') {
      j.spawn.x = round(p.x);
      j.spawn.y = round(p.y);
      this.selected = { kind: 'spawn' };
      this.drag = { handle: this.selected, aim: false };
    } else if (this.isTimingTool(this.tool)) {
      const line = j.timingLines[this.tool];
      line.a = { x: round(p.x), y: round(p.y) };
      line.b = { x: round(p.x), y: round(p.y) };
      this.selected = { kind: 'timing', key: this.tool, end: 'b' };
      this.drag = { handle: this.selected, aim: false };
    }
    this.refresh();
  }

  private onMove(e: PointerEvent): void {
    if (!this.drag) return;
    const p = this.renderer.toTrack(e);
    const h = this.drag.handle;
    if (this.drag.aim && (h.kind === 'grid' || h.kind === 'spawn')) {
      const pose = this.pose(h)!;
      // heading 0 = up, clockwise positive
      pose.heading = normalize(Math.atan2(p.x - pose.x, -(p.y - pose.y)));
    } else {
      const target = this.point(h);
      target.x = round(p.x);
      target.y = round(p.y);
    }
    this.refresh();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    const pose = this.selected && this.pose(this.selected);
    if ((e.code === 'Delete' || e.code === 'Backspace') && this.selected) {
      e.preventDefault();
      this.deleteSelected();
    } else if (pose && (e.code === 'KeyQ' || e.code === 'KeyE')) {
      pose.heading = normalize(pose.heading + (e.code === 'KeyE' ? ROTATE_STEP : -ROTATE_STEP));
      this.refresh();
    } else if (e.code === 'Escape') {
      this.selected = undefined;
      this.refresh();
    }
  }

  private deleteSelected(): void {
    const s = this.selected;
    if (s?.kind === 'racing') {
      if (this.json.racingLine.length <= 3) return this.setStatus('A racing line needs at least 3 points');
      this.json.racingLine.splice(s.i, 1);
    } else if (s?.kind === 'grid') {
      this.json.grid.splice(s.i, 1);
    } else {
      return this.setStatus('Spawn and timing lines can be moved, not deleted');
    }
    this.selected = undefined;
    this.refresh();
  }

  // ---- geometry helpers ---------------------------------------------------

  private isTimingTool(t: Tool): t is TimingKey {
    return t in this.json.timingLines;
  }

  private point(h: Handle): Point {
    const j = this.json;
    switch (h.kind) {
      case 'racing': return j.racingLine[h.i]!;
      case 'grid': return j.grid[h.i]!;
      case 'spawn': return j.spawn;
      case 'timing': return j.timingLines[h.key][h.end];
    }
  }

  private pose(h: Handle): Pose | undefined {
    if (h.kind === 'grid') return this.json.grid[h.i];
    if (h.kind === 'spawn') return this.json.spawn;
    return undefined;
  }

  private hitTest(p: Point, tol: number): Handle | undefined {
    const j = this.json;
    const cands: Handle[] = [
      { kind: 'spawn' },
      ...j.grid.map((_, i) => ({ kind: 'grid', i }) as const),
      ...(Object.keys(j.timingLines) as TimingKey[]).flatMap((key) => [
        { kind: 'timing', key, end: 'a' } as const,
        { kind: 'timing', key, end: 'b' } as const,
      ]),
      ...j.racingLine.map((_, i) => ({ kind: 'racing', i }) as const),
    ];
    let best: Handle | undefined, bestD = tol;
    for (const h of cands) {
      const q = this.point(h);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d <= bestD) { bestD = d; best = h; }
    }
    return best;
  }

  /** Index i of the racing-line segment (i -> i+1, wrapping) nearest p, if within tol. */
  private nearestSegment(p: Point, tol: number): number | undefined {
    const pts = this.json.racingLine;
    let best: number | undefined, bestD = tol;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      const d = distToSegment(p, a, b);
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }

  private isSelected(h: Handle): boolean {
    return JSON.stringify(h) === JSON.stringify(this.selected);
  }

  // ---- panel --------------------------------------------------------------

  private buildPanel(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'editor-panel';
    const tools: Array<[Tool, string]> = [
      ['select', 'Select / move'],
      ['racing', 'Racing line +'],
      ['grid', 'Grid slot +'],
      ['spawn', 'Spawn (R)'],
      ['startFinish', 'Start/finish line'],
      ['s1', 'Sector 1 line'],
      ['s2', 'Sector 2 line'],
    ];
    el.innerHTML = `
      <h2>Track editor · ${escapeHtml(this.json.name)}</h2>
      <div class="tools">${tools.map(([t, label]) => `<button data-tool="${t}">${label}</button>`).join('')}</div>
      <label>Mask overlay <input type="range" min="0" max="1" step="0.05" value="${this.maskOpacity}" data-opacity></label>
      <div class="selection">
        <span data-selected>Nothing selected</span>
        <label>Heading° <input type="number" step="1" data-heading disabled></label>
        <button data-flip disabled>Flip direction</button>
        <button data-delete disabled>Delete</button>
      </div>
      <div class="actions">
        <button data-save>Save to disk</button>
        <button data-download>Download</button>
        <button data-copy>Copy JSON</button>
      </div>
      <p class="help">Click a tool, then click/drag on the track. Timing lines: drag from end <b>a</b> to <b>b</b>; the arrow is the valid crossing direction.
      Racing line: click near a segment to insert, elsewhere to append. Shift-drag a grid slot or spawn to aim it; Q/E rotate 5°. Delete removes. Esc deselects.</p>
      <p class="status" data-status></p>`;
    el.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
      b.addEventListener('click', () => {
        this.tool = b.dataset.tool as Tool;
        this.refresh();
      }),
    );
    el.querySelector<HTMLInputElement>('[data-opacity]')!.addEventListener('input', (e) => {
      this.maskOpacity = Number((e.target as HTMLInputElement).value);
    });
    el.querySelector<HTMLInputElement>('[data-heading]')!.addEventListener('change', (e) => {
      const pose = this.selected && this.pose(this.selected);
      if (!pose) return;
      pose.heading = normalize((Number((e.target as HTMLInputElement).value) * Math.PI) / 180);
      this.refresh();
    });
    el.querySelector('[data-flip]')!.addEventListener('click', () => {
      if (this.selected?.kind !== 'timing') return;
      const line: TimingLine = this.json.timingLines[this.selected.key];
      [line.a, line.b] = [line.b, line.a];
      this.refresh();
    });
    el.querySelector('[data-delete]')!.addEventListener('click', () => this.deleteSelected());
    el.querySelector('[data-save]')!.addEventListener('click', () => void this.save());
    el.querySelector('[data-download]')!.addEventListener('click', () => this.download());
    el.querySelector('[data-copy]')!.addEventListener('click', () =>
      void navigator.clipboard.writeText(this.exportText()).then(() => this.setStatus('Copied track.json')),
    );
    return el;
  }

  private refresh(): void {
    this.panel.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === this.tool));
    const s = this.selected;
    const pose = s && this.pose(s);
    const label = !s ? 'Nothing selected'
      : s.kind === 'racing' ? `Racing point ${s.i + 1}/${this.json.racingLine.length}`
      : s.kind === 'grid' ? `Grid slot ${s.i + 1}`
      : s.kind === 'spawn' ? 'Spawn'
      : `${s.key} end ${s.end}`;
    const p = s && this.point(s);
    this.panel.querySelector('[data-selected]')!.textContent = p ? `${label} (${p.x}, ${p.y})` : label;
    this.headingInput.disabled = !pose;
    if (pose && document.activeElement !== this.headingInput) this.headingInput.value = ((pose.heading * 180) / Math.PI).toFixed(1);
    if (!pose) this.headingInput.value = '';
    this.panel.querySelector<HTMLButtonElement>('[data-flip]')!.disabled = s?.kind !== 'timing';
    this.panel.querySelector<HTMLButtonElement>('[data-delete]')!.disabled = !(s?.kind === 'racing' || s?.kind === 'grid');
  }

  private setStatus(msg: string): void {
    this.status.textContent = msg;
  }
}

function normalize(a: number): number {
  const t = a % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

