// URL switches for testing (2026-11-15): override config for this page load only, never saved.
//   ?brain=rules|lookahead   ai.brain
//   ?scale=0|1               ai.scale.oxford.enabled
//   ?dirty=<percent>         slipstream.dirtyAir.maxDownforceLoss (e.g. ?dirty=10 = 0.10)
//   ?watch=1                 the AI drives the player's car too (spectate)
//   ?race=<laps>             start a quick race at once (with ?ai=N for the field)
//   ?grid=reverse            that race's grid by pace, fastest car last (pace = each car's own planned lap)
// The active ones show in a badge in the HUD's corner, so screenshots carry them.

export interface UrlSwitches {
  brain?: 'rules' | 'lookahead';
  scale?: boolean;
  /** Fraction (0.05 for ?dirty=5). */
  dirty?: number;
  watch: boolean;
  race?: number;
  grid?: 'reverse';
}

export function parseSwitches(search: string): UrlSwitches {
  const p = new URLSearchParams(search);
  const out: UrlSwitches = { watch: p.get('watch') === '1' };
  const brain = p.get('brain');
  if (brain === 'rules' || brain === 'lookahead') out.brain = brain;
  const scale = p.get('scale');
  if (scale === '0' || scale === '1') out.scale = scale === '1';
  const dirty = p.get('dirty');
  if (dirty !== null && dirty.trim() !== '' && Number.isFinite(Number(dirty))) out.dirty = Math.max(0, Math.min(100, Number(dirty))) / 100;
  const race = Number(p.get('race'));
  if (p.has('race') && Number.isFinite(race) && race >= 1) out.race = Math.min(100, Math.round(race));
  if (p.get('grid') === 'reverse') out.grid = 'reverse';
  return out;
}

interface AiLike { brain?: string; scale?: { oxford?: { enabled?: boolean } } }
interface SlipLike { dirtyAir: { maxDownforceLoss: number } }

/** Apply the config switches in place (the page's live config objects). */
export function applySwitches(sw: UrlSwitches, ai: AiLike, slip: SlipLike): void {
  if (sw.brain) ai.brain = sw.brain;
  if (sw.scale !== undefined && ai.scale?.oxford) ai.scale.oxford.enabled = sw.scale;
  if (sw.dirty !== undefined) slip.dirtyAir.maxDownforceLoss = sw.dirty;
}

/** The badge text: the switches given, plus what's running ("brain rules · scale 1 · dirty 5%"). */
export function switchLabel(sw: UrlSwitches, ai: AiLike, slip: SlipLike): string {
  const given = sw.brain !== undefined || sw.scale !== undefined || sw.dirty !== undefined || sw.watch || sw.race !== undefined || sw.grid !== undefined;
  if (!given) return '';
  const pct = Math.round(slip.dirtyAir.maxDownforceLoss * 1000) / 10;
  const parts = [`brain ${ai.brain ?? 'rules'}`, `scale ${ai.scale?.oxford?.enabled ? 1 : 0}`, `dirty ${pct}%`];
  if (sw.watch) parts.push('watch');
  if (sw.race !== undefined) parts.push(`race ${sw.race} laps`);
  if (sw.grid) parts.push('grid reverse');
  return parts.join(' · ');
}

/** Grid by pace, fastest last: order[slot] = car, sorted by planned lap time, slowest first. */
export function reverseGridOrder(lapTimes: readonly number[]): number[] {
  return lapTimes.map((_, i) => i).sort((a, b) => lapTimes[b]! - lapTimes[a]! || a - b);
}

export function showSwitchBadge(text: string): void {
  if (!text) return;
  const el = document.createElement('div');
  el.id = 'url-switches';
  el.textContent = text;
  el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:50;padding:3px 8px;border-radius:4px;background:rgba(0,0,0,0.65);color:#ffe600;font:12px/1.4 monospace;pointer-events:none;';
  document.body.appendChild(el);
}
