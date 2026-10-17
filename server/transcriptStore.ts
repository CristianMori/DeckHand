import { readdir, stat, mkdir, writeFile, utimes, readFile, open, copyFile, appendFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { DEFAULT_AGENT, getAgent, listAgents } from './agents/index.js';
import { DATA_DIR, PROJECTS_ROOT } from './config.js';
import { readTail } from './transcriptIo.js';
import type { TranscriptRef } from './agents/types.js';
import type { Federation } from './federation.js';

const gzipAsync = promisify(gzip);

/** which fleet machine keeps the durable conversation store */
export const STORE_MACHINE = process.env.HUB_STORE_MACHINE || 'vps-node';
export const STORE_DIR = join(DATA_DIR, 'transcripts');

const PUSH_INTERVAL_MS = 90_000;
/** a transcript whose session is alive is pushed at most this often */
const LIVE_PUSH_INTERVAL_MS = 10 * 60_000;
/** idle/exit nudges are debounced this long so a burst of changes is one push */
const NUDGE_DELAY_MS = 5_000;
/** compressed bytes one sweep may put on the wire (HUB_TSTORE_SWEEP_MB overrides) */
const MAX_SWEEP_BYTES = (Number(process.env.HUB_TSTORE_SWEEP_MB) || 32) * 1024 * 1024;

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


// ------------------------------------------------------------ delta uploads

export interface StoreMeta {
  exists: boolean;
  size: number;
  mtime: number;
  /** sha256 of the whole stored file (hex) — empty when absent */
  sha256: string;
}

/** sha256 of the first `limit` bytes of a file (whole file when omitted). */
export async function sha256File(path: string, limit?: number): Promise<string> {
  const h = createHash('sha256');
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let left = limit ?? Number.POSITIVE_INFINITY;
    while (left > 0) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, left), null);
      if (bytesRead === 0) break;
      h.update(buf.subarray(0, bytesRead));
      left -= bytesRead;
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

// hashing a 200 MB file per request is the expensive part — cache per size+mtime
const metaCache = new Map<string, StoreMeta>();

export async function storeMeta(folder: string, id: string, agentType = DEFAULT_AGENT): Promise<StoreMeta> {
  const path = storeFilePath(folder, id, agentType);
  if (!existsSync(path)) return { exists: false, size: 0, mtime: 0, sha256: '' };
  const s = await stat(path);
  const cached = metaCache.get(path);
  if (cached && cached.size === s.size && cached.mtime === s.mtimeMs) return cached;
  const meta = { exists: true, size: s.size, mtime: s.mtimeMs, sha256: await sha256File(path) };
  metaCache.set(path, meta);
  return meta;
}

export interface UploadSpec {
  /** byte offset the body continues from; 0 = whole file */
  offset: number;
  /** total size of the source file after this upload */
  size: number;
  /** sha256 (hex) of the whole source file */
  sha256: string;
  mtime: number;
  body: Buffer;
}

export type UploadResult =
  | { stored: true; size: number }
  | { stored: false; reason: 'unchanged' | 'store-newer' | 'offset-mismatch' | 'hash-mismatch' | 'size-mismatch'; size: number };

/**
 * Accept a whole-file or append-only delta upload. The result is always built
 * in a temp file and verified (size + sha256 of the whole thing) before it
 * replaces the stored copy, so a stored transcript is either the previous
 * version or byte-identical to the source — never a truncated or mixed one.
 */
export async function applyUpload(folder: string, id: string, agentType: string | undefined, u: UploadSpec): Promise<UploadResult> {
  const agent = agentType ?? DEFAULT_AGENT;
  const path = storeFilePath(folder, id, agent);
  const cur = existsSync(path) ? await stat(path) : null;
  if (cur) {
    if (cur.size === u.size && cur.mtimeMs >= u.mtime) return { stored: false, reason: 'unchanged', size: cur.size };
    if (cur.mtimeMs > u.mtime + 1000) return { stored: false, reason: 'store-newer', size: cur.size };
  }
  if (u.offset > 0 && (!cur || cur.size !== u.offset)) {
    return { stored: false, reason: 'offset-mismatch', size: cur?.size ?? 0 };
  }
  if (u.offset + u.body.length !== u.size) return { stored: false, reason: 'size-mismatch', size: cur?.size ?? 0 };

  await mkdir(join(STORE_DIR, safeName(folder)), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  try {
    if (u.offset > 0) {
      await copyFile(path, tmp);
      await appendFile(tmp, u.body);
    } else {
      await writeFile(tmp, u.body);
    }
    const got = await stat(tmp);
    if (got.size !== u.size) return { stored: false, reason: 'size-mismatch', size: cur?.size ?? 0 };
    if ((await sha256File(tmp)) !== u.sha256) return { stored: false, reason: 'hash-mismatch', size: cur?.size ?? 0 };
    await utimes(tmp, new Date(u.mtime), new Date(u.mtime));
    await rename(tmp, path);
    metaCache.set(path, { exists: true, size: u.size, mtime: (await stat(path)).mtimeMs, sha256: u.sha256 });
    return { stored: true, size: u.size };
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
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
 *
 * Transcripts are append-only and a live one grows on every tool call, so the
 * pusher sends only the bytes the store does not have yet (gzipped), verified
 * end to end by size + sha256, with a whole-file upload as the fallback. A
 * transcript whose session is alive is pushed at most every
 * LIVE_PUSH_INTERVAL_MS and right away when the session goes idle or exits;
 * each sweep sends at most MAX_SWEEP_BYTES so a backlog cannot saturate the
 * uplink. A store that predates delta uploads still gets whole files.
 */
export class TranscriptPusher {
  /** path -> mtime already pushed */
  private pushed = new Map<string, number>();
  /** path -> when it was last pushed (live-session gate) */
  private lastPushAt = new Map<string, number>();
  /** conversation ids whose next push should not wait for the live gate */
  private nudged = new Set<string>();
  /** store base url -> supports delta uploads */
  private delta = new Map<string, boolean>();
  private seeded = false;
  private sweeping = false;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  readonly log: (msg: string) => void;

  constructor(
    private federation: Pick<Federation, 'peerByMachine'>,
    private self: { name: () => string; baseUrl: () => string },
    private opts: { isLive?: (sessionId: string) => boolean; log?: (msg: string) => void } = {},
  ) {
    this.log = opts.log ?? ((m) => console.log(`[tstore] ${m}`));
    const timer = setInterval(() => void this.sweep(), PUSH_INTERVAL_MS);
    timer.unref();
    setTimeout(() => void this.sweep(), 30_000).unref();
  }

  /** A session went idle or exited: push its transcript soon, live gate or not. */
  nudge(sessionId: string) {
    this.nudged.add(sessionId);
    if (this.nudgeTimer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      void this.sweep();
    }, NUDGE_DELAY_MS);
    this.nudgeTimer.unref();
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

  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.sweepOnce();
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOnce() {
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

    let budget = MAX_SWEEP_BYTES;
    const now = Date.now();
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
          if ((this.pushed.get(ref.path) ?? 0) >= ref.mtime) continue;
          const live = !this.nudged.has(ref.sessionId) && (this.opts.isLive?.(ref.sessionId) ?? false);
          if (live && now - (this.lastPushAt.get(ref.path) ?? 0) < LIVE_PUSH_INTERVAL_MS) continue;
          if (budget <= 0) {
            this.log(`sweep budget spent; the rest waits for the next sweep`);
            return;
          }
          try {
            const sent = await this.pushFile(base, folder, agent.id, ref);
            budget -= sent;
            this.lastPushAt.set(ref.path, Date.now());
            this.nudged.delete(ref.sessionId);
          } catch (err) {
            this.log(`push failed for ${folder}/${ref.sessionId.slice(0, 8)}: ${String(err).slice(0, 120)} — next sweep retries`);
          }
        }
      }
    }
  }

  private async supportsDelta(base: string): Promise<boolean> {
    const known = this.delta.get(base);
    if (known !== undefined) return known;
    const res = await fetch(`${base}/api/tstore/_probe/_probe/meta`, { signal: AbortSignal.timeout(15_000) });
    const ok = res.ok; // an old store has no meta route and answers 404
    this.delta.set(base, ok);
    if (!ok) this.log(`store at ${base} predates delta uploads — sending whole files`);
    return ok;
  }

  /**
   * Push one transcript. Returns the number of bytes put on the wire. Marks the
   * file as pushed when the store confirms it holds this version (or a newer one).
   */
  async pushFile(base: string, folder: string, agentId: string, ref: TranscriptRef): Promise<number> {
    const url =
      `${base}/api/tstore/${encodeURIComponent(folder)}/${encodeURIComponent(ref.sessionId)}` +
      `?mtime=${Math.round(ref.mtime)}&agent=${encodeURIComponent(agentId)}`;

    if (!(await this.supportsDelta(base))) {
      const body = await readFile(ref.path);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) this.pushed.set(ref.path, ref.mtime);
      return body.length;
    }

    const metaRes = await fetch(`${url.replace('?', '/meta?')}`, { signal: AbortSignal.timeout(15_000) });
    if (!metaRes.ok) throw new Error(`meta ${metaRes.status}`);
    const meta = (await metaRes.json()) as StoreMeta;

    // snapshot the source: hash exactly `size` bytes even if the file keeps growing
    const size = (await stat(ref.path)).size;
    let offset = 0;
    if (meta.exists && meta.size > 0 && meta.size <= size) {
      if ((await sha256File(ref.path, meta.size)) === meta.sha256) offset = meta.size;
    }
    if (offset === size) {
      // store already holds these exact bytes (mtime-only change) — nothing to send
      this.pushed.set(ref.path, ref.mtime);
      return 0;
    }

    let sent = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { body, sha256 } = await readSlice(ref.path, offset, size);
      const gz = await gzipAsync(body);
      sent += gz.length;
      const res = await fetch(`${url}&offset=${offset}&size=${size}&sha256=${sha256}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' },
        body: gz,
        signal: AbortSignal.timeout(120_000),
      });
      const out = (await res.json().catch(() => ({}))) as { stored?: boolean; reason?: string };
      if (res.ok) {
        this.pushed.set(ref.path, ref.mtime);
        const kind = offset > 0 ? `delta +${body.length}` : `full ${body.length}`;
        this.log(`${folder}/${ref.sessionId.slice(0, 8)}: ${kind} bytes (${gz.length} on the wire) → ${out.stored ? 'stored' : `kept (${out.reason})`}`);
        return sent;
      }
      if (res.status === 409 && offset > 0) {
        // the store's copy is not our prefix after all — send the whole file once
        this.log(`${folder}/${ref.sessionId.slice(0, 8)}: ${out.reason} on delta — falling back to a whole-file upload`);
        offset = 0;
        continue;
      }
      throw new Error(`store answered ${res.status} ${out.reason ?? ''}`);
    }
    return sent;
  }
}

/** Bytes [offset, size) of a file plus the sha256 of its first `size` bytes, in one pass. */
async function readSlice(path: string, offset: number, size: number): Promise<{ body: Buffer; sha256: string }> {
  const h = createHash('sha256');
  const chunks: Buffer[] = [];
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let pos = 0;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (bytesRead === 0) throw new Error('file shrank while reading');
      const part = buf.subarray(0, bytesRead);
      h.update(part);
      if (pos + bytesRead > offset) chunks.push(Buffer.from(part.subarray(Math.max(0, offset - pos))));
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return { body: Buffer.concat(chunks), sha256: h.digest('hex') };
}
