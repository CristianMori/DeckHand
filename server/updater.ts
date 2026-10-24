import { spawn, execFile } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { DATA_DIR, HUB_ROOT } from './config.js';
import type { Federation } from './federation.js';
import type { VersionInfo } from './version.js';

const CHECK_INTERVAL_MS = 6 * 3600_000;
/** how often a hub looks at the fleet target (UPDATE ALL) */
const TARGET_INTERVAL_MS = 10 * 60_000;
/** which fleet machine hosts releases */
export const UPDATE_MACHINE = process.env.HUB_UPDATE_MACHINE || 'vps-node';
/** UPDATE ALL's mark, next to the releases on the release machine */
export const FLEET_TARGET_FILE = 'fleet-target.json';

/** "everyone should be on at least this build" — left by UPDATE ALL */
export interface FleetTarget {
  build: number;
  version: string;
  requestedAt: string;
  requestedBy: string;
}

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
  fleetTarget?: FleetTarget;
  /** a verified release already downloaded here: updating needs no release machine */
  staged?: { build: number; version: string; bytes: number; at: string };
  staging?: boolean;
}

/** prestaged release: data/update-staged.tgz with its build beside it */
const STAGED_TGZ = join(DATA_DIR, 'update-staged.tgz');
const STAGED_META = join(DATA_DIR, 'update-staged.json');

function readStaged(): UpdateStatus['staged'] {
  try {
    return existsSync(STAGED_TGZ) && existsSync(STAGED_META) ? JSON.parse(readFileSync(STAGED_META, 'utf8')) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The archive is whole: it gunzips to the end and the gzip checksum holds.
 * Node's own zlib, not tar: which tar a machine finds first varies, and GNU
 * tar reads "C:\..." as a remote host.
 */
async function gzipIsWhole(file: string): Promise<boolean> {
  try {
    await pipeline(createReadStream(file), createGunzip(), new Writable({ write: (_c, _e, cb) => cb() }));
    return true;
  } catch {
    return false;
  }
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
  /** runs before a self-started update (UPDATE ALL catch-up): remember live sessions */
  beforeApply?: () => void;

  constructor(
    private current: VersionInfo,
    private federation: Federation,
    /** self identity — the release origin serves updates to itself locally */
    private self: { name: () => string; baseUrl: () => string },
  ) {
    this.status = { ...current, updateAvailable: false, updating: false, staged: readStaged() };
    if (this.status.staged && !(this.status.staged.build > current.build)) this.status.staged = undefined; // already installed
    const timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    timer.unref();
    setTimeout(() => void this.check().then(() => this.followFleetTarget()), 90_000).unref(); // after discovery settles
    // a machine that was off when UPDATE ALL ran catches up on its own
    setInterval(() => void this.followFleetTarget(), TARGET_INTERVAL_MS).unref();
  }

  /** Read UPDATE ALL's mark; update this hub when it is behind it. */
  async followFleetTarget(): Promise<void> {
    const base = this.releaseBase();
    if (!base || this.status.updating) return;
    try {
      const res = await fetch(`${base}/releases/${FLEET_TARGET_FILE}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return; // no UPDATE ALL yet
      const target = (await res.json()) as FleetTarget;
      this.status.fleetTarget = target;
      // dev trees (build 0) never auto-update
      if (this.current.build === 0 || !(target.build > this.current.build)) return;
      console.log(`[updater] fleet target is build ${target.build} (UPDATE ALL by ${target.requestedBy} at ${target.requestedAt}); this hub is on ${this.current.build}: updating`);
      this.beforeApply?.();
      await this.apply();
    } catch (err) {
      this.status.updating = false;
      this.status.error = `fleet target: ${err instanceof Error ? err.message : err}`;
    }
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
    // prestage in the background: a later update needs no release machine
    if (this.status.updateAvailable) void this.prestage().catch(() => {});
    return this.status;
  }

  private stagingRun?: Promise<void>;

  /**
   * Download the newest release next to the hub and verify it, unless that
   * build is already staged. Updating then works while the release machine
   * is away (restarting for its own update, say).
   */
  prestage(): Promise<void> {
    this.stagingRun ??= (async () => {
      const want = this.status.latestBuild;
      if (!want || !this.status.updateAvailable) return;
      if (this.status.staged?.build === want) return;
      const base = this.releaseBase();
      if (!base) throw new Error('release machine not connected');
      this.status.staging = true;
      const part = `${STAGED_TGZ}.part`;
      try {
        const res = await fetch(`${base}/releases/deckhand-release.tgz`, { signal: AbortSignal.timeout(10 * 60_000) });
        if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
        const bytes = (await stat(part)).size;
        const expected = Number(res.headers.get('content-length'));
        if (expected && bytes !== expected) throw new Error(`download cut short (${bytes} of ${expected} bytes)`);
        if (!(await gzipIsWhole(part))) throw new Error('downloaded release is not a whole archive');
        await rename(part, STAGED_TGZ);
        const staged = { build: want, version: this.status.latestVersion ?? '', bytes, at: new Date().toISOString() };
        await writeFile(STAGED_META, JSON.stringify(staged));
        this.status.staged = staged;
        console.log(`[updater] staged build ${want} (${Math.round(bytes / 1024)} KB)`);
      } catch (err) {
        await rm(part, { force: true }).catch(() => {});
        this.status.error = `staging: ${err instanceof Error ? err.message : err}`;
        throw err;
      } finally {
        this.status.staging = false;
      }
    })().finally(() => (this.stagingRun = undefined));
    return this.stagingRun;
  }

  /** Check, then wait until the newest build is staged here. */
  async checkAndStage(): Promise<UpdateStatus> {
    await this.check();
    if (this.status.updateAvailable) await this.prestage().catch(() => {});
    return this.status;
  }

  async apply(): Promise<void> {
    if (this.status.updating) return;
    await this.check();
    // the newest build, staged now if it is not yet (and the release machine answers)
    if (this.status.updateAvailable) await this.prestage().catch(() => {});
    const staged = this.status.staged;
    // whatever is staged and newer than this hub will do when the release machine is away
    if (!staged || !(staged.build > this.current.build) || this.current.build === 0) {
      throw new Error(this.status.error ?? 'no update available');
    }

    this.status.updating = true;
    const tgz = STAGED_TGZ;
    console.log(`[updater] installing staged build ${staged.build}`);

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
          // Windows' own bsdtar: a GNU tar earlier on PATH (Git's) reads "C:\..." as a remote host
          `"%SystemRoot%\\System32\\tar.exe" -xzf "${tgz}" -C "${HUB_ROOT}"`,
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
      // extraction over a running node process is safe on Linux and macOS
      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['-xzf', tgz, '-C', HUB_ROOT], (err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve) => {
        execFile('npm', ['install', '--no-audit', '--no-fund'], { cwd: HUB_ROOT }, () => resolve());
      });
      console.log('[updater] extracted, exiting for the supervisor (systemd/launchd) to relaunch');
      setTimeout(() => process.exit(1), 400); // non-zero → systemd Restart=on-failure / launchd KeepAlive fires
    }
  }
}

export async function ensureReleasesDir(): Promise<string> {
  const dir = join(DATA_DIR, 'releases');
  await mkdir(dir, { recursive: true });
  return dir;
}
