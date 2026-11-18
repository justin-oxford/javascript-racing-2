// Start the multiplayer server: `npm run server` here, the bundled dist-server/server.mjs on the box (card 08).
//   PORT             listen port (default 2567; on the box Caddy proxies https://race... to it)
//   HOST             interface to listen on (the box: 127.0.0.1, behind Caddy; default all)
//   ALLOWED_ORIGINS  comma-separated pages allowed to connect (default: config/net.json server.allowedOrigins)
//   RELEASE          what's running (deploy:server sets it from dist-server/release.json), shown on /health
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_PORT } from './protocol';
import { startServer } from './main';
import physicsJson from '../../config/physics.json' with { type: 'json' };
import trackDefaults from '../../config/track-defaults.json' with { type: 'json' };
import { warmCornerTables } from './race-host';
import { raceContext, roomTracks } from './tracks';

const port = Number(process.env.PORT) || DEFAULT_PORT;
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean);
const host = process.env.HOST || undefined;
// The bundle sits in dist-server/ with release.json beside it (written by build:server).
const releaseFile = new URL('./release.json', import.meta.url);
const release = process.env.RELEASE ?? (existsSync(releaseFile) ? (JSON.parse(readFileSync(releaseFile, 'utf8')) as { commit: string }).commit : undefined);
const tracks = roomTracks(); // load every track up front: the first race doesn't wait for wall tracing
// The usual race (default track + spec, any team) starts at once: its AI corner tables are measured now.
const warmTrack = tracks.find((t) => t.id === (trackDefaults as { defaultTrack?: string }).defaultTrack)?.id ?? tracks[0]?.id;
if (warmTrack) {
  const t0 = performance.now();
  const n = warmCornerTables(raceContext(warmTrack), (physicsJson as { defaultCar: { spec: string } }).defaultCar.spec);
  console.info(`[server] measured ${n} corner tables for ${warmTrack} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
await startServer({ port, ...(host ? { host } : {}), ...(release ? { release } : {}), ...(allowedOrigins?.length ? { allowedOrigins } : {}) });
console.info(`[server] ${release ?? 'dev'} racing on ${host ?? '*'}:${port} (tracks: ${tracks.map((t) => t.id).join(', ')}; origins: ${allowedOrigins?.join(', ') ?? 'config/net.json'})`);
