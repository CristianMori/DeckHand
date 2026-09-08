import { readdir, stat, mkdir, writeFile, utimes, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_AGENT, getAgent, listAgents } from './agents/index.js';
import { DATA_DIR, PROJECTS_ROOT } from './config.js';
import { readTail } from './transcriptIo.js';
import type { Federation } from './federation.js';

/** which fleet machine keeps the durable conversation store */
export const STORE_MACHINE = process.env.HUB_STORE_MACHINE || 'vps-node';
export const STORE_DIR = join(DATA_DIR, 'transcripts');

const PUSH_INTERVAL_MS = 90_000;

export interface StoreEntry {
  folder: string;
  agentType: string;
  claudeSessionId: string;
  updatedAt: number;
  title?: string;
  lastText?: string;
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9-]/g, '');

/** Claude transcripts keep their historical `<id>.jsonl` name; other agents are prefixed. */
export function storeFilePath(folder: string, id: string, agentType = DEFAULT_AGENT): string {
  const base = agentType === DEFAULT_AGENT ? safeId(id) : `${safeName(agentType)}__${safeId(id)}`;
  return join(STORE_DIR, safeName(folder), `${base}.jsonl`);
}

function parseStoreName(file: string): { agentType: string; id: string } {
  const stem = file.slice(0, -6);
  const sep = stem.indexOf('__');
  return sep > 0 ? { agentType: stem.slice(0, sep), id: stem.slice(sep + 2) } : { agentType: DEFAULT_AGENT, id: stem };
}

/** Accept a pushed transcript; last-writer-wins by mtime, older pushes are dropped. */
export async function saveToStore(
  folder: string,
  id: string,
  body: Buffer,
  mtimeMs: number,
  agentType = DEFAULT_AGENT,
): Promise<{ stored: boolean }> {
  const path = storeFilePath(folder, id, agentType);
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
      const { agentType, id } = parseStoreName(f);
      const ops = getAgent(agentType).transcript;
      if (!ops) continue;
      try {
        const s = await stat(path);
        const key = path;
        let meta = tailCache.get(key);
        if (!meta || meta.mtime !== s.mtimeMs) {
          const parsed = ops.parseTail(await readTail(path));
          meta = { mtime: s.mtimeMs, title: parsed.title, lastText: parsed.lastText };
          tailCache.set(key, meta);
        }
        out.push({
          folder,
          agentType,
          claudeSessionId: id,
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
        const ops = getAgent(e.agentType).transcript;
        if (!ops) continue;
        this.pushed.set(ops.file(join(PROJECTS_ROOT, e.folder), e.claudeSessionId), e.updatedAt);
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
      for (const agent of listAgents()) {
        if (!agent.transcript) continue;
        let refs;
        try {
          refs = await agent.transcript.listFolder(join(PROJECTS_ROOT, folder));
        } catch {
          continue;
        }
        for (const ref of refs) {
          try {
            if ((this.pushed.get(ref.path) ?? 0) >= ref.mtime) continue;
            const body = await readFile(ref.path);
            const res = await fetch(
              `${base}/api/tstore/${encodeURIComponent(folder)}/${encodeURIComponent(ref.sessionId)}` +
                `?mtime=${Math.round(ref.mtime)}&agent=${encodeURIComponent(agent.id)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body,
                signal: AbortSignal.timeout(60_000),
              },
            );
            if (res.ok) this.pushed.set(ref.path, ref.mtime);
          } catch {
            /* transient — next sweep retries */
          }
        }
      }
    }
  }
}
