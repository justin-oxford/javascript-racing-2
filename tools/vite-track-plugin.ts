// Vite plugin for /tracks and /config:
// - virtual:tracks: the list of track folders (ids + fixture flag), so a new authored track shows up
// - dev: tell the page when a track PNG changes, appears or is deleted (hot reload, no page reload);
//   a brand-new track folder triggers a full reload so it joins the list
// - dev: POST /__editor/save-track/<id> writes tracks/<id>/track.json (the editor's Save button)
// - dev: POST /__tuning/save/<name> writes config/<name>.json (the tuning panel's Save button)
// - build: copy tracks/<id>/*.png into dist/tracks/<id>/ so the game can fetch them at runtime
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative, sep } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { listTracks, TRACK_ID_RE } from './track-list.ts';

const VIRTUAL_ID = 'virtual:tracks';
const RESOLVED_VIRTUAL_ID = '\0' + VIRTUAL_ID;
/** Config files the tuning panel may overwrite. */
const TUNING_FILES = new Set(['physics', 'surfaces', 'rules', 'vfx', 'audio', 'ai', 'contact', 'race', 'slipstream', 'assists', 'damage', 'ers', 'evolution']);

/**
 * Read a POST body from the dev UI. The custom header makes the request non-simple, so other
 * sites open in the browser can't POST here cross-origin while the dev server runs.
 */
function readDevPost(req: IncomingMessage, res: ServerResponse, header: string, onBody: (body: string) => void): void {
  if (req.method !== 'POST' || req.headers[header] !== '1') {
    res.statusCode = 400;
    res.end('bad request');
    return;
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c: string) => (body += c));
  req.on('end', () => {
    try {
      onBody(body);
    } catch (e) {
      res.statusCode = 400;
      res.end(String(e));
    }
  });
}

export function trackPlugin(): Plugin {
  let root = process.cwd();
  const tracksDir = (): string => join(root, 'tracks');
  let knownIds = '';

  /** "tracks/<id>/<file>.png" -> { id, file } */
  const parse = (abs: string): { id: string; file: string } | undefined => {
    const rel = relative(tracksDir(), abs).split(sep);
    if (rel.length !== 2 || rel[0] === '..' || !rel[1]!.toLowerCase().endsWith('.png')) return undefined;
    return { id: rel[0]!, file: rel[1]! };
  };

  const refreshList = (server: ViteDevServer): void => {
    const ids = JSON.stringify(listTracks(tracksDir()));
    if (ids === knownIds) return;
    knownIds = ids;
    const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID);
    if (mod) {
      server.moduleGraph.invalidateModule(mod);
      server.ws.send({ type: 'full-reload' });
    }
  };

  return {
    name: 'javascript-racing-tracks',
    configResolved(config) {
      root = config.root;
    },

    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return undefined;
      const list = listTracks(tracksDir());
      knownIds = JSON.stringify(list);
      return `export default ${knownIds};`;
    },

    configureServer(server) {
      server.watcher.add(tracksDir());
      const notify = (abs: string): void => {
        const hit = parse(abs);
        if (hit) server.ws.send({ type: 'custom', event: 'track:file-changed', data: hit });
        if (relative(tracksDir(), abs).split(sep)[0] !== '..') refreshList(server);
      };
      server.watcher.on('add', notify);
      server.watcher.on('change', notify);
      server.watcher.on('unlink', notify); // deleting mask.png falls back to the draft

      server.middlewares.use('/__editor/save-track/', (req, res) => {
        const id = (req.url ?? '').replace(/^\//, '').split('?')[0]!;
        if (!TRACK_ID_RE.test(id) || !existsSync(join(tracksDir(), id))) {
          res.statusCode = 400;
          res.end('unknown track');
          return;
        }
        readDevPost(req, res, 'x-track-editor', (body) => {
          const parsed = JSON.parse(body) as { id?: unknown };
          if (parsed.id !== id) throw new Error(`track.json id "${String(parsed.id)}" doesn't match ${id}`);
          writeFileSync(join(tracksDir(), id, 'track.json'), body);
          res.end('saved');
        });
      });

      server.middlewares.use('/__tuning/save/', (req, res) => {
        const name = (req.url ?? '').replace(/^\//, '').split('?')[0]!;
        if (!TUNING_FILES.has(name)) {
          res.statusCode = 400;
          res.end('not a tunable config file');
          return;
        }
        readDevPost(req, res, 'x-tuning-panel', (body) => {
          JSON.parse(body); // refuse anything that isn't JSON
          writeFileSync(join(root, 'config', `${name}.json`), body);
          res.end('saved');
        });
      });
    },

    // Track PNGs are fetched at runtime, not imported; never let a change to one reload the page.
    // Config JSON saved from the tuning panel already matches the live values: don't reload either.
    handleHotUpdate(ctx) {
      if (parse(ctx.file)) return [];
      const rel = relative(join(root, 'config'), ctx.file).split(sep);
      if (rel.length === 1 && TUNING_FILES.has(rel[0]!.replace(/\.json$/, ''))) return [];
      return undefined;
    },

    generateBundle() {
      if (!existsSync(tracksDir())) return;
      for (const id of readdirSync(tracksDir())) {
        if (!TRACK_ID_RE.test(id)) continue;
        for (const file of readdirSync(join(tracksDir(), id))) {
          if (!file.toLowerCase().endsWith('.png')) continue;
          this.emitFile({ type: 'asset', fileName: `tracks/${id}/${file}`, source: readFileSync(join(tracksDir(), id, file)) });
        }
      }
    },
  };
}
