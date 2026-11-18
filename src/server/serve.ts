// Start the multiplayer server: `npm run server` here, the bundled dist-server/server.mjs on the box (card 08).
//   PORT             listen port (default 2567; on the box Caddy proxies https://race... to it)
//   HOST             interface to listen on (the box: 127.0.0.1, behind Caddy; default all)
//   ALLOWED_ORIGINS  comma-separated pages allowed to connect (default: config/net.json server.allowedOrigins)
//   RELEASE          what's running (deploy:server sets it from dist-server/release.json), shown on /health
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_PORT } from './protocol';
import { startServer } from './main';
import { roomTracks } from './tracks';

const port = Number(process.env.PORT) || DEFAULT_PORT;
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean);
const host = process.env.HOST || undefined;
// The bundle sits in dist-server/ with release.json beside it (written by build:server).
const releaseFile = new URL('./release.json', import.meta.url);
const release = process.env.RELEASE ?? (existsSync(releaseFile) ? (JSON.parse(readFileSync(releaseFile, 'utf8')) as { commit: string }).commit : undefined);
const tracks = roomTracks(); // load every track up front: the first race doesn't wait for wall tracing
await startServer({ port, ...(host ? { host } : {}), ...(release ? { release } : {}), ...(allowedOrigins?.length ? { allowedOrigins } : {}) });
console.info(`[server] ${release ?? 'dev'} racing on ${host ?? '*'}:${port} (tracks: ${tracks.map((t) => t.id).join(', ')}; origins: ${allowedOrigins?.join(', ') ?? 'config/net.json'})`);
