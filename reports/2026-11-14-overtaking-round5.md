# AI overtaking, round 5 (2026-11-14)

Measured on round 4's seeds with 15-lap races at Oxford: 8 Team-stats races (seeds 1–8) and 12 Equal races (seeds 1–12). A **catch** is when a car that is at least 0.5 s a lap quicker on its own gets within 1 s of the car directly ahead.

## 1. Summary

- **Step 1:** attackers were in fuel SAVE for 90% of every catch, and they don't brake any later when attacking. Both of your suspicions are confirmed.
- **Step 2:** fixed the fuel wiring, which was wrong: SAVE stayed on for the whole race, and cars finished with 2–4 laps of fuel left. That fix is now on. A wider deploy window is in the code but switched off; it halved the swaps back in Equal mode.
- **Step 3:** the look-ahead brain is built and **off** (`ai.brain = "rules"`). In Team stats, faster cars got past within 3 laps about three times as often (10 of 54 catches, against 3 of 44 with the fixed rules). But Equal mode had more stuck events (12 against 7) and more heavy hits (5 against 2), and it costs about 1.65× the AI and sim time.
- **Recommendation:** keep the rules as the default. Make the look-ahead the base for round 6 and work on what it does after a mistake before turning it on.

## 2. Step 1 findings (rules as of round 4, 51 catches, 12,959 s of chasing)

| What was logged | Share of chasing time, or result |
|---|---|
| Racecraft mode | ATTACK 51%, MANAGE 48%, DEFEND 0% |
| Engine mode | **SAVE 90%**, STANDARD 10%, PUSH 0% |
| Catches spent mostly saving | 46 of 51 |
| Fuel | every car switched to SAVE on lap 2 (≈101 kg) and finished with 11–28 kg, about 1.5–4 laps of spare fuel |
| Deploy asked for and used | 0.3% |
| Each deploy condition, how often true | mode allows it 52%, a car in range 93%, straight ahead 44%, no braking zone within 3 s 44%, throttle above 0.9 15% |
| ATTACK's push margin (+2%) on | 52% (only while the mode is ATTACK) |
| Close-up on | 12% |
| Following rule holding speed below its own plan | 34% |
| Braking point while attacking, vs its own solo point | median 0 m, mean 3.6 m **earlier** |
| Braking point while following in MANAGE, vs solo | median 8 m earlier |
| Braking point vs where the car ahead braked | median 0 m, mean 0.3 m earlier |

**Are attackers trying to pass while conserving?** Yes. They spent 90% of their catches in SAVE (96% power), and none of them needed to. SAVE stayed on for the whole race once it switched on at lap 2. The fuel estimate came from lap 1 (the standing start) and from cars running in clean air, so it read high, and every car finished with laps of fuel left.

**Do they drive deeper when attacking?** No.
- In ATTACK a car brakes at its own solo braking point, and on average 3.6 m earlier.
- ATTACK's braking factor (0.93) only undoes the extra margin for following (0.8). It never brakes later than solo.
- The +2% corner margin applies only while the mode says ATTACK, which is half the chase. When the car stops closing, the mode drops back to MANAGE.
- For a third of the time the following rule holds it below the speed it plans for itself. So the follow rule pulls it back; attacking doesn't add any extra depth.

## 3. Step 2 changes

| Change | Why | Switch | State |
|---|---|---|---|
| SAVE turns off once the tank holds 0.5 lap more than the finish needs in STANDARD, and turns back on if fuel runs short | SAVE was sticky for the race (step 1) | `ai.fuelSave.releaseLaps` (absent = sticky, as before) | **on, 0.5** |
| Deploy allowed until 1 s before a braking point (today: off 3 s before, the pull-out window) | Deploy was blocked on most of every Oxford straight | `ai.overtaking.deployBrakeSec` (absent = as before) | **off**: it measured worse |

The rest of what step 1 found is not a wiring bug, so it stays as it is. ATTACK dropping to MANAGE while not closing can be changed with `attackStayGapSec`, but round 3 tried that and it raised the close-up, which you ruled out this round.

| Same seeds | Before | Fuel fix (on) | Deploy 1 s | Both |
|---|---|---|---|---|
| Share of chasing in SAVE | 90% | 9% | 90% | 9% |
| Deploying | 0.3% | 0.3% | 2.2% | 1.9% |
| Team: catches, passed (within 3 laps) | 51, 10 (5) | 44, 5 (3) | 49, 4 (2) | 53, 3 (3) |
| Team: passes | 78 | 71 | 65 | 67 |
| Equal: passes, swaps back | 142, 15 | 119, 14 | 102, 7 | 99, 7 |
| Heavy hits, Team / Equal | 2 / 4 | 2 / 2 | 1 / 4 | 0 / 2 |
| Stuck, Team / Equal | 3 / 10 | 2 / 7 | 2 / 7 | 1 / 4 |

Both fixes apply to every car, defenders included. In Team stats they slightly reduced passing: the slower car ahead now also runs at full power, and deploying lets defenders deploy too. The fuel fix is on because it is a real bug (races were run 4% down on power for nothing), and it cut heavy hits and stuck events.

## 4. A/B table

| Same seeds | Rules (round 4) | Rules + step 2 fix | Look-ahead (+ fix) |
|---|---|---|---|
| Team: catches | 51 | 44 | 54 |
| Team: passed / passed within 3 laps | 10 / 5 | 5 / 3 | **12 / 10** |
| Team: share passed within 3 laps | 10% | 7% | **19%** |
| Team: median time to pass | 4.3 laps | 2.4 laps | **1.9 laps** |
| Team: lost touch | 2 | 4 | 13 |
| Team: passes, swaps back | 78, 14 | 71, 14 | 80, 16 |
| Equal: passes | 142 | 119 | 146 |
| Equal: swaps back | 15 | 14 | 14 |
| Heavy hits, Team / Equal | 2 / 4 | 2 / 2 | 1 / **5** |
| Taps, Team / Equal | 31 / 39 | 26 / 45 | 44 / 49 |
| Stuck, Team | 3 (after a spin 2, no mistake 1) | 2 (spin 1, none 1) | 2 (spin 2) |
| Stuck, Equal | 10 (spin 5, lap 1 2, none 2, wide 1) | 7 (wide 2, lap 1 2, none 2, spin 1) | **12** (spin 5, wide 2, lap 1 2, none 2, car contact 1) |
| Solo lap time (mean of 10 cars, best of laps 2–3) | 30.32 s | 30.32 s | 30.32 s (no planning when alone) |
| Headless speed, 10 / 20 cars | 17.5× / 6.8× real time | same | 10.6× / 4.3× |
| Sim + AI per tick, 10 / 20 cars | 0.95 / 2.45 ms | same | 1.57 / 3.84 ms |
| Browser frame, 10 cars (dev build, practice) | 1.5 ms | same | 2.6 ms |
| Browser frame, 20 cars | not possible (the game caps AI at 9) | same | headless says +1.4 ms per frame |

How the look-ahead works (`src/sim/lookahead.ts`):
- Every 0.1 s, a car with another car within 40 m ahead tries 5 lanes × 3 following gaps × normal or full-limit braking.
- It predicts 1.2 s ahead along the line, including a case where the car ahead brakes 4 m/s² harder than expected, with 0.25 s to react.
- It scores progress minus contact cost: taps are cheap, hits of 12 m/s or more are 10× the cost. It then subtracts the wall risk and a tyre cost for full braking and tight gaps.
- Sitting on a gearbox counts for only 30% of the ground it gains. Without that, it followed tightly everywhere, and the rear tyres wore to 0.4 by lap 10. With it set to 0 it drives like the rules (5 passed, 3 within 3 laps).
- The current driving code still steers and holds the speed.

Seed noise is large: 12–20 races move these counts by ±15%. The Team-stats gain in time to pass (10 vs 3) is larger than that. The Equal stuck difference (12 vs 7) is about that size, but it points the wrong way, and the card's bar was "no more heavy hits or stuck events".

## 5. Decisions I made on my own

| Decision | Why |
|---|---|
| Fuel release on by default (`releaseLaps` 0.5), and it can be removed | Clear bug, and heavy hits and stuck events went down; most reversible as one key |
| Deploy window lever left off | Equal swaps back 15 → 7 |
| Look-ahead off (`ai.brain` "rules") | Equal stuck and heavy hits were higher; the card says you decide the default |
| Look-ahead not used on lap one, in the pit lane, or during a mistake | Its model has no start manners; the rules already handle lap one |
| `closeCredit` 0.3 | 1.0 wore rear tyres out (spins at line point ~300); 0 drives like the rules |
| Slow race tests get a 60 s time limit (step 0) | A time limit, not a quality limit; it only applies to the 8 whole-race tests |
| The four step-2 variants and both look-ahead settings each ran on the same 20 seeds | The like-for-like comparison you asked for |
| Short comments on the overtaking, look-ahead brain and Handling tuning pass cards; all left where they were | Your rules (tuning changes noted on the pass card) |

## 6. Commits and tests

| Commit | What |
|---|---|
| 3710322 | Step 0: slow whole-race tests get a 60 s time limit |
| fa84ce0 | Steps 1–3: catch diagnostics, fuel SAVE release, deploy lever (off), look-ahead brain (off), `tools/brain-bench.ts` |
| (this file) | Report |

173 tests pass (168 before, plus 5 new look-ahead tests: no car ahead, pulling out, never a heavy hit with nowhere to go, determinism and hysteresis, the rules/look-ahead switch over a race). Typecheck and build pass.

## 7. Waiting on you

1. **Look-ahead default:** keep "rules" (my pick), or try `"brain": "lookahead"` in `config/ai.json` and feel it. The trade is time to pass 2.4 → 1.9 laps and passed within 3 laps 3 → 10, against Equal stuck 7 → 12, heavy hits 2 → 5, and about 1.65× the AI and sim cost.
2. **Deploy window:** `ai.overtaking.deployBrakeSec` 1, yes or no (deploy 0.3% → 2.2%, Equal swaps back 15 → 7).
3. **ATTACK held while close** (`attackStayGapSec`): it would keep the margins and deploy on for the whole chase, but it also turns the close-up on. Your call whether that counts as a new close-up attempt.
4. **Hand checks:**
   - low-speed handling, and whether 12 m/s feels right as the heavy-hit line
   - from earlier: rain sound, tyre hiss and spray, wet driving on inters, the garage, racing your ghost, the pit board's 8/9 keys, the parked start, Garage real units, the EXIT line in `?edit=1`
5. **Decisions still open:**
   - the overtaking close-up at 0.75 s
   - track edits: the wall after T1 at line point 52, and the spin spots at line points 46–48 and 293
   - wet: planning slick speeds from the water off the line
   - gentler AI spins
   - parc fermé, the roster PACE spread, refLaps, ride-height rake, grid teleport on the 0 key only, and the accent-colour region mask
6. **Cards to close:** the wet-stops, parked-player and frozen-pit-entry bugs.
7. **Unsaved `?tune=1` values:** paste them on the Handling tuning pass card.
