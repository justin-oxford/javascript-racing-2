// AI look-ahead brain (trial card, behind ai.brain = "lookahead"). Every evalSec, a follower with a car ahead tries a
// handful of candidate moves ~horizonSec ahead with a cheap 1-D model along the racing line, predicts where the cars
// will be, and picks the one that gains the most ground without a heavy hit. The existing driving code then drives it:
// the planner only picks the lane offset, the following gap and whether to brake at the full limit.
// Pure: a function of the numbers passed in.

/** config/ai.json "lookahead". */
export interface LookaheadConfig {
  /** Re-plan every evalSec; predict horizonSec ahead in stepSec steps. */
  evalSec: number;
  horizonSec: number;
  stepSec: number;
  /** Only with a car ahead within rangeM along the line and laneM across (the follower side; else the rules drive). */
  rangeM: number;
  laneM: number;
  /** Lane offsets tried, in car widths + 0.3 m (0 = the racing line). */
  lanes: number[];
  /** Following gaps tried, bumper to bumper, metres (+ the plain time headway as the safe one). */
  gapsM: number[];
  /** Contact cost per m/s of closing speed: below hitMps (a tap) x tapCost, at or above it (a heavy hit) x heavyCost. */
  hitMps: number;
  tapCost: number;
  heavyCost: number;
  /** The car ahead may brake surpriseDecel m/s^2 harder than predicted (a mistake, an early lift): weighted surpriseWeight
   *  x (1.5 - aggression); in that case the follower reacts after reactSec. */
  surpriseDecel: number;
  surpriseWeight: number;
  reactSec: number;
  /** Metres of score per metre past the usable road (wall / grass), and the bonus the current choice keeps (hysteresis). */
  wallCost: number;
  holdBonusM: number;
  /** How much an offset lane costs in corners (x |offset x curvature|; 1 = just the radius on the inside). */
  offPenalty: number;
  /** Fixed costs (metres of score) of braking at the full limit and of each tighter gap step: both cost tyres (harder
   *  braking, dirty air), so it uses them only when they buy more than that. */
  fullBrakeCostM: number;
  tightCostM: number;
  /** Still in line behind the target at the end: the ground gained closer than the safe gap counts only closeCredit x
   *  (sitting on a gearbox gains nothing by itself; getting alongside does). */
  closeCredit: number;
}

export interface PlanCar { ahead: number; side: number; along: number }
export interface PlanInput {
  speed: number;
  /** Own lateral offset from the line now (m, + right) and the rate it can move sideways (m/s). */
  lat: number;
  latRate: number;
  /** Own speed limit at the line point `q` steps ahead on the racing line (already scaled for tyres, trust). */
  profile: (q: number) => number;
  /** Signed curvature (+ right turn) and the room right / left of the line, `q` steps ahead. */
  k: (q: number) => number;
  roomR: (q: number) => number;
  roomL: (q: number) => number;
  spacingM: number;
  /** Braking it can plan with (m/s^2): following (the safe factor) and at the full limit; acceleration it has. */
  brakeFollow: number;
  brakeFull: number;
  accel: number;
  /** The plain following gap (car length + 1 m + headway x speed). */
  safeGapM: number;
  lengthM: number;
  widthM: number;
  aggression: number;
  others: readonly (PlanCar | undefined)[];
}
/** The choice: lane (in lane widths), its offset (m), gap index (0 = the safe time headway, then gapsM) and gap (m). */
export interface Plan { lane: number; offset: number; gi: number; gapM: number; fullBrake: boolean; score: number; target: number }

const sq = (x: number) => x * x;

/** Corner speed on a lane `off` metres from the line, either side: the inside is a tighter radius (v ~ sqrt(R)), and off
 *  the line on the outside the corner (and the next one, at a direction change) is no faster either: offPenalty x. */
function laneV(v: number, k: number, off: number, offPenalty: number): number {
  return v * Math.sqrt(Math.max(0.3, Math.min(1, 1 - offPenalty * Math.abs(off * k))));
}

/**
 * The best move now, or undefined when nobody's ahead in range (the rules drive). `prev` is the current choice (hysteresis).
 */
export function planMove(inp: PlanInput, cfg: LookaheadConfig, prev?: Plan): Plan | undefined {
  // The car ahead it's planning around: nearest within range in its lane or near it.
  let target = -1, tb: PlanCar | undefined;
  inp.others.forEach((o, oi) => { if (o && o.ahead > 0 && o.ahead < cfg.rangeM && Math.abs(o.side) < cfg.laneM && (!tb || o.ahead < tb.ahead)) { tb = o; target = oi; } });
  if (!tb) return undefined;
  const near = inp.others.filter((o): o is PlanCar => !!o && o.ahead > -inp.lengthM * 2 && o.ahead < cfg.rangeM + 20 && Math.abs(o.side) < 8);
  const laneW = inp.widthM + 0.3, steps = Math.max(1, Math.round(cfg.horizonSec / cfg.stepSec)), dt = cfg.stepSec;
  const prof = (s: number) => { const q = Math.max(0, Math.round(s / inp.spacingM)); return { v: inp.profile(q), k: inp.k(q), r: inp.roomR(q), l: inp.roomL(q) }; };
  // Each other car's speed relative to its own profile now (where it is): it keeps that ratio along the line.
  const ratio = near.map((o) => Math.max(0.6, Math.min(1.15, o.along / Math.max(1, laneV(prof(o.ahead).v, prof(o.ahead).k, o.side + inp.lat, cfg.offPenalty)))));
  const riskW = cfg.surpriseWeight * (1.5 - inp.aggression);
  // Lanes the road has room for over the next ~2 s (at least 40 m), as the driving code clamps them (1.5 m margin);
  // a lane that clamps to one already tried is the same move.
  let maxR = Infinity, maxL = Infinity;
  for (let q = 1, look = Math.ceil(Math.max(40, inp.speed * 2) / inp.spacingM); q <= look; q++) { maxR = Math.min(maxR, Math.max(0, inp.roomR(q) - 1.5)); maxL = Math.min(maxL, Math.max(0, inp.roomL(q) - 1.5)); }
  const tried = new Set<number>();
  let best: Plan | undefined;
  for (const lane of cfg.lanes) {
    const offset = Math.round(Math.max(-maxL, Math.min(maxR, lane * laneW)) * 10) / 10;
    if (tried.has(offset)) continue;
    tried.add(offset);
    const gaps = [inp.safeGapM, ...cfg.gapsM.map((g) => inp.lengthM + g)];
    for (let gi = 0; gi < gaps.length; gi++) {
      const gapM = gaps[gi]!;
      for (const fullBrake of [false, true]) {
        let score = 0;
        for (const surprise of [false, true]) {
          // Own car and the others, stepped along the line.
          let s = 0, v = inp.speed, lat = inp.lat, cost = 0, wall = 0;
          const os = near.map((o) => ({ s: o.ahead, v: o.along, lat: o.side + inp.lat }));
          const brakeA = fullBrake ? inp.brakeFull : inp.brakeFollow;
          for (let t = 1; t <= steps; t++) {
            // Others: toward their own profile speed (x ratio), braking at most brakeFull (+ the surprise for the target).
            os.forEach((o, j) => {
              const p = prof(o.s);
              const want = laneV(p.v, p.k, o.lat, cfg.offPenalty) * ratio[j]!;
              const extra = surprise && near[j] === tb ? cfg.surpriseDecel : 0;
              o.v = Math.max(0, Math.min(o.v + inp.accel * dt, Math.max(want, o.v - inp.brakeFull * dt)) - extra * dt);
              o.s += o.v * dt;
            });
            // Own: sideways toward the lane, speed toward the most the road allows (braking curve to the profile ahead).
            lat += Math.max(-inp.latRate * dt, Math.min(inp.latRate * dt, offset - lat));
            let vMax = Infinity;
            for (let d = 0; d <= Math.ceil((v * v) / (2 * brakeA) / inp.spacingM) + 2; d += 2) {
              const p = prof(s + d * inp.spacingM);
              vMax = Math.min(vMax, Math.sqrt(sq(laneV(p.v, p.k, lat, cfg.offPenalty)) + 2 * brakeA * d * inp.spacingM));
            }
            // Following: never planned faster than keeps gapM to a car in line ahead (as the driving code will do).
            // After a surprise, the follower only reacts reactSec in.
            const react = !surprise || t * dt > cfg.reactSec;
            os.forEach((o) => {
              if (o.s > s && Math.abs(o.lat - lat) < inp.widthM + 0.2) {
                const room = o.s - s - gapM;
                if (react) vMax = Math.min(vMax, Math.max(0, o.v + room * 0.8));
              }
            });
            const vNew = Math.max(0, Math.min(v + inp.accel * dt, Math.max(vMax, v - brakeA * dt)));
            s += ((v + vNew) / 2) * dt;
            v = vNew;
            // Contact: overlapping a car (lengthwise and sideways); cost by closing speed (once per car per run).
            os.forEach((o) => {
              const dl = o.s - s, dLat = Math.abs(o.lat - lat);
              if (Math.abs(dl) < inp.lengthM && dLat < inp.widthM) {
                const closing = Math.abs(v - o.v) + 0.5;
                cost += closing >= cfg.hitMps ? cfg.heavyCost * closing : cfg.tapCost * closing;
                o.s = s + Math.sign(dl || 1) * inp.lengthM; o.v = Math.min(o.v, v); // pushed apart, no double count
              }
            });
            const p = prof(s);
            wall += Math.max(0, lat - (p.r - inp.widthM / 2)) + Math.max(0, -lat - (p.l - inp.widthM / 2));
          }
          const ti = near.indexOf(tb!), tgt = os[ti]!;
          const capS = tgt.s - inp.safeGapM;
          const inLine = Math.abs(tgt.lat - lat) < inp.widthM && tgt.s > s;
          const credited = inLine && s > capS ? capS + cfg.closeCredit * (s - capS) : s;
          const run = credited - cost - cfg.wallCost * wall * dt;
          score += surprise ? riskW * (run - s) : run; // the surprise only adds its cost, not its progress
        }
        score -= (fullBrake ? cfg.fullBrakeCostM : 0) + gi * cfg.tightCostM;
        const same = prev && prev.target === target && prev.lane === lane && prev.gi === gi && prev.fullBrake === fullBrake;
        if (same) score += cfg.holdBonusM;
        if (!best || score > best.score) best = { lane, offset, gi, gapM, fullBrake, score, target };
      }
    }
  }
  return best;
}
