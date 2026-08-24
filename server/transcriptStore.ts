import { readdir, stat, mkdir, writeFile, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_PROJECTS_DIR, DATA_DIR, PROJECTS_ROOT, encodeProjectDir } from './config.js';
import { readTail, parseTranscriptTail } from './conversations.js';
import type { Federation } from './federation.js';

/** which fleet machine keeps the durable conversation store */
export const STORE_MACHINE = process.env.HUB_STORE_MACHINE || 'vps-node';
export const STORE_DIR = join(DATA_DIR, 'transcripts');

const PUSH_INTERVAL_MS = 90_000;

export interface StoreEntry {
  folder: string;
  claudeSessionId: string;
  updatedAt: number;
  title?: string;
  lastText?: string;
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');

export function storeFilePath(folder: string, id: string): string {
  return join(STORE_DIR, safeName(folder), `${id.replace(/[^a-zA-Z0-9-]/g, '')}.jsonl`);
}

/** Accept a pushed transcript; last-writer-wins by mtime, older pushes are dropped. */
export async function saveToStore(
  folder: string,
  id: string,
  body: Buffer,
  mtimeMs: number,
): Promise<{ stored: boolean }> {
  const path = storeFilePath(folder, id);
  if (existsSync(path)) {
    const cur = await stat(path);
    if (cur.mtimeMs >= mtimeMs) return { stored: false }; // we already have newer
  }
  await mkdir(join(STORE_DIR, safeName(folder)), { recursive: true });
  await writeFile(path, body);
  await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
  return { stored: true };
}

// tail parsing is the expensive part — cache per file+mtime
const tailCache = new Map<string, { mtime: number; title?: string; lastText?: string }>();

export async function storeCatalog(): Promise<StoreEntry[]> {
  const out: StoreEntry[] = [];
  let folders: string[];
  try {
    folders = await readdir(STORE_DIR);
  } catch {
    return out;
  }
  for (const folder of folders) {
    let files: string[];
    try {
      files = await readdir(join(STORE_DIR, folder));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(STORE_DIR, folder, f);
      try {
        const s = await stat(path);
        const key = path;
        let meta = tailCache.get(key);
        if (!meta || meta.mtime !== s.mtimeMs) {
          const parsed = parseTranscriptTail(await readTail(path));
          meta = { mtime: s.mtimeMs, title: parsed.title, lastText: parsed.lastText };
          tailCache.set(key, meta);
        }
        out.push({
          folder,
          claudeSessionId: f.slice(0, -6),
          updatedAt: s.mtimeMs,
          title: meta.title,
          lastText: meta.lastText,
        });
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out;
}

/**
 * Continuously replicates this machine's conversation transcripts to the
 * fleet store: every project folder's .jsonl files are pushed to STORE_MACHINE
 * whenever they change. Conversations become as durable and machine-independent
 * as synced folders — and survive Claude Code's local retention cleanup.
 */
export class TranscriptPusher {
  /** path -> mtime already pushed */
  private pushed = new Map<string, number>();
  private seeded = false;

  constructor(
    private federation: Federation,
    private self: { name: () => string; baseUrl: () => string },
  ) {
    const timer = setInterval(() => void this.sweep(), PUSH_INTERVAL_MS);
    timer.unref();
    setTimeout(() => void this.sweep(), 30_000).unref();
  }

  private storeBase(): string | null {
    if (this.self.name() === STORE_MACHINE) return this.self.baseUrl();
    const peer = this.federation.peerByMachine(STORE_MACHINE);
    return peer ? peer.info.url : null;
  }

  private async seed(base: string) {
    // learn what the store already holds so restarts don't re-upload everything
    try {
      const res = await fetch(`${base}/api/tstore`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return;
      const entries = (await res.json()) as StoreEntry[];
      for (const e of entries) {
        const local = join(
          CLAUDE_PROJECTS_DIR,
          encodeProjectDir(join(PROJECTS_ROOT, e.folder)),
          `${e.claudeSessionId}.jsonl`,
        );
        this.pushed.set(local, e.updatedAt);
      }
      this.seeded = true;
    } catch {
      /* retry next sweep */
    }
  }

  private async sweep() {
    const base = this.storeBase();
    if (!base) return;
    if (!this.seeded) await this.seed(base);

    let folders: string[];
    try {
      folders = (await readdir(PROJECTS_ROOT, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$'))
        .map((d) => d.name);
    } catch {
      return;
    }

    for (const folder of folders) {
      const dir = join(CLAUDE_PROJECTS_DIR, encodeProjectDir(join(PROJECTS_ROOT, folder)));
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const path = join(dir, f);
        try {
          const s = await stat(path);
          if (s.size === 0) continue;
          if ((this.pushed.get(path) ?? 0) >= s.mtimeMs) continue;
          const id = f.slice(0, -6);
          const { readFile } = await import('node:fs/promises');
          const body = await readFile(path);
          const res = await fetch(
            `${base}/api/tstore/${encodeURIComponent(folder)}/${encodeURIComponent(id)}?mtime=${Math.round(s.mtimeMs)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body,
              signal: AbortSignal.timeout(60_000),
            },
          );
          if (res.ok) this.pushed.set(path, s.mtimeMs);
        } catch {
          /* transient — next sweep retries */
        }
      }
    }
  }
}
