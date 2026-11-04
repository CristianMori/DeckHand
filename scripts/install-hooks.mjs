#!/usr/bin/env node
/**
 * Point git at the repo's own hooks (.githooks/pre-commit runs the secret
 * scan). Runs as npm's prepare step; outside a git checkout — a hub installing
 * a release tarball, CI on an export — it quietly does nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

try {
  if (!existsSync('.git') || !existsSync('.githooks')) process.exit(0);
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  console.log('[hooks] core.hooksPath -> .githooks (pre-commit secret scan)');
} catch {
  // no git on PATH: nothing to set up
}
