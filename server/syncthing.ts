import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { DATA_DIR, PROJECTS_ROOT } from './config.js';

const SYNC_CONFIG = join(DATA_DIR, 'sync.json');

/** Ignore patterns written into every synced folder — heavy, regenerable dirs. */
const DEFAULT_IGNORES = [
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  '(?d).DS_Store',
  '(?d)Thumbs.db',
];

interface SyncEndpoint {
  url: string;
  apiKey: string;
  deviceId: string;
  folderRoot?: string;
}

export interface SyncConfig {
  local: SyncEndpoint;
  vps: SyncEndpoint;
}

interface StFolderDevice {
  deviceID: string;
}

interface StFolder {
  id: string;
  label?: string;
  path: string;
  devices: StFolderDevice[];
  [key: string]: unknown;
}

export function loadSyncConfig(): SyncConfig | null {
  if (!existsSync(SYNC_CONFIG)) return null;
  try {
    return JSON.parse(readFileSync(SYNC_CONFIG, 'utf8').replace(/^\uFEFF/, '')) as SyncConfig;
  } catch {
    return null;
  }
}

export function saveSyncConfig(cfg: SyncConfig) {
  writeFileSync(SYNC_CONFIG, JSON.stringify(cfg, null, 2));
}

async function rest<T>(
  ep: SyncEndpoint,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${ep.url}${path}`, {
    method,
    headers: {
      'X-API-Key': ep.apiKey,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`syncthing ${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Drives the local Syncthing and the VPS's over the tailnet. Folders are
 * registered on use — when a session first touches them — never in bulk.
 */
export class SyncManager {
  constructor(public cfg: SyncConfig) {}

  available(): boolean {
    return !!this.cfg;
  }

  /** Make local and VPS syncthings mutual devices (idempotent). */
  async ensurePaired(): Promise<void> {
    // on the VPS itself, local IS the vps syncthing — nothing to pair
    if (this.cfg.local.deviceId === this.cfg.vps.deviceId) return;
    const machine = hostname();
    const localDevices = await rest<{ deviceID: string }[]>(this.cfg.local, 'GET', '/rest/config/devices');
    if (!localDevices.some((d) => d.deviceID === this.cfg.vps.deviceId)) {
      await rest(this.cfg.local, 'POST', '/rest/config/devices', {
        deviceID: this.cfg.vps.deviceId,
        name: 'vps-node',
        addresses: ['tcp://vps-node:22000', 'dynamic'],
      });
    }
    const vpsDevices = await rest<{ deviceID: string }[]>(this.cfg.vps, 'GET', '/rest/config/devices');
    if (!vpsDevices.some((d) => d.deviceID === this.cfg.local.deviceId)) {
      await rest(this.cfg.vps, 'POST', '/rest/config/devices', {
        deviceID: this.cfg.local.deviceId,
        name: machine,
        addresses: ['dynamic'],
      });
    }
  }

  async localFolders(): Promise<StFolder[]> {
    return rest<StFolder[]>(this.cfg.local, 'GET', '/rest/config/folders');
  }

  async vpsFolders(): Promise<StFolder[]> {
    return rest<StFolder[]>(this.cfg.vps, 'GET', '/rest/config/folders');
  }

  /**
   * Register a project folder for syncing: local folder entry shared with the
   * VPS, VPS folder entry (path <folderRoot>/<id>, staggered versioning)
   * sharing back. Idempotent; used both for first-push and for pull-to-here.
   */
  /** Set ignore patterns through the API — reliable even before the first scan. */
  private async setIgnores(ep: SyncEndpoint, folderId: string): Promise<void> {
    await rest(ep, 'POST', `/rest/db/ignores?folder=${encodeURIComponent(folderId)}`, {
      ignore: DEFAULT_IGNORES,
    });
  }

  async registerFolder(folderId: string): Promise<void> {
    await this.ensurePaired();
    const localPath = join(PROJECTS_ROOT, folderId);
    // on the VPS local === vps; dedupe so syncthing never sees a device twice
    const shareDevices = [
      ...new Map(
        [{ deviceID: this.cfg.local.deviceId }, { deviceID: this.cfg.vps.deviceId }].map((d) => [
          d.deviceID,
          d,
        ]),
      ).values(),
    ];

    const locals = await this.localFolders();
    if (!locals.some((f) => f.id === folderId)) {
      // created paused so the ignore patterns land before the first scan —
      // otherwise node_modules etc. race into the initial sync
      await rest(this.cfg.local, 'POST', '/rest/config/folders', {
        id: folderId,
        label: folderId,
        path: localPath,
        type: 'sendreceive',
        fsWatcherEnabled: true,
        fsWatcherDelayS: 5,
        rescanIntervalS: 300,
        paused: true,
        devices: shareDevices,
      });
      await this.setIgnores(this.cfg.local, folderId);
      await rest(this.cfg.local, 'PATCH', `/rest/config/folders/${encodeURIComponent(folderId)}`, {
        paused: false,
      });
      this.writeIgnores(localPath);
    } else {
      // ensure the VPS is among the folder's devices
      const f = locals.find((x) => x.id === folderId)!;
      if (!f.devices.some((d) => d.deviceID === this.cfg.vps.deviceId)) {
        f.devices.push({ deviceID: this.cfg.vps.deviceId });
        await rest(this.cfg.local, 'PUT', `/rest/config/folders/${encodeURIComponent(folderId)}`, f);
      }
    }

    const vps = await this.vpsFolders();
    const vpsFolder = vps.find((f) => f.id === folderId);
    if (!vpsFolder) {
      await rest(this.cfg.vps, 'POST', '/rest/config/folders', {
        id: folderId,
        label: folderId,
        path: `${this.cfg.vps.folderRoot ?? '/srv/sync'}/${folderId}`,
        type: 'sendreceive',
        fsWatcherEnabled: true,
        rescanIntervalS: 300,
        devices: shareDevices,
        versioning: {
          type: 'staggered',
          params: { cleanInterval: '3600', maxAge: String(30 * 24 * 3600) },
        },
      });
      await this.setIgnores(this.cfg.vps, folderId).catch(() => {});
    } else if (!vpsFolder.devices.some((d) => d.deviceID === this.cfg.local.deviceId)) {
      vpsFolder.devices.push({ deviceID: this.cfg.local.deviceId });
      await rest(this.cfg.vps, 'PUT', `/rest/config/folders/${encodeURIComponent(folderId)}`, vpsFolder);
    }
  }

  private writeIgnores(folderPath: string) {
    try {
      const f = join(folderPath, '.stignore');
      if (!existsSync(f)) writeFileSync(f, DEFAULT_IGNORES.join('\n') + '\n');
    } catch {
      /* folder may not exist yet on pull — syncthing creates it */
    }
  }

  /**
   * Stop replicating a folder: drop its entry from the local Syncthing and
   * from the VPS (files stay on disk everywhere; Syncthing never deletes on
   * config removal). Used when a folder is frozen to this machine.
   */
  async unregisterFolder(folderId: string): Promise<void> {
    const id = encodeURIComponent(folderId);
    for (const ep of [this.cfg.local, this.cfg.vps]) {
      try {
        await rest(ep, 'DELETE', `/rest/config/folders/${id}`);
      } catch {
        /* not registered there */
      }
    }
  }

  /** This device's completion (0-100) for a folder — 100 means fully pulled. */
  async localCompletion(folderId: string): Promise<number> {
    const c = await rest<{ completion: number }>(
      this.cfg.local,
      'GET',
      `/rest/db/completion?folder=${encodeURIComponent(folderId)}`,
    );
    return c.completion;
  }

  /** The VPS's own completion for a folder — 100 means canonical copy is current. */
  async vpsCompletion(folderId: string): Promise<number> {
    const c = await rest<{ completion: number }>(
      this.cfg.vps,
      'GET',
      `/rest/db/completion?folder=${encodeURIComponent(folderId)}`,
    );
    return c.completion;
  }

  /** Folder ids the VPS holds — the fleet's canonical folder catalog. */
  async vpsCatalog(): Promise<string[]> {
    try {
      return (await this.vpsFolders()).map((f) => f.id);
    } catch {
      return [];
    }
  }
}

export function createSyncManager(): SyncManager | null {
  const cfg = loadSyncConfig();
  return cfg ? new SyncManager(cfg) : null;
}

function localSyncthingConfigPaths(): string[] {
  if (process.platform === 'win32') {
    return [
      join(process.env.LOCALAPPDATA ?? '', 'Syncthing', 'config.xml'),
      join(process.env.APPDATA ?? '', 'Syncthing', 'config.xml'),
    ];
  }
  const home = process.env.HOME ?? '';
  return [
    join(home, '.local', 'state', 'syncthing', 'config.xml'),
    join(home, '.config', 'syncthing', 'config.xml'),
  ];
}

/**
 * Zero-config path for new machines: read the local syncthing's API key from
 * its config.xml, ask it for its device ID, and learn the VPS endpoint from a
 * federation peer. Returns null (retryable) if any piece is missing.
 */
export async function bootstrapSyncConfig(
  getVpsEndpoint: () => Promise<SyncEndpoint | null>,
): Promise<SyncManager | null> {
  const existing = createSyncManager();
  if (existing) return existing;

  const cfgPath = localSyncthingConfigPaths().find((p) => p && existsSync(p));
  if (!cfgPath) return null;
  const apiKey = readFileSync(cfgPath, 'utf8').match(/<apikey>([^<]+)<\/apikey>/)?.[1];
  if (!apiKey) return null;

  const local: SyncEndpoint = { url: 'http://127.0.0.1:8384', apiKey, deviceId: '' };
  try {
    const status = await rest<{ myID: string }>(local, 'GET', '/rest/system/status');
    local.deviceId = status.myID;
  } catch {
    return null; // syncthing not running
  }

  const vps = await getVpsEndpoint();
  if (!vps) return null;

  const cfg: SyncConfig = { local, vps };
  saveSyncConfig(cfg);
  console.log('[sync] bootstrapped sync.json from local syncthing + fleet peer');
  return new SyncManager(cfg);
}
