// net-test's server, on its own thread (worker_threads) so the clients' prediction can't stall it (and the
// other way round), as with a real server. Posts the truth (every car's pose, order, phase) every tick.
import { parentPort, workerData } from 'node:worker_threads';
import { startServer } from '../src/server/main.ts';
import { RaceRoom } from '../src/server/race-room.ts';

const { port } = workerData as { port: number };
RaceRoom.tap = (_code, w, host) => {
  parentPort!.postMessage({ type: 'tick', tick: w.tick, cars: w.cars.map((c) => [c.x, c.y, c.heading]), order: [...(w.race?.order ?? [])], phase: w.race?.phase ?? '', race: w.race?.phase === 'results' ? w.race : undefined, inputStats: host.inputStats });
};
const server = await startServer(port);
parentPort!.postMessage({ type: 'ready' });
parentPort!.on('message', async (m: { type: string }) => {
  if (m.type === 'stop') { await server.gracefullyShutdown(false); parentPort!.postMessage({ type: 'stopped' }); }
});
