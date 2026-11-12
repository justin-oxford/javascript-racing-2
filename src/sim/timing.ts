// Lap and sector timing, in the sim so the server can time laps (card 07). Pure and plain data.
// Each tick the car's movement (previous -> current position) is swept against the next timing line
// it's due to cross, in the line's valid direction only. No minimum-time hacks: a line can't be
// skipped at speed, and reversing over a line (or re-crossing one) never counts.
import type { Point, TimingKey, TrackJson } from './track';

export interface LapTiming {
  /** Crossed start/finish at least once (the out-lap doesn't count). */
  started: boolean;
  /** Index into timingSequence() of the line due next. */
  next: number;
  /** Sim seconds when the current lap / sector began (sub-tick precise). */
  lapStart: number;
  sectorStart: number;
  /** Completed sector times of the current lap, seconds. */
  sectors: number[];
  lapInvalid: boolean;
  sectorInvalid: boolean;
  /** Completed laps (valid or not). */
  laps: number;
}

export type TimingEvent =
  | { type: 'sector'; car: number; sector: number; time: number; invalid: boolean }
  | { type: 'lap'; car: number; lap: number; time: number; sectors: number[]; invalid: boolean };

export function newTiming(): LapTiming {
  return { started: false, next: 0, lapStart: 0, sectorStart: 0, sectors: [], lapInvalid: false, sectorInvalid: false, laps: 0 };
}

/** Lines in driving order: S1, S2 (whichever exist), then start/finish. Empty if there's no start/finish. */
export function timingSequence(json: Pick<TrackJson, 'timingLines'>): TimingKey[] {
  const t = json.timingLines;
  if (!t.startFinish) return [];
  return [...(t.s1 ? (['s1'] as const) : []), ...(t.s2 ? (['s2'] as const) : []), 'startFinish'];
}

/**
 * Where (0..1 along p0->p1) the movement crosses line a->b from its left side to its right side
 * (the right-hand normal of a->b in screen coordinates, as the editor's arrow shows). undefined if
 * it doesn't cross, or crosses the wrong way. Same units for everything.
 */
export function crossing(p0: Point, p1: Point, a: Point, b: Point, reach = 0): number | undefined {
  const dx = b.x - a.x, dy = b.y - a.y;
  const side = (p: Point) => dx * (p.y - a.y) - dy * (p.x - a.x); // > 0: right-hand side
  const s0 = side(p0), s1 = side(p1);
  if (!(s0 < 0 && s1 >= 0)) return undefined;
  const t = s0 / (s0 - s1); // where the movement meets the line's infinite extension
  const x = p0.x + (p1.x - p0.x) * t, y = p0.y + (p1.y - p0.y) * t;
  const len2 = dx * dx + dy * dy;
  const u = ((x - a.x) * dx + (y - a.y) * dy) / len2; // and whether that's within the segment
  // reach: also count a crossing this far (same units) past either end, like a timing loop that spans
  // the run-off: a car running wide where a line ends at the track edge still gets timed.
  const ext = reach / Math.sqrt(len2);
  return u >= -ext && u <= 1 + ext ? t : undefined;
}

export interface TimingInput {
  /** Car centre before and after this tick, metres. */
  from: Point;
  to: Point;
  /** Sim seconds at `from` and `to`. */
  t0: number;
  t1: number;
  offTrack: boolean;
  barrierContact: boolean;
}

/** One tick of timing for one car. Returns the new timing; pushes sector/lap events. */
export function updateTiming(
  timing: LapTiming,
  inp: TimingInput,
  json: Pick<TrackJson, 'timingLines' | 'pxPerMeter'>,
  car: number,
  events: TimingEvent[],
  reachM = 0,
): LapTiming {
  const seq = timingSequence(json);
  if (!seq.length) return timing;
  let t = timing;
  // Track limits: all four wheels off, or touching a barrier, voids the current sector and lap.
  if (t.started && (inp.offTrack || inp.barrierContact) && !(t.sectorInvalid && t.lapInvalid)) t = { ...t, sectorInvalid: true, lapInvalid: true };

  const ppm = json.pxPerMeter;
  const lineCross = (key: TimingKey): number | undefined => {
    const l = json.timingLines[key]!;
    const f = crossing(inp.from, inp.to, { x: l.a.x / ppm, y: l.a.y / ppm }, { x: l.b.x / ppm, y: l.b.y / ppm }, reachM);
    return f === undefined ? undefined : inp.t0 + (inp.t1 - inp.t0) * f;
  };

  if (!t.started) {
    const at = lineCross('startFinish');
    if (at === undefined) return t;
    return { ...newTiming(), started: true, lapStart: at, sectorStart: at, laps: t.laps };
  }

  const key = seq[t.next]!;
  const at = lineCross(key);
  if (at === undefined) return t;
  const sectorTime = at - t.sectorStart;
  const sectors = [...t.sectors, sectorTime];
  events.push({ type: 'sector', car, sector: t.sectors.length, time: sectorTime, invalid: t.sectorInvalid });
  if (key !== 'startFinish') return { ...t, next: t.next + 1, sectorStart: at, sectors, sectorInvalid: false };
  events.push({ type: 'lap', car, lap: t.laps + 1, time: at - t.lapStart, sectors, invalid: t.lapInvalid });
  return { ...t, next: 0, lapStart: at, sectorStart: at, sectors: [], lapInvalid: false, sectorInvalid: false, laps: t.laps + 1 };
}
