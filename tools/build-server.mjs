// npm run build:server (card 08): the multiplayer server as ONE file, dist-server/server.mjs, built here so
// nothing builds on the 0.5 GB box. Dependencies and /config are bundled in; /tracks ships next to it
// (dist-server/../tracks, where the track loader looks). Run it with plain `node dist-server/server.mjs`.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-server');
rmSync(out, { recursive: true, force: true });
const result = await build({
  entryPoints: [join(root, 'src/server/serve.ts')],
  outfile: join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // Some bundled dependencies are CommonJS and call require(): give the ES module one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  // Optional native speed-ups: the libraries fall back to plain JS without them.
  external: ['bufferutil', 'utf-8-validate', 'msgpackr-extract'],
  logLevel: 'warning',
  metafile: true,
});
// What this build is, for /health (deploy:server checks the box runs it).
const git = (c) => { try { return execSync(`git ${c}`, { cwd: root, encoding: 'utf8' }).trim(); } catch { return ''; } };
const commit = (git('rev-parse --short HEAD') || 'unknown') + (git('status --porcelain --untracked-files=no -- src config tracks') ? '-dirty' : '');
writeFileSync(join(out, 'release.json'), JSON.stringify({ commit, builtAt: new Date().toISOString() }) + '\n');
const bytes = Object.values(result.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
console.info(`[build:server] dist-server/server.mjs ${commit} (${(bytes / 1024 / 1024).toFixed(1)} MB with source map)`);
