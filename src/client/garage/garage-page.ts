// The garage (Livery card, phase 2): ?garage=1. All 11 teams side by side on an asphalt swatch at game scale,
// the picked one at 4x; colour pickers (primary, secondary, accent, helmet), a livery PNG picker with live
// preview, the six stat sliders and the name. Edits apply to the live catalog at once (the cars on track
// change too). "Drive it" drops into practice in that car; "Export teams.json" downloads the file to commit;
// on the dev server "Save" writes config/teams.json and the livery PNG straight into the project.
import { STAT_NAMES, type CarCatalog, type PhysicsConfig, type TeamDef } from '../../sim';
import type { Liveries } from '../livery';
import './garage.css';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface GarageHooks {
  catalog: CarCatalog;
  liveries: Liveries;
  physics: PhysicsConfig;
  /** teams.json as loaded (for its _comment on export). */
  teamsFile: { _comment?: string };
  /** Drop into practice in this team's car. */
  onDrive(teamId: string): void;
}

export class GaragePage {
  private readonly root = document.createElement('div');
  private pick: TeamDef;
  /** Liveries picked this session (data URLs), for Save. */
  private readonly newLiveries = new Map<string, string>();
  private raf = 0;

  constructor(private readonly h: GarageHooks) {
    this.pick = h.catalog.teams[0]!;
    this.root.className = 'garage';
    document.body.appendChild(this.root);
    this.render();
    const loop = () => { this.drawPreview(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  close(): void {
    cancelAnimationFrame(this.raf);
    this.root.remove();
  }

  private render(): void {
    const t = this.pick, c = t.colors;
    const stat = (k: string) => (t.stats as unknown as Record<string, number>)[k] ?? 1;
    this.root.innerHTML = `
      <div class="g-head"><b>GARAGE</b> <span>Liveries and teams (Livery card, phase 2). Edits apply live; export or save to keep them.</span>
        <button data-act="close">CLOSE</button></div>
      <canvas class="g-row" data-id="row"></canvas>
      <div class="g-main">
        <canvas class="g-zoom" data-id="zoom"></canvas>
        <div class="g-form">
          <label>Team</label><select data-id="team">${this.h.catalog.teams.map((x) => `<option value="${x.id}"${x.id === t.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
          <label>Name</label><input data-f="name" value="${esc(t.name)}" maxlength="24" />
          <label>Primary</label><input type="color" data-c="primary" value="${c.primary}" />
          <label>Secondary</label><input type="color" data-c="secondary" value="${c.secondary}" />
          <label>Accent</label><input type="color" data-c="accent" value="${c.accent ?? '#ffffff'}" />
          <label>Helmet</label><input type="color" data-c="helmet" value="${c.helmet}" />
          <label>Livery PNG</label><div><input type="file" accept="image/png" data-id="livery" /> <button data-act="clearLivery">NONE</button>
            <small>${t.livery ? esc(t.livery) : this.newLiveries.has(t.id) ? 'new (unsaved)' : 'none'}: 256 x 512, drawn over the paint, under the shading; only where there's bodywork</small></div>
          ${STAT_NAMES.map((k) => `<label>${k}</label><div class="g-stat"><input type="range" min="0.5" max="1.5" step="0.01" data-s="${k}" value="${stat(k)}" /><b>${stat(k).toFixed(2)}</b></div>`).join('')}
          <div class="g-buttons"><button class="go" data-act="drive">DRIVE IT</button><button data-act="export">EXPORT teams.json</button>${import.meta.env.DEV ? '<button data-act="save">SAVE (dev)</button>' : ''}</div>
          <small class="g-msg" data-id="msg">Secondary and accent are stored for liveries; the template paints only the primary for now.</small>
        </div>
      </div>`;
    const $ = (sel: string) => this.root.querySelector(sel) as HTMLElement & HTMLInputElement & HTMLSelectElement;
    $('[data-id="team"]').addEventListener('change', (e) => { this.pick = this.h.catalog.teams.find((x) => x.id === (e.target as HTMLSelectElement).value)!; this.render(); });
    $('[data-f="name"]').addEventListener('input', (e) => { this.pick.name = (e.target as HTMLInputElement).value; });
    this.root.querySelectorAll<HTMLInputElement>('[data-c]').forEach((el) => el.addEventListener('input', () => { (this.pick.colors as Record<string, string>)[el.dataset.c!] = el.value; }));
    this.root.querySelectorAll<HTMLInputElement>('[data-s]').forEach((el) => el.addEventListener('input', () => {
      (this.pick.stats as unknown as Record<string, number>)[el.dataset.s!] = Number(el.value);
      el.nextElementSibling!.textContent = Number(el.value).toFixed(2);
    }));
    $('[data-id="livery"]').addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result), img = new Image();
        img.onload = () => { this.h.liveries.setLivery(this.pick.id, img); this.newLiveries.set(this.pick.id, url); const sm = (e.target as HTMLElement).parentElement?.querySelector('small'); if (sm) sm.textContent = 'new (unsaved): 256 x 512, drawn over the paint, under the shading; only where there is bodywork'; this.msg(`livery set for ${this.pick.name} (${img.width} x ${img.height})`); };
        img.src = url;
      };
      reader.readAsDataURL(file);
    });
    this.root.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).dataset.act;
      if (act === 'close') this.close();
      else if (act === 'clearLivery') { this.h.liveries.setLivery(this.pick.id, undefined); delete this.pick.livery; this.newLiveries.delete(this.pick.id); this.render(); }
      else if (act === 'drive') { const id = this.pick.id; this.close(); this.h.onDrive(id); }
      else if (act === 'export') this.export();
      else if (act === 'save') void this.save();
    });
  }

  private msg(text: string): void {
    const m = this.root.querySelector('[data-id="msg"]');
    if (m) m.textContent = text;
  }

  /** teams.json as it stands (liveries picked this session point where Save puts them). */
  private teamsJson(): string {
    const teams = this.h.catalog.teams.map((t) => ({ ...t, ...(this.newLiveries.has(t.id) ? { livery: `assets/Cars/liveries/${t.id}.png` } : {}) }));
    const comment = this.h.teamsFile._comment ?? '';
    return `{\n  "_comment": ${JSON.stringify(comment)},\n  "teams": [\n${teams.map((t) => `    ${JSON.stringify(t)}`).join(',\n')}\n  ]\n}\n`;
  }

  private export(): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([this.teamsJson()], { type: 'application/json' }));
    a.download = 'teams.json';
    a.click();
    URL.revokeObjectURL(a.href);
    this.msg(this.newLiveries.size ? `teams.json downloaded; put the new livery PNGs in public/assets/Cars/liveries/ (${[...this.newLiveries.keys()].join(', ')}.png)` : 'teams.json downloaded: replace config/teams.json and commit');
  }

  private async save(): Promise<void> {
    const post = (url: string, body: string) => fetch(url, { method: 'POST', headers: { 'x-garage': '1' }, body }).then((r) => (r.ok ? r.text() : r.text().then((t) => Promise.reject(new Error(t)))));
    try {
      for (const [id, url] of this.newLiveries) await post(`/__garage/livery/${id}`, url);
      await post('/__garage/teams', this.teamsJson());
      for (const id of this.newLiveries.keys()) { const t = this.h.catalog.teams.find((x) => x.id === id); if (t) t.livery = `assets/Cars/liveries/${id}.png`; }
      this.newLiveries.clear();
      this.msg('saved config/teams.json (and liveries)');
    } catch (e) { this.msg(`save failed: ${String(e)}`); }
  }

  /** The row of all teams at game scale, and the picked one at 4x, on asphalt. */
  private drawPreview(): void {
    const dpr = window.devicePixelRatio || 1;
    const row = this.root.querySelector('[data-id="row"]') as HTMLCanvasElement | null, zoom = this.root.querySelector('[data-id="zoom"]') as HTMLCanvasElement | null;
    if (!row || !zoom) return;
    const gameLen = 44; // on-screen CSS px for a car at game scale (about Oxford's)
    const teams = this.h.catalog.teams;
    const fit = (c: HTMLCanvasElement, w: number, h: number) => { if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = `${w}px`; c.style.height = `${h}px`; } };
    fit(row, teams.length * 40 + 20, gameLen + 24);
    fit(zoom, gameLen * 4 * 0.6, gameLen * 4 + 30);
    const paint = (c: HTMLCanvasElement, items: Array<{ t: TeamDef; x: number; y: number; len: number }>) => {
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#3b3c40';
      g.fillRect(0, 0, c.width, c.height);
      for (const it of items) {
        g.save();
        g.translate(it.x, it.y);
        this.h.liveries.draw(g, { steerAngle: 0 }, { primary: it.t.colors.primary, helmet: it.t.colors.helmet, team: it.t.id }, it.len, dpr, this.h.physics);
        g.restore();
      }
    };
    paint(row, teams.map((t, k) => ({ t, x: 30 + k * 40, y: gameLen / 2 + 12, len: gameLen })));
    paint(zoom, [{ t: this.pick, x: (gameLen * 4 * 0.6) / 2, y: gameLen * 2 + 15, len: gameLen * 4 }]);
    const rg = row.getContext('2d')!;
    rg.strokeStyle = '#ffd400';
    rg.lineWidth = 2;
    const k = teams.indexOf(this.pick);
    rg.strokeRect(30 + k * 40 - 18, 4, 36, gameLen + 16);
  }
}
