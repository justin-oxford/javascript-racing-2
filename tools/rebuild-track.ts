// Rebuild everything generated from a track's art + mask, in the Oxford redesign card's order. Run it after
// new art / mask land (Justin's files committed first, on their own).
// Usage: npm run rebuild-track -- <id> [--bump] [--skip-setup] [--reseed]
//   --reseed: start again from the start/finish line's arrow (its a -> b sets the direction of travel): new S1/S2 at lap
//   thirds, a new racing-line seed from the road's centre path, and the spawn pointed down the new direction. Flipping
//   a track's direction = swap timingLines.startFinish a and b in track.json, then this.
//   1. validate-track + art-mask-check (report only; writes reports/img/<id>-artmask.png)
//   2. track-fit (pit lane, boxes, grid, timing lines vs the mask), BEFORE regenerating
//   3. optimize-racing-line --write, optimize-exit-line --write, setup-search --laps 10 --write
//   4. --bump: track.json version + 1 (old lap records and ghosts are then kept apart / refused)
//   5. track-fit again + track-stats (layout numbers for the report)
// Stops at the first step that exits with an error, except the report-only ones.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatTrackJson } from '../src/client/editor/format.ts';
import { ROOT, TRACKS_DIR } from './load-track-node.ts';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
if (!id) { console.error('usage: npm run rebuild-track -- <id> [--bump] [--skip-setup] [--reseed]'); process.exit(1); }

const run = (title: string, tool: string, toolArgs: string[], mustPass: boolean) => {
  console.log(`\n=== ${title}: ${tool} ${toolArgs.join(' ')}`);
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'tools', tool), ...toolArgs], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0 && mustPass) { console.error(`\n${tool} failed (exit ${r.status}): stopping.`); process.exit(r.status ?? 1); }
  return r.status === 0;
};

mkdirSync(join(ROOT, 'reports', 'img'), { recursive: true });
run('1a. validate', 'validate-track.ts', [id], false);
run('1b. art vs mask', 'art-mask-check.ts', [id, '--png', join(ROOT, 'reports', 'img', `${id}-artmask.png`)], false);
run('2. fit, before regenerating', 'track-fit.ts', [id], false);
if (args.includes('--reseed')) {
  run('2b. sector lines at lap thirds', 'suggest-timing-lines.ts', [id, '--write'], true);
  run('2c. racing-line seed from the centre path', 'suggest-racing-line.ts', [id, '--write'], true);
  const path = join(TRACKS_DIR, id, 'track.json');
  const json = JSON.parse(readFileSync(path, 'utf8')) as { racingLineSeed?: unknown };
  delete json.racingLineSeed; // the optimizer seeds from the new line
  writeFileSync(path, formatTrackJson(json));
}
run('3a. racing line', 'optimize-racing-line.ts', [id, '--write'], true);
if (args.includes('--reseed')) {
  // The spawn (grid slot 1; the grid forms behind it) points the way the new line runs there.
  const path = join(TRACKS_DIR, id, 'track.json');
  const json = JSON.parse(readFileSync(path, 'utf8')) as { racingLine: Array<{ x: number; y: number }>; spawn: { x: number; y: number; heading: number } };
  const L = json.racingLine, n = L.length;
  let bi = 0, bd = Infinity;
  L.forEach((p, i) => { const d = (p.x - json.spawn.x) ** 2 + (p.y - json.spawn.y) ** 2; if (d < bd) { bd = d; bi = i; } });
  const a = L[bi]!, b = L[(bi + 3) % n]!;
  json.spawn = { ...json.spawn, heading: Math.atan2(b.x - a.x, -(b.y - a.y)) };
  writeFileSync(path, formatTrackJson(json));
  console.log(`  spawn heading set along the line: ${json.spawn.heading.toFixed(3)} rad`);
}
run('3b. EXIT line', 'optimize-exit-line.ts', [id, '--write'], true);
if (!args.includes('--skip-setup')) run('3c. base setup (10-lap stints)', 'setup-search.ts', ['--track', id, '--laps', '10', '--write'], true);
if (args.includes('--bump')) {
  const path = join(TRACKS_DIR, id, 'track.json');
  const text = readFileSync(path, 'utf8');
  const json = JSON.parse(text) as { version?: number };
  const next = (json.version ?? 1) + 1;
  // Keep the file's own formatting: insert / replace the "version" line after "name".
  const out = /"version":\s*\d+/.test(text) ? text.replace(/"version":\s*\d+/, `"version": ${next}`) : text.replace(/("name":\s*"[^"]*",)(\r?\n)/, `$1$2  "version": ${next},$2`);
  writeFileSync(path, out);
  console.log(`\n=== 4. ${id} layout version ${next - 1} -> ${next}`);
}
run('5a. fit, after', 'track-fit.ts', [id], false);
run('5b. layout numbers', 'track-stats.ts', [id], false);
