// Local player profiles (Main menu + profiles card, Phase A): several per browser, picked on the main menu.
// Each holds a name (and the 3-letter code the ticker and labels show), helmet colour, preferred team, the
// session choices and settings, and keybinds. Pure logic over a key-value store, so it tests in Node.
// Phase B (server accounts) keys laps on a server profile id instead; these local ones never upload.
import { completeKeybinds, type Keybinds } from './keybinds';

export interface ProfileSettings {
  ai: { count: number; preset: string };
  perf: 'team' | 'equal';
  damage: 'off' | 'visual' | 'realistic';
  labels: 'off' | 'position' | 'name';
  vfx: 'high' | 'low' | 'off';
  race: { laps: number; grid: 'random' | 'pole' | 'back' };
  /** Night race (Night races card), when the track has night art. */
  night: boolean;
  /** Car spec class (C1..C3); absent = the default car's. */
  spec?: string | undefined;
  /** Audio bus -> volume 0..1 (only the ones changed). */
  volumes: Record<string, number>;
}

export interface Profile {
  id: string;
  name: string;
  /** CSS colour. */
  helmet: string;
  /** Preferred team id ('' = the default car). */
  team: string;
  settings: ProfileSettings;
  keybinds: Keybinds;
}

export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export const NAME_MAX = 16;
export const DEFAULT_SETTINGS: Readonly<ProfileSettings> = Object.freeze<ProfileSettings>({
  ai: { count: 0, preset: '' },
  perf: 'team',
  damage: 'off',
  labels: 'position',
  vfx: 'high',
  race: { laps: 5, grid: 'random' },
  night: false,
  volumes: {},
});

/** Card 09's name rules: trimmed, inner whitespace collapsed, 16 characters max (by code point, so emoji and accents don't split). */
export function cleanName(raw: string): string {
  return Array.from(raw.trim().replace(/\s+/g, ' ')).slice(0, NAME_MAX).join('').trim();
}

/** Three letters for the ticker and car labels: the first letters of the name ("Justin Oxford" -> JUS), any script. */
export function nameCode(name: string): string {
  const letters = Array.from(name.normalize('NFD').replace(/\p{M}/gu, '')).filter((ch) => /\p{L}/u.test(ch));
  const code = letters.slice(0, 3).join('').toUpperCase();
  return code.length === 3 ? code : (code + 'XXX').slice(0, 3);
}

const LIST = 'jr2.profiles';
const ACTIVE = 'jr2.profile';

function completeSettings(raw: unknown): ProfileSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<ProfileSettings>;
  const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
  return {
    ai: { count: Number.isFinite(s.ai?.count) ? Math.max(0, Math.min(9, Math.round(s.ai!.count))) : 0, preset: typeof s.ai?.preset === 'string' ? s.ai.preset : '' },
    perf: pick(s.perf, ['team', 'equal'] as const, 'team'),
    damage: pick(s.damage, ['off', 'visual', 'realistic'] as const, 'off'),
    labels: pick(s.labels, ['off', 'position', 'name'] as const, 'position'),
    vfx: pick(s.vfx, ['high', 'low', 'off'] as const, 'high'),
    race: { laps: Number.isFinite(s.race?.laps) ? Math.max(1, Math.min(99, Math.round(s.race!.laps))) : 5, grid: pick(s.race?.grid, ['random', 'pole', 'back'] as const, 'random') },
    spec: typeof s.spec === 'string' && s.spec ? s.spec : undefined,
    night: s.night === true,
    volumes: s.volumes && typeof s.volumes === 'object' ? Object.fromEntries(Object.entries(s.volumes).filter(([, v]) => typeof v === 'number' && v >= 0 && v <= 1)) : {},
  };
}

/** A complete, valid profile from anything (stored JSON, an import): defaults fill the gaps. */
export function completeProfile(raw: unknown, id: string): Profile {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<Profile>;
  const name = cleanName(typeof p.name === 'string' ? p.name : '') || 'Player';
  return {
    id,
    name,
    helmet: typeof p.helmet === 'string' && /^#[0-9a-f]{6}$/i.test(p.helmet) ? p.helmet : '#f2c230',
    team: typeof p.team === 'string' ? p.team : '',
    settings: completeSettings(p.settings),
    keybinds: completeKeybinds(p.keybinds),
  };
}

export class ProfileStore {
  constructor(private readonly kv: KeyValueStore, private readonly newId: () => string) {}

  list(): Profile[] {
    let raw: unknown;
    try { raw = JSON.parse(this.kv.getItem(LIST) ?? '[]'); } catch { raw = []; }
    return (Array.isArray(raw) ? raw : []).map((p: { id?: unknown }) => completeProfile(p, typeof p?.id === 'string' ? p.id : this.newId()));
  }

  /** The profile in use; the first one made (seeded from `seed`) if there are none yet. */
  active(seed?: Partial<Profile>): Profile {
    const all = this.list();
    const id = this.kv.getItem(ACTIVE);
    const found = all.find((p) => p.id === id) ?? all[0];
    if (found) return found;
    // The first profile keeps the pre-profile PBs (see pbPrefix).
    const first = completeProfile({ ...seed }, 'default');
    this.write([first]);
    this.kv.setItem(ACTIVE, first.id);
    return first;
  }

  setActive(id: string): Profile | undefined {
    const p = this.list().find((q) => q.id === id);
    if (p) this.kv.setItem(ACTIVE, id);
    return p;
  }

  save(p: Profile): Profile {
    const clean = completeProfile(p, p.id);
    const all = this.list();
    const i = all.findIndex((q) => q.id === clean.id);
    if (i >= 0) all[i] = clean; else all.push(clean);
    this.write(all);
    return clean;
  }

  create(name: string, from?: Profile): Profile {
    const p = completeProfile({ ...(from ? { settings: from.settings, keybinds: from.keybinds, helmet: from.helmet, team: from.team } : {}), name }, this.newId());
    this.save(p);
    this.kv.setItem(ACTIVE, p.id);
    return p;
  }

  /** Remove a profile (never the last one). Returns the active profile afterwards. */
  remove(id: string): Profile {
    const all = this.list();
    if (all.length > 1) this.write(all.filter((p) => p.id !== id));
    if (this.kv.getItem(ACTIVE) === id) this.kv.setItem(ACTIVE, this.list()[0]!.id);
    return this.active();
  }

  /** A profile as a JSON file's text (backup, move browsers). */
  exportJson(p: Profile): string {
    const { id: _id, ...rest } = p;
    return JSON.stringify({ format: 'jr2-profile', version: 1, profile: rest }, null, 2);
  }

  /** Import a profile file as a NEW profile (never overwrites one); throws on something that isn't one. */
  importJson(text: string): Profile {
    const data = JSON.parse(text) as { format?: string; profile?: unknown };
    if (data?.format !== 'jr2-profile' || !data.profile) throw new Error('not a profile file');
    const p = completeProfile(data.profile, this.newId());
    this.save(p);
    this.kv.setItem(ACTIVE, p.id);
    return p;
  }

  private write(all: Profile[]): void {
    this.kv.setItem(LIST, JSON.stringify(all));
  }
}

/** Storage prefix for a profile's own data (local PBs): the first profile keeps the old, unprefixed keys. */
export const pbPrefix = (p: Pick<Profile, 'id'>): string => (p.id === 'default' ? '' : `p.${p.id}.`);

/** A key-value store with every key prefixed (one profile's PBs). */
export function prefixedStore(kv: KeyValueStore, prefix: string): KeyValueStore {
  return { getItem: (k) => kv.getItem(prefix + k), setItem: (k, v) => kv.setItem(prefix + k, v) };
}
