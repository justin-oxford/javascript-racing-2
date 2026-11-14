// npm "prepare" (runs on npm install / npm ci): point git at the versioned hooks in .githooks (pre-push runs
// typecheck, tests and build). Quietly does nothing outside a git checkout.
import { execFileSync } from 'node:child_process';
try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch {
  // not a git checkout (or no git): nothing to install
}
