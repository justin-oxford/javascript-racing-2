// Vite plugin for /tracks:
// - dev: tell the page when a track PNG changes or appears (hot reload of the mask, no page reload)
// - dev: POST /__editor/save-track/<id> writes tracks/<id>/track.json (the editor's Save button)
// - build: copy tracks/<id>/*.png into dist/tracks/<id>/ so the game can fetch them at runtime
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';

const ID_RE = /^[a-z0-9-]+$/;

export function trackPlugin(): Plugin {
  let root = process.cwd();
  const tracksDir = (): string => join(root, 'tracks');

  /** "tracks/<id>/<file>.png" -> { id, file } */
  const parse = (abs: string): { id: string; file: string } | undefined => {
    const rel = relative(tracksDir(), abs).split(sep);
    if (rel.length !== 2 || rel[0] === '..' || !rel[1]!.toLowerCase().endsWith('.png')) return undefined;
    return { id: rel[0]!, file: rel[1]! };
  };

  return {
    name: 'javascript-racing-tracks',
    configResolved(config) {
      root = config.root;
    },

    configureServer(server) {
      server.watcher.add(join(tracksDir(), '*', '*.png'));
      const notify = (abs: string): void => {
        const hit = parse(abs);
        if (hit) server.ws.send({ type: 'custom', event: 'track:file-changed', data: hit });
      };
      server.watcher.on('add', notify);
      server.watcher.on('change', notify);

      server.middlewares.use('/__editor/save-track/', (req, res) => {
        const id = (req.url ?? '').replace(/^\//, '').split('?')[0]!;
        if (req.method !== 'POST' || !ID_RE.test(id) || !existsSync(join(tracksDir(), id))) {
          res.statusCode = 400;
          res.end('bad request');
          return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c: string) => (body += c));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { id?: unknown };
            if (parsed.id !== id) throw new Error(`track.json id "${String(parsed.id)}" doesn't match ${id}`);
            writeFileSync(join(tracksDir(), id, 'track.json'), body);
            res.end('saved');
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
          }
        });
      });
    },

    // Track PNGs are fetched at runtime, not imported; never let a change to one reload the page.
    handleHotUpdate(ctx) {
      if (parse(ctx.file)) return [];
      return undefined;
    },

    generateBundle() {
      if (!existsSync(tracksDir())) return;
      for (const id of readdirSync(tracksDir())) {
        if (!ID_RE.test(id)) continue;
        for (const file of readdirSync(join(tracksDir(), id))) {
          if (!file.toLowerCase().endsWith('.png')) continue;
          this.emitFile({ type: 'asset', fileName: `tracks/${id}/${file}`, source: readFileSync(join(tracksDir(), id, file)) });
        }
      }
    },
  };
}
