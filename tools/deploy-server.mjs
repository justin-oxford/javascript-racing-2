// npm run deploy:server (card 08): build, copy, restart, check /health, print PASS or FAIL. One command.
//   npm run deploy:server                 deploy what's committed (warns about uncommitted server changes)
//   npm run deploy:server -- --setup      run server/setup.sh on the box first (fresh box, or setup changed)
//   npm run deploy:server -- --check      only check https://race.../health
// Box and key: server/deploy.json; DEPLOY_HOST / DEPLOY_KEY / DEPLOY_URL override it.
// Each deploy is a new folder in /opt/racing/releases; `current` points at it; the last 5 are kept. If the
// new one doesn't come up healthy, `current` goes back to the one before and the service restarts on it.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'server/deploy.json'), 'utf8'));
const host = process.env.DEPLOY_HOST ?? cfg.host;
const key = (process.env.DEPLOY_KEY ?? cfg.key).replace(/^~(?=[\\/])/, homedir());
const url = process.env.DEPLOY_URL ?? cfg.url;
const args = new Set(process.argv.slice(2));

const say = (s) => console.info(`[deploy] ${s}`);
const die = (s) => { console.error(`\n[deploy] FAIL: ${s}`); process.exit(1); };
const sshBase = ['-i', key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15'];
/** Run a command on the box (output shown). `input`: piped to its stdin. */
function ssh(cmd, input) {
  const r = spawnSync('ssh', [...sshBase, host, cmd], { stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], input });
  return r.status === 0;
}

async function health(expect, seconds) {
  const until = Date.now() + seconds * 1000;
  let last = '';
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      last = JSON.stringify(j);
      if (r.ok && j.ok && (!expect || j.release === expect)) return j;
    } catch (e) { last = String(e.cause?.code ?? e.message ?? e); }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { failed: last };
}

if (!existsSync(key)) die(`no SSH key at ${key} (server/deploy.json "key", or DEPLOY_KEY)`);

if (args.has('--check')) {
  const h = await health(undefined, 10);
  if (h.failed) die(`${url}/health: ${h.failed}`);
  say(`PASS ${url}/health ${JSON.stringify(h)}`);
  process.exit(0);
}

// 1. Box setup (first time, or after server/setup.sh changed).
if (args.has('--setup')) {
  say(`setup: server/setup.sh on ${host}`);
  if (!ssh('sudo bash -s', readFileSync(join(root, 'server/setup.sh'), 'utf8').replace(/\r\n/g, '\n'))) die('server/setup.sh failed (see above)');
}

// 2. Build here (nothing builds on the box).
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'config', 'tracks', 'package.json', 'package-lock.json'], { cwd: root, encoding: 'utf8' }).trim();
if (dirty) say(`warning: uncommitted changes go out with this deploy (marked -dirty on /health):\n${dirty}`);
say('build');
execFileSync(process.execPath, [join(root, 'tools/build-server.mjs')], { cwd: root, stdio: 'inherit' });
const release = JSON.parse(readFileSync(join(root, 'dist-server/release.json'), 'utf8')).commit;

// 3. Pack: the bundle + each committed track's data (track.json and the mask; the art stays on Pages).
const trackFiles = execFileSync('git', ['ls-files', 'tracks'], { cwd: root, encoding: 'utf8' }).split('\n').filter((f) => /^tracks\/[^/]+\/(track\.json|mask(-draft)?\.png)$/.test(f));
const tmp = mkdtempSync(join(tmpdir(), 'racing-deploy-'));
const list = join(tmp, 'files.txt'), tgz = join(tmp, 'release.tgz');
writeFileSync(list, ['dist-server/server.mjs', 'dist-server/server.mjs.map', 'dist-server/release.json', ...trackFiles].join('\n') + '\n');
// A relative archive name (run from the temp folder): GNU tar reads "C:\..." as a remote host.
execFileSync('tar', ['-czf', 'release.tgz', '-C', root, '-T', list], { cwd: tmp, stdio: 'inherit' });
say(`packed ${release}: server + ${trackFiles.length} track files`);

// 4. Copy + switch + restart.
const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${release}`;
const remoteTgz = `/tmp/racing-${id}.tgz`;
say(`upload to ${host}`);
const scp = spawnSync('scp', [...sshBase, tgz, `${host}:${remoteTgz}`], { stdio: 'inherit' });
rmSync(tmp, { recursive: true, force: true });
if (scp.status !== 0) die('upload failed');
const R = '/opt/racing/releases';
const switchCmd = [
  'set -e',
  `sudo test -f /etc/systemd/system/racing.service || { echo "the box isn't set up: npm run deploy:server -- --setup"; exit 3; }`,
  `PREV=$(readlink -f /opt/racing/current 2>/dev/null || true); echo "$PREV" | sudo tee ${R}/.previous >/dev/null`,
  `sudo install -d -o racing -g racing ${R}/${id}`,
  `sudo tar -xzf ${remoteTgz} -C ${R}/${id}`,
  `sudo chown -R racing:racing ${R}/${id}`,
  `rm -f ${remoteTgz}`,
  `sudo ln -sfn ${R}/${id} /opt/racing/current`,
  'sudo systemctl restart racing',
  // Keep the newest 5 releases (and whatever is current).
  `cd ${R} && ls -1dt */ | tail -n +6 | while read d; do [ "$(readlink -f /opt/racing/current)" = "${R}/\${d%/}" ] || sudo rm -rf "${R}/$d"; done`,
].join(' && ');
say(`switch to ${id}, restart`);
if (!ssh(switchCmd)) die('switching the release failed (see above)');

// 5. Health: the new release answering over HTTPS.
say(`waiting for ${url}/health to report ${release}`);
const h = await health(release, 45);
if (!h.failed) {
  say(`PASS ${url}/health ${JSON.stringify(h)}`);
  process.exit(0);
}
console.error(`[deploy] new release not healthy: ${h.failed}`);
ssh('sudo journalctl -u racing -n 40 --no-pager');
say('rolling back to the previous release');
ssh(`P=$(cat ${R}/.previous); if [ -n "$P" ] && [ -d "$P" ]; then sudo ln -sfn "$P" /opt/racing/current && sudo systemctl restart racing && echo "back on $P"; else echo "no previous release to go back to"; fi`);
die(`${release} did not come up (rolled back if there was a release before it)`);
