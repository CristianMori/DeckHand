import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { DATA_DIR, HUB_ROOT } from './config.js';
import type { Federation } from './federation.js';
import type { VersionInfo } from './version.js';

const CHECK_INTERVAL_MS = 6 * 3600_000;
/** which fleet machine hosts releases */
const UPDATE_MACHINE = process.env.HUB_UPDATE_MACHINE || 'vps-node';

export interface UpdateStatus {
  version: string;
  build: number;
  builtAt?: string;
  latestBuild?: number;
  latestVersion?: string;
  updateAvailable: boolean;
  updating: boolean;
  lastCheckAt?: number;
  error?: string;
}

/**
 * Fleet auto-update. vps-node is the release origin: publish uploads a tgz +
 * version.json into its data/releases, every hub compares builds against it.
 * Applying: Windows hands off to a detached runner script (native modules are
 * locked while the hub runs); Linux extracts in-process and exits non-zero so
 * systemd relaunches with the new code.
 */
export class Updater {
  status: UpdateStatus;

  constructor(
    private current: VersionInfo,
    private federation: Federation,
    /** self identity — the release origin serves updates to itself locally */
    private self: { name: () => string; baseUrl: () => string },
  ) {
    this.status = { ...current, updateAvailable: false, updating: false };
    const timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    timer.unref();
    setTimeout(() => void this.check(), 90_000).unref(); // after discovery settles
  }

  private releaseBase(): string | null {
    if (this.self.name() === UPDATE_MACHINE) return this.self.baseUrl();
    const peer = this.federation.peerByMachine(UPDATE_MACHINE);
    return peer ? peer.info.url : null;
  }

  async check(): Promise<UpdateStatus> {
    const base = this.releaseBase();
    if (!base) {
      this.status.error = `release machine ${UPDATE_MACHINE} not connected`;
      return this.status;
    }
    try {
      const res = await fetch(`${base}/releases/version.json`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) {
        this.status.error = 'no release published yet';
        this.status.lastCheckAt = Date.now();
        return this.status;
      }
      if (!res.ok) throw new Error(`release check: ${res.status}`);
      const latest = (await res.json()) as VersionInfo;
      this.status.latestBuild = latest.build;
      this.status.latestVersion = latest.version;
      // dev trees (build 0) never auto-update — don't clobber work in progress
      this.status.updateAvailable = this.current.build > 0 && latest.build > this.current.build;
      this.status.lastCheckAt = Date.now();
      this.status.error = undefined;
    } catch (err) {
      this.status.error = err instanceof Error ? err.message : String(err);
    }
    return this.status;
  }

  async apply(): Promise<void> {
    if (this.status.updating) return;
    await this.check();
    if (!this.status.updateAvailable) throw new Error(this.status.error ?? 'no update available');
    const base = this.releaseBase();
    if (!base) throw new Error('release machine not connected');

    this.status.updating = true;
    const tgz = join(DATA_DIR, 'update.tgz');
    const res = await fetch(`${base}/releases/deckhand-release.tgz`);
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tgz));

    if (process.platform === 'win32') {
      // under a service manager (DECKHAND_SERVICE set) the manager restarts
      // us — the runner only swaps files and must NOT start a second hub
      const runner = join(DATA_DIR, 'update-runner.cmd');
      await writeFile(
        runner,
        [
          '@echo off',
          'timeout /t 3 /nobreak >nul',
          `cd /d "${HUB_ROOT}"`,
          `tar -xzf "${tgz}" -C "${HUB_ROOT}"`,
          'call npm install --no-audit --no-fund >nul 2>&1',
          'if not defined DECKHAND_SERVICE if not defined CLAUDEHUB_SERVICE (',
          `  start "" "${join(HUB_ROOT, 'start-hub.cmd')}"`,
          ')',
          'exit',
        ].join('\r\n'),
      );
      const child = spawn('cmd.exe', ['/c', runner], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      console.log('[updater] handing off to runner, exiting');
      setTimeout(() => process.exit(0), 400);
    } else {
      // extraction over a running node process is safe on Linux
      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['-xzf', tgz, '-C', HUB_ROOT], (err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve) => {
        execFile('npm', ['install', '--no-audit', '--no-fund'], { cwd: HUB_ROOT }, () => resolve());
      });
      console.log('[updater] extracted, exiting for systemd relaunch');
      setTimeout(() => process.exit(1), 400); // non-zero → Restart=on-failure fires
    }
  }
}

export async function ensureReleasesDir(): Promise<string> {
  const dir = join(DATA_DIR, 'releases');
  await mkdir(dir, { recursive: true });
  return dir;
}
