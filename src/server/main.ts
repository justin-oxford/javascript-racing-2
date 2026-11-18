// Multiplayer server entry (card 07): npm run server. Local only for now (card 08 puts it online).
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { DEFAULT_PORT, ROOM_NAME } from './protocol';
import { RaceRoom } from './race-room';
import { roomTracks } from './tracks';

/** Start a server on `port`. */
export async function startServer(port = DEFAULT_PORT): Promise<Server> {
  const server = new Server({ transport: new WebSocketTransport(), greet: false });
  server.define(ROOM_NAME, RaceRoom);
  await server.listen(port);
  return server;
}

if (process.argv[1] && /server[\\/]main\.ts$/.test(process.argv[1])) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const tracks = roomTracks(); // load every track up front: the first race doesn't wait for wall tracing
  await startServer(port);
  console.info(`[server] racing on ws://localhost:${port} (tracks: ${tracks.map((t) => t.id).join(', ')})`);
}
