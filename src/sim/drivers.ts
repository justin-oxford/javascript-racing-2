// AI driver roster (AI driver roster card): named drivers with stats, assigned to the AI cars by seed.
// Stats 0-100, 50 = average. They vary the difficulty preset per driver (the preset sets the overall level):
//   pace         corner and braking margins, by up to +-spread (ai.json skill.spread)
//   consistency  mistakes and steering noise (fewer, less)
//   tyres        tyre management: traction control holds less rear slip (less wear, a touch slower out)
//   aggression   how eagerly it attacks / hard it defends / late it concedes (AI overtaking card)
//   racecraft    judgement in traffic: when a move is on, leaving space (AI overtaking card)
import type { AiPreset } from './ai';

export interface DriverStats { pace: number; aggression: number; racecraft: number; consistency: number; tyres: number }
export interface DriverDef extends DriverStats { code: string; name: string }

/** A seeded shuffle of the roster; the first `count` drive. Same seed = same line-up. */
export function assignDrivers(roster: readonly DriverDef[], count: number, seed: number): DriverDef[] {
  const order = roster.map((_, i) => i);
  let s = seed >>> 0 || 1;
  for (let i = order.length - 1; i > 0; i--) {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    const j = Math.floor(r * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return Array.from({ length: count }, (_, k) => roster[order[k % order.length]!]!);
}

const centred = (stat: number) => Math.max(-1, Math.min(1, (stat - 50) / 50));

/** The difficulty preset as this driver drives it. No driver = the preset unchanged. */
export function driverPreset(p: AiPreset, d: DriverStats | undefined, spread: number): AiPreset {
  if (!d) return p;
  const pace = centred(d.pace) * spread, cons = centred(d.consistency);
  return {
    ...p,
    cornerMargin: Math.min(1, p.cornerMargin * (1 + pace)),
    brakeMargin: Math.min(1, p.brakeMargin * (1 + pace)),
    mistakesPerMin: Math.max(0, p.mistakesPerMin * (1 - 0.8 * cons)),
    noise: Math.max(0, p.noise * (1 - 0.6 * cons)),
    aggression: d.aggression / 100,
    racecraft: d.racecraft / 100,
    tyreCare: d.tyres / 100,
  };
}
