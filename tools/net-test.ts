// Card 07, CC CAN VERIFY: a server and two clients race each other through the latency simulator, and every
// client's picture of the race is checked against the server's own world.
//   npm run net-test                          (Oxford, 1 lap, 2 AI, 100 ms ping, prediction on)
//   npm run net-test -- --laps 2 --ai 3 --lag 200 --track colon --scale 2 --predict 0
// The server and each client run on their own threads (worker_threads), like a server and two browser tabs.
// Each player's car is driven by the AI from what that client shows: its own car predicted (step 6), the
// rest from snapshots a ping behind. Exit code 1 if a check fails.
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { raceResults, type RaceState } from '../src/sim/index.ts';
import type { ClientArgs, ClientReport } from './net-test-client.ts';

const { values: a } = parseArgs({ options: {
  track: { type: 'string', default: 'oxford' }, laps: { type: 'string', default: '1' }, ai: { type: 'string', default: '2' },
  lag: { type: 'string', default: '100' }, scale: { type: 'string', default: '1' }, timeout: { type: 'string', default: '300' },
  predict: { type: 'string', default: '1' }, drop: { type: 'string', default: '20' },
} });
const LAPS = Number(a.laps), AI = Number(a.ai), LAG = Number(a.lag), SCALE = Number(a.scale), PREDICT = a.predict !== '0';
/** Snapshots are quantised to 1 cm / 1 mrad: anything past this is a real mismatch. */
const POS_TOL_M = 0.02, HEAD_TOL = 0.003;
/**
 * Prediction (step 6). What you'd SEE is sideways: 95% of corrections at most PRED_SIDE_P95_M across the car.
 * Along the car, a correction is a tick of travel each time the server's input queue runs dry or drops one
 * (it really did move a tick more or less); 95% within PRED_ALONG_P95_TICKS of that.
 */
const PRED_SIDE_P95_M = 0.1, PRED_ALONG_P95_TICKS = 1.5;

const fail: string[] = [];
const check = (ok: boolean, what: string) => { console.info(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };
const tsx = { execArgv: ['--import', 'tsx'] };

// ---- server, with the truth recorded every tick ----
const port = 30000 + Math.floor(Math.random() * 20000);
const server = new Worker(new URL('./net-test-server.ts', import.meta.url), { workerData: { port }, ...tsx });
interface Truth { cars: Array<[number, number, number]>; order: number[]; phase: string }
const truth = new Map<number, Truth>();
let serverRace: RaceState | undefined, lastTick = 0, inputStats: Array<{ repeats: number; drops: number }> = [];
/** Ticks each car spent AI-driven while racing (players: only while dropped). */
const aiTicks: number[] = [];
let lightsOutTick = -1;
await new Promise<void>((resolve, reject) => {
  server.on('error', reject);
  server.on('message', (m: { type: string; tick: number; cars: Array<[number, number, number]>; order: number[]; phase: string; race?: RaceState; inputStats: typeof inputStats; ai: boolean[] }) => {
    if (m.type === 'ready') resolve();
    if (m.type !== 'tick') return;
    truth.set(m.tick, { cars: m.cars, order: m.order, phase: m.phase });
    lastTick = m.tick;
    inputStats = m.inputStats;
    if (m.phase === 'racing') { if (lightsOutTick < 0) lightsOutTick = m.tick; m.ai.forEach((on, i) => (aiTicks[i] = (aiTicks[i] ?? 0) + (on ? 1 : 0))); }
    if (m.race) serverRace = m.race;
  });
});

// ---- two clients ----
function client(args: Pick<ClientArgs, 'name' | 'team'> & { code?: string }) {
  const w = new Worker(new URL('./net-test-client.ts', import.meta.url), { workerData: { ...args, port, lag: LAG, scale: SCALE, track: a.track!, predict: PREDICT } satisfies ClientArgs, ...tsx });
  const on = <T>(type: string) => new Promise<T>((r) => w.on('message', (m: { type: string } & T) => m.type === type && r(m)));
  // A client that crashes ends the test (instead of everyone waiting on it).
  w.on('error', (e) => { console.error(`[${args.name}] crashed:`, e); process.exit(1); });
  return {
    w,
    joined: on<{ code: string }>('joined').then((m) => m.code),
    report: on<{ report: ClientReport }>('report').then((m) => m.report),
    ask: (m: object) => { const p = on<{ players: number; host: boolean }>('lobby'); w.postMessage(m); return p; },
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alpha = client({ name: 'Alpha', team: 'cavalli' });
const code = await alpha.joined;
const bravo = client({ name: 'Bravo', team: 'silberner', code });
await bravo.joined;
await sleep(LAG + 300);
alpha.w.postMessage({ type: 'settings', settings: { track: a.track!, laps: LAPS, aiCount: AI, aiPreset: 'medium' } });
await sleep(LAG + 300);
const [la, lb] = [await alpha.ask({ type: 'lobby' }), await bravo.ask({ type: 'lobby' })];
check(la.host && !lb.host && la.players === 2 && lb.players === 2, `room ${code}: host and guest both in the lobby`);
alpha.w.postMessage({ type: 'start' });
// Disconnects (card 07): Bravo's connection drops mid-race; the AI should drive the car until it's back.
const DROP_AT_SEC = Number(a.drop);
if (DROP_AT_SEC > 0) setTimeout(() => bravo.w.postMessage({ type: 'drop' }), DROP_AT_SEC * 1000);

const t0 = Date.now();
const reports = await Promise.race([
  Promise.all([alpha.report, bravo.report]),
  new Promise<undefined>((r) => setTimeout(() => r(undefined), Number(a.timeout) * 1000)),
]);
const secs = ((Date.now() - t0) / 1000).toFixed(0);

// ---- checks ----
check(serverRace?.phase === 'results', `server race reached results (${serverRace?.phase ?? truth.get(lastTick)?.phase}) after ${secs} s, ${lastTick} ticks`);
for (const p of reports ?? []) {
  let maxPos = 0, maxHead = 0, compared = 0, orderMismatch = 0;
  for (const s of p.samples) {
    const t = truth.get(s.tick);
    if (!t) continue;
    compared++;
    s.cars.forEach(([x, y, h], i) => {
      const [tx, ty, th] = t.cars[i]!;
      maxPos = Math.max(maxPos, Math.hypot(x - tx, y - ty));
      maxHead = Math.max(maxHead, Math.abs(Math.atan2(Math.sin(h - th), Math.cos(h - th))));
    });
    if (s.order.join() !== t.order.join()) orderMismatch++;
  }
  check(compared > 10 && maxPos <= POS_TOL_M && maxHead <= HEAD_TOL, `${p.name}: every car matches the server at the same tick (${compared} samples, max ${(maxPos * 100).toFixed(2)} cm, ${(maxHead * 1000).toFixed(2)} mrad)`);
  check(orderMismatch === 0, `${p.name}: running order matches the server at every sample (${orderMismatch} mismatches)`);
  // Step 7: the lights this client showed went out on the server's lights-out tick (within a few ticks).
  check(p.shownLightsOut >= 0 && Math.abs(p.shownLightsOut - lightsOutTick) <= 1, `${p.name}: showed lights out for server tick ${p.shownLightsOut}, server's ${lightsOutTick}`);
  const race = p.final?.race as RaceState | undefined;
  check(race?.phase === 'results' && race.order.join() === serverRace?.order.join(), `${p.name}: final order ${race?.order.join(',')} = server ${serverRace?.order.join(',')}`);
  check(!!race && !!serverRace && JSON.stringify(raceResults(race)) === JSON.stringify(raceResults(serverRace)), `${p.name}: results table identical to the server's`);
  if (PREDICT) {
    // Every correction is how far the predicted car was from where the server put it.
    const cs = [...p.corrections].sort((x, y) => x - y), q = (f: number) => cs[Math.min(cs.length - 1, Math.floor(f * cs.length))] ?? 0;
    console.info(`      ${p.name}: prediction error while racing: median ${(q(0.5) * 100).toFixed(1)} cm, 95% ${(q(0.95) * 100).toFixed(1)} cm, max ${(q(1) * 100).toFixed(0)} cm over ${cs.length} snapshots`);
    check(cs.length > 50 && p.side95 <= PRED_SIDE_P95_M, `${p.name}: prediction sideways error 95% ${(p.side95 * 100).toFixed(1)} cm (must be <= ${PRED_SIDE_P95_M * 100} cm)`);
    check(cs.length > 50 && p.alongTicks95 <= PRED_ALONG_P95_TICKS, `${p.name}: prediction error along the car 95% ${p.alongTicks95.toFixed(2)} ticks of travel = ${(p.along95 * 100).toFixed(0)} cm (must be <= ${PRED_ALONG_P95_TICKS} ticks)`);
    if (p.big.length) console.info(`      ${p.name}: corrections over 25 cm (${p.big.length}): ${p.big.slice(0, 6).join(' | ')}${p.big.length > 6 ? ` ... ${p.big.slice(-6).join(' | ')}` : ''}`);
    console.info(`      ${p.name}: server input queue ran dry ${inputStats[p.you]?.repeats} times, dropped ${inputStats[p.you]?.drops}`);
    console.info(`      ${p.name}: prediction stepped ${p.stepped} ticks, rewind + replay ${(p.reconcileMs / Math.max(1, cs.length)).toFixed(1)} ms per snapshot`);
  }
  console.info(`      ${p.name}: car ${p.you}, sent ${p.sent} inputs, server used up to seq ${p.ack}, ping ${p.rtt.toFixed(0)} ms, ${p.kbps.toFixed(1)} KB/s of snapshots, thread stalls over 100 ms: ${p.stalls.length ? p.stalls.join(', ') + ' ms' : 'none'}`);
}
if (DROP_AT_SEC > 0) {
  const b = reports?.[1], at = b ? aiTicks[b.you] ?? 0 : 0;
  check(!!b && b.reconnects >= 1 && at > 0 && at < 30 * 60, `Bravo dropped at ${DROP_AT_SEC} s: reconnected ${b?.reconnects ?? 0}x, the AI drove the car for ${(at / 60).toFixed(1)} s meanwhile, then gave it back`);
  check(!!reports?.[0] && (aiTicks[reports[0].you] ?? 0) === 0, `Alpha (no drop): never AI-driven`);
}
const fa = (reports?.[0]?.final?.race as RaceState | undefined)?.order.join(), fb = (reports?.[1]?.final?.race as RaceState | undefined)?.order.join();
check(!!fa && fa === fb, `both clients show the same finish order (${fa} / ${fb})`);
if (serverRace) for (const r of raceResults(serverRace)) {
  const d = reports?.[0]?.drivers[r.car];
  console.info(`      P${r.pos} ${d?.code ?? '?'} ${d?.player ? '(player)' : '(AI)'} laps ${r.laps} ${r.finished ? r.time.toFixed(3) + ' s' : 'not finished'}`);
}

server.postMessage({ type: 'stop' });
await new Promise((r) => { server.on('message', (m: { type: string }) => m.type === 'stopped' && r(undefined)); setTimeout(r, 3000); });
await Promise.all([server.terminate(), alpha.w.terminate(), bravo.w.terminate()]);
console.info(fail.length ? `\n${fail.length} check(s) FAILED` : '\nAll checks passed.');
process.exit(fail.length ? 1 : 0);
