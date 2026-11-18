// Multiplayer server (cards 07 + 08). Started by serve.ts (npm run server locally, the bundle on the box).
import { matchMaker, Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import netCfg from '../../config/net.json' with { type: 'json' };
import { DEFAULT_PORT, ROOM_NAME } from './protocol';
import { RaceRoom, roomCount } from './race-room';

export interface ServerOptions {
  port?: number;
  /** Interface to listen on (the box: 127.0.0.1, only Caddy talks to the server). Default: all. */
  host?: string;
  /** What's running (git commit), shown on /health so a deploy can check it's the new one. */
  release?: string;
  /** Pages allowed to use the server (CORS on the HTTP routes, Origin on WebSocket upgrades). */
  allowedOrigins?: readonly string[];
}

const startedAt = Date.now();

/**
 * Cross-origin (card 08): the game page (GitHub Pages) and the server are different origins. Only the
 * listed origins get CORS headers, and a WebSocket upgrade from any other page is refused. A request with
 * no Origin at all (not a browser page: tests, curl) passes; Origin only protects browsers anyway.
 */
function lockOrigins(allowed: readonly string[]): (origin: string | null | undefined) => boolean {
  const ok = (origin: string | null | undefined) => !origin || allowed.includes(origin);
  const fallback = allowed[0] ?? 'null';
  // Colyseus answers matchmaking with "Access-Control-Allow-Origin: <whatever the page was>" by default.
  matchMaker.controller.DEFAULT_CORS_HEADERS['Access-Control-Allow-Origin'] = fallback;
  matchMaker.controller.getCorsHeaders = (headers: Headers) => {
    const origin = headers.get('origin');
    return { 'Access-Control-Allow-Origin': origin && ok(origin) ? origin : fallback, Vary: 'Origin' };
  };
  return ok;
}

/** Start a server on `port`. */
export async function startServer(port: number | ServerOptions = DEFAULT_PORT): Promise<Server> {
  const o: ServerOptions = typeof port === 'number' ? { port } : port;
  const allowed = o.allowedOrigins ?? netCfg.server.allowedOrigins;
  const originOk = lockOrigins(allowed);
  const transport = new WebSocketTransport({
    beforeUpgrade: (_request: Request, context: { headers: Headers }) => {
      const origin = context.headers.get('origin');
      if (!originOk(origin)) {
        console.warn(`[server] refused a WebSocket from ${origin}`);
        return new Response('origin not allowed', { status: 403 });
      }
      return undefined;
    },
  });
  const server = new Server({
    transport,
    greet: false,
    // GET /health: is it up, how many races, since when (deploy:server checks this).
    express: (app: { get(path: string, h: (req: unknown, res: { json(v: unknown): void }) => void): void }) => {
      app.get('/health', (_req, res) => res.json({ ok: true, rooms: roomCount(), uptimeSec: Math.round((Date.now() - startedAt) / 1000), node: process.version, release: o.release ?? 'dev' }));
    },
  } as ConstructorParameters<typeof Server>[0]);
  server.define(ROOM_NAME, RaceRoom);
  await (o.host ? server.listen(o.port ?? DEFAULT_PORT, o.host) : server.listen(o.port ?? DEFAULT_PORT));
  return server;
}
