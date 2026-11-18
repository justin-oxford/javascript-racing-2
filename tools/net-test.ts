// Card 07, CC CAN VERIFY: a server and two headless clients race each other through the latency
// simulator, and every client's picture of the race is checked against the server's own world.
//   npm run net-test                          (Oxford, 1 lap, 2 AI, 100 ms ping)
//   npm run net-test -- --laps 2 --ai 3 --lag 200 --track colon --scale 2
// Each player's car is driven by the AI, but reading only what that client has received (the snapshots,
// a ping behind the server), the way a person at the keyboard would. Exit code 1 if a check fails.
import { parseArgs } from 'node:util';
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, raceResults, TICK_HZ, type AiConfig, type WorldState } from '../src/sim/index.ts';
import { startServer } from '../src/server/main.ts';
import { RaceRoom } from '../src/server/race-room.ts';
import { LatencySim } from '../src/client/net/latency.ts';
import { NetClient } from '../src/client/net/net-client.ts';
import { loadTrackNode, simContextNode } from './load-track-node.ts';

const { values: a } = parseArgs({ options: {
  track: { type: 'string', default: 'oxford' }, laps: { type: 'string', default: '1' }, ai: { type: 'string', default: '2' },
  lag: { type: 'string', default: '100' }, scale: { type: 'string', default: '1' }, timeout: { type: 'string', default: '240' },
} });
const LAPS = Number(a.laps), AI = Number(a.ai), LAG = Number(a.lag), SCALE = Number(a.scale);
/** Snapshots are quantised to 1 cm / 1 mrad: anything past this is a real mismatch. */
const POS_TOL_M = 0.02, HEAD_TOL = 0.003;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail: string[] = [];
const check = (ok: boolean, what: string) => { console.info(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

// ---- server, with the truth recorded every tick ----
const port = 30000 + Math.floor(Math.random() * 20000);
const server = await startServer(port);
interface Truth { cars: Array<[number, number, number]>; order: number[]; phase: string }
const truth = new Map<number, Truth>();
let finalWorld: WorldState | undefined;
RaceRoom.tap = (_code, w) => {
  truth.set(w.tick, { cars: w.cars.map((c) => [c.x, c.y, c.heading]), order: [...(w.race?.order ?? [])], phase: w.race?.phase ?? '' });
  finalWorld = w;
};

// ---- two clients ----
const ctxFor = () => simContextNode(loadTrackNode(a.track!));
const aiCfg = aiJson as unknown as AiConfig;
interface Player { name: string; net: NetClient; samples: Array<{ tick: number; cars: Array<[number, number, number]>; order: number[] }>; sent: number }
const players: Player[] = [];
for (const name of ['Alpha', 'Bravo']) {
  const net = new NetClient(`ws://localhost:${port}`, new LatencySim(LAG), { lobby: () => {}, start: () => {}, closed: (r) => console.info(`[${name}] closed: ${r}`) });
  players.push({ name, net, samples: [], sent: 0 });
}
const [host, guest] = players as [Player, Player];
// --scale runs the room faster than real time (a create option; latency stays in real milliseconds).
await host.net.connect(undefined, { name: host.name, team: 'cavalli', ...(SCALE > 1 ? { timeScale: SCALE } : {}) });
const code = host.net.room!.roomId;
await guest.net.connect(code, { name: guest.name, team: 'silberner' });
await sleep(300);
host.net.setSettings({ track: a.track!, laps: LAPS, aiCount: AI, aiPreset: 'medium' });
await sleep(300);
check(host.net.isHost && !guest.net.isHost, `room ${code}: host and guest both in the lobby (${host.net.lobby?.players.length} players)`);
host.net.startRace();

// Each client drives with the AI from its own latest snapshot (a ping behind), sending every tick.
for (const p of players) {
  const ctx = ctxFor(), line = buildRacingLine(ctx.track);
  let driver: ReturnType<typeof aiInputSource> | undefined;
  let next = performance.now();
  const timer = setInterval(() => {
    const race = p.net.race, world = p.net.rawLatest;
    if (!race || !world || race.you < 0) return;
    driver ??= aiInputSource(race.you, () => ({ world: p.net.rawLatest!, ctx, line }), () => aiCfg.presets.medium ?? aiCfg.presets[aiCfg.defaultPreset]!, () => aiCfg, 77 + race.you);
    while (performance.now() >= next) {
      next += 1000 / TICK_HZ / SCALE;
      p.net.sendInput(driver.read(world.tick));
      p.sent++;
    }
  }, 4);
  // Sample what the client has, twice a second (in server car order).
  const sampler = setInterval(() => {
    const w = p.net.rawLatest;
    if (w?.race) p.samples.push({ tick: w.tick, cars: w.cars.map((c) => [c.x, c.y, c.heading]), order: [...w.race.order] });
  }, 500);
  (p as Player & { timers: unknown[] }).timers = [timer, sampler];
}

// ---- run until both clients have the results (or time out) ----
const t0 = Date.now();
while (Date.now() - t0 < Number(a.timeout) * 1000) {
  await sleep(500);
  if (players.every((p) => p.net.rawLatest?.race?.phase === 'results')) break;
}
const secs = ((Date.now() - t0) / 1000).toFixed(0);
await sleep(LAG + 200);
for (const p of players) for (const t of (p as Player & { timers: Array<ReturnType<typeof setInterval>> }).timers) clearInterval(t);

// ---- checks ----
const serverRace = finalWorld?.race;
check(serverRace?.phase === 'results', `server race reached results (${serverRace?.phase}) after ${secs} s, ${finalWorld?.tick} ticks`);
for (const p of players) {
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
  const w = p.net.rawLatest;
  const fin = w && truth.get(w.tick);
  check(!!fin && w!.race?.order.join() === fin.order.join() && w!.race?.phase === 'results', `${p.name}: final order ${w?.race?.order.join(',')} = server ${serverRace?.order.join(',')}`);
  const mine = w?.race && raceResults(w.race), theirs = serverRace && raceResults(serverRace);
  check(JSON.stringify(mine) === JSON.stringify(theirs), `${p.name}: results table identical to the server's`);
  const me = p.net.race?.you ?? -1, ack = p.net.buffer.latest?.ack ?? -1;
  console.info(`      ${p.name}: car ${me}, sent ${p.sent} inputs, server applied up to seq ${ack}, ping ${p.net.rttMs.toFixed(0)} ms, ${(p.net.snapRate.perSec / 1024).toFixed(1)} KB/s of snapshots`);
}
const [ga, gb] = [host.net.rawLatest?.race?.order.join(), guest.net.rawLatest?.race?.order.join()];
check(ga === gb, `both clients show the same finish order (${ga} / ${gb})`);
if (serverRace) for (const r of raceResults(serverRace)) {
  const d = host.net.race?.drivers[r.car];
  console.info(`      P${r.pos} ${d?.code ?? '?'} ${d?.player ? '(player)' : '(AI)'} laps ${r.laps} ${r.finished ? r.time.toFixed(3) + ' s' : 'not finished'}`);
}

await Promise.all(players.map((p) => p.net.leave().catch(() => {})));
await server.gracefullyShutdown(false);
console.info(fail.length ? `\n${fail.length} check(s) FAILED` : '\nAll checks passed.');
process.exit(fail.length ? 1 : 0);
