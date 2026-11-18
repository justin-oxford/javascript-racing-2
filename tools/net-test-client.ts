// One net-test client on its own thread (like one browser tab): connects, drives its car with the AI from
// what it shows (its own car predicted, the rest from snapshots), and reports everything it saw at the end.
import { parentPort, workerData } from 'node:worker_threads';
import aiJson from '../config/ai.json' with { type: 'json' };
import { aiInputSource, buildRacingLine, cornerTable, TICK_HZ, type AiConfig } from '../src/sim/index.ts';
import type { RoomSettings } from '../src/server/protocol.ts';
import { LatencySim } from '../src/client/net/latency.ts';
import { NetClient } from '../src/client/net/net-client.ts';
import { loadTrackNode, simContextNode } from './load-track-node.ts';

export interface ClientArgs { port: number; name: string; team: string; code?: string; lag: number; scale: number; track: string; predict: boolean }
export interface ClientReport {
  name: string; you: number; code: string;
  samples: Array<{ tick: number; cars: Array<[number, number, number]>; order: number[] }>;
  corrections: number[]; big: string[]; stalls: number[];
  final: { tick: number; race: unknown } | undefined;
  along95: number; side95: number; alongTicks95: number;
  sent: number; ack: number; rtt: number; kbps: number; stepped: number; reconcileMs: number; drivers: Array<{ code: string; player?: string }>;
}

const a = workerData as ClientArgs;
const ctx = simContextNode(loadTrackNode(a.track)), line = buildRacingLine(ctx.track);
const aiCfg = aiJson as unknown as AiConfig;
const rep: ClientReport = { name: a.name, you: -1, code: '', samples: [], corrections: [], big: [], stalls: [], final: undefined, along95: 0, side95: 0, alongTicks95: 0, sent: 0, ack: -1, rtt: 0, kbps: 0, stepped: 0, reconcileMs: 0, drivers: [] };

const net = new NetClient(`ws://localhost:${a.port}`, new LatencySim(a.lag), { lobby: () => {}, start: () => {}, closed: (r) => console.info(`[${a.name}] closed: ${r}`) });
net.predict = a.predict;
net.predictCtx = simContextNode(loadTrackNode(a.track));
const along: number[] = [], side: number[] = [], alongTicks: number[] = [];
net.onCorrection = (m, c) => {
  const w = net.rawLatest, me = w?.cars[net.race?.you ?? -1];
  if (w?.race?.phase !== 'racing' || !me) return;
  rep.corrections.push(m);
  // Split along the car's heading (forward = sin h, -cos h) and sideways.
  const fx = Math.sin(me.heading), fy = -Math.cos(me.heading);
  along.push(Math.abs(c.dx * fx + c.dy * fy));
  side.push(Math.abs(-c.dx * fy + c.dy * fx));
  // Along the car in ticks of travel: a server tick repeated or dropped is exactly 1.
  const v = Math.hypot(me.vx, me.vy);
  if (v > 5) alongTicks.push(Math.abs(c.dx * fx + c.dy * fy) / (v / TICK_HZ));
  if (m > 0.25) rep.big.push(`t${w.tick} ${(m * 100).toFixed(0)}cm${me.wallContact ? ' wall' : ''}${me.carContact ? ' car' : ''}${me.offTrack ? ' off' : ''} ${(me.speed * 3.6).toFixed(0)}kph`);
};
await net.connect(a.code, { name: a.name, team: a.team, ...(a.scale > 1 ? { timeScale: a.scale } : {}) });
rep.code = net.room!.roomId;
parentPort!.postMessage({ type: 'joined', code: rep.code });
parentPort!.on('message', (m: { type: string; settings?: Partial<RoomSettings> }) => {
  if (m.type === 'settings') net.setSettings(m.settings!);
  if (m.type === 'start') net.startRace();
  if (m.type === 'lobby') parentPort!.postMessage({ type: 'lobby', players: net.lobby?.players.length ?? 0, host: net.isHost });
});

// Drive: every tick, from what this client shows.
let driver: ReturnType<typeof aiInputSource> | undefined;
let next = performance.now(), lastBeat = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  if (now - lastBeat > 100) rep.stalls.push(Math.round(now - lastBeat));
  lastBeat = now;
  const race = net.race, world = net.rawLatest;
  if (!race || !world || race.you < 0) return;
  // The test's AI driver measures its car's limits once (~1 s): do it on the grid, not at lights out.
  if (!driver && aiCfg.measuredLimits) cornerTable(ctx, world.cars[race.you]!.build);
  driver ??= aiInputSource(race.you, () => ({ world: net.predictor?.world ?? net.rawLatest!, ctx, line }), () => aiCfg.presets.medium ?? aiCfg.presets[aiCfg.defaultPreset]!, () => aiCfg, 77 + race.you);
  while (performance.now() >= next) {
    next += 1000 / TICK_HZ / a.scale;
    net.sendInput(driver.read(world.tick));
    rep.sent++;
  }
}, 4);
const sampler = setInterval(() => {
  const w = net.rawLatest;
  if (w?.race) rep.samples.push({ tick: w.tick, cars: w.cars.map((c) => [c.x, c.y, c.heading]), order: [...w.race.order] });
  if (w?.race?.phase === 'results') void finish();
}, 500);

let done = false;
async function finish(): Promise<void> {
  if (done) return;
  done = true;
  await new Promise((r) => setTimeout(r, a.lag + 300)); // the last snapshots in
  clearInterval(timer);
  clearInterval(sampler);
  const w = net.rawLatest;
  const p95 = (v: number[]) => [...v].sort((x, y) => x - y)[Math.floor(v.length * 0.95)] ?? 0;
  Object.assign(rep, {
    along95: p95(along), side95: p95(side), alongTicks95: p95(alongTicks),
    you: net.race?.you ?? -1, final: w ? { tick: w.tick, race: w.race } : undefined, ack: net.buffer.latest?.ack ?? -1, rtt: net.rttMs,
    kbps: net.snapRate.perSec / 1024, stepped: net.predictor?.stepped ?? 0, reconcileMs: net.reconcileMs,
    drivers: net.race?.drivers.map((d) => ({ code: d.code, ...(d.player ? { player: d.player } : {}) })) ?? [],
  });
  parentPort!.postMessage({ type: 'report', report: rep });
  await net.leave().catch(() => {});
}
