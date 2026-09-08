import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, type Dirent } from 'node:fs';
import { readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HUB_ROOT } from '../config.js';
import { normCwd } from '../transcriptIo.js';
import type { AgentAdapter, TranscriptRef, TranscriptTail } from './types.js';

/**
 * OpenAI Codex CLI. Discovered facts (codex-cli 0.153.x):
 *  - the conversation id is minted by Codex; the hub learns it from the
 *    SessionStart hook (session_id + cwd) and binds it to the pending card
 *  - hooks: ~/.codex/hooks.json, Claude-compatible schema and stdin payload;
 *    the hook must print JSON, so a node relay (hooks/codex-hook.mjs) is used
 *  - trust: hub-authored hooks run with --dangerously-bypass-hook-trust
 *  - transcripts: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl, indexed
 *    by the threads table of ~/.codex/state_*.sqlite (cwd, rollout_path, title,
 *    name, updated_at_ms). Read through node:sqlite when available.
 */

export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const SESSIONS_DIR = join(CODEX_HOME, 'sessions');
const HOOKS_FILE = join(CODEX_HOME, 'hooks.json');
const HOOK_SCRIPT = join(HUB_ROOT, 'hooks', 'codex-hook.mjs');
const HOOK_MARK = 'codex-hook.mjs';

// observed prompts: folder trust ("Do you trust the contents of this directory?"
// … "Press enter to continue") and command approval ("Would you like to run the
// following command?" … "1. Yes, proceed (y)"). Enter accepts both.
const OUTPUT_WAITING_REGEX = /Do you trust the contents|Press enter to continue|Would you like to run|Yes, proceed/;

function resolveExe(): string {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const out = execFileSync(probe, ['codex'], { encoding: 'utf8' }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (process.platform !== 'win32') {
      const p = out[0];
      if (p && existsSync(p)) return p;
    } else {
      // the npm shim is a .cmd (ConPTY can't run it directly) — find the vendored native binary
      const shim = out.find((l) => l.toLowerCase().endsWith('.cmd')) ?? out[0];
      if (shim) {
        const root = join(dirname(shim), 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
        for (const pkg of ['codex-win32-x64', 'codex-win32-arm64']) {
          for (const triple of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']) {
            const exe = join(root, pkg, 'vendor', triple, 'bin', 'codex.exe');
            if (existsSync(exe)) return exe;
          }
        }
      }
      // desktop-app install keeps a copy under LocalAppData
      const appBin = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
      try {
        for (const d of readdirSyncSafe(appBin)) {
          const exe = join(appBin, d, 'codex.exe');
          if (existsSync(exe)) return exe;
        }
      } catch {
        /* no desktop install */
      }
    }
  } catch {
    /* not on PATH */
  }
  return 'codex';
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const MODE_FLAGS: Record<string, string[]> = {
  'approve-for-me': ['--approve-for-me'],
  'read-only': ['-s', 'read-only'],
  'full-access': ['-s', 'danger-full-access'],
  bypass: ['--dangerously-bypass-approvals-and-sandbox'],
};

// ---------------------------------------------------------------- index

interface ThreadRow {
  id: string;
  rollout_path: string | null;
  cwd: string | null;
  title: string | null;
  name: string | null;
  first_user_message: string | null;
  updated_at_ms: number | null;
  archived: number | null;
}

let sqliteUnavailable = false;

/** Rows from the newest state_*.sqlite; empty when node:sqlite or the file is missing. */
async function threads(): Promise<ThreadRow[]> {
  if (sqliteUnavailable) return [];
  let dbFile: string | undefined;
  try {
    dbFile = (await readdir(CODEX_HOME))
      .filter((f) => /^state_\d+\.sqlite$/.test(f))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0];
  } catch {
    return [];
  }
  if (!dbFile) return [];
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as typeof import('node:sqlite');
    const db = new DatabaseSync(join(CODEX_HOME, dbFile), { readOnly: true });
    try {
      return db
        .prepare(
          'select id, rollout_path, cwd, title, name, first_user_message, updated_at_ms, archived from threads',
        )
        .all() as unknown as ThreadRow[];
    } finally {
      db.close();
    }
  } catch (err) {
    if (String(err).includes('ERR_UNKNOWN_BUILTIN_MODULE') || String(err).includes("Cannot find module 'node:sqlite'")) {
      sqliteUnavailable = true;
    }
    return [];
  }
}

function rowTitle(r: ThreadRow): string | undefined {
  return r.name || r.title || r.first_user_message || undefined;
}

async function refFromRow(r: ThreadRow): Promise<TranscriptRef | null> {
  if (!r.rollout_path || !existsSync(r.rollout_path)) return null;
  let mtime = r.updated_at_ms ?? 0;
  try {
    mtime = Math.max(mtime, (await stat(r.rollout_path)).mtimeMs);
  } catch {
    return null;
  }
  return { path: r.rollout_path, sessionId: r.id, mtime, title: rowTitle(r) };
}

/** Fallback without the index: every rollout file under sessions/. */
async function scanRollouts(): Promise<TranscriptRef[]> {
  const out: TranscriptRef[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
        const id = e.name.replace(/\.jsonl$/, '').split('-').slice(-5).join('-');
        try {
          out.push({ path: p, sessionId: id, mtime: (await stat(p)).mtimeMs });
        } catch {
          /* skip */
        }
      }
    }
  };
  await walk(SESSIONS_DIR, 0);
  return out;
}

const cwdOfRollout = new Map<string, string | undefined>();
async function rolloutCwd(path: string): Promise<string | undefined> {
  if (cwdOfRollout.has(path)) return cwdOfRollout.get(path);
  let cwd: string | undefined;
  try {
    const head = readFileSync(path, { encoding: 'utf8', flag: 'r' }).slice(0, 4000);
    cwd = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\\\/g, '\\');
  } catch {
    /* unreadable */
  }
  cwdOfRollout.set(path, cwd);
  return cwd;
}

// ------------------------------------------------------------- parsing

function parseTail(tail: string): TranscriptTail {
  const out: TranscriptTail = {};
  const cwdMatches = [...tail.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)];
  const lastCwd = cwdMatches[cwdMatches.length - 1]?.[1];
  if (lastCwd && !lastCwd.startsWith('file:')) out.cwd = lastCwd.replace(/\\\\/g, '\\');
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0 && !out.lastText; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      let text: string | undefined;
      if (obj.type === 'event_msg' && obj.payload?.type === 'task_complete') {
        text = obj.payload.last_agent_message;
      } else if (obj.type === 'response_item' && obj.payload?.type === 'message' && obj.payload.role === 'assistant') {
        text = assistantText(obj.payload.content);
      }
      text = text?.replace(/\s+/g, ' ').trim();
      if (text) out.lastText = text.length > 140 ? text.slice(0, 137) + '…' : text;
    } catch {
      /* partial first line of tail window */
    }
  }
  return out;
}

function assistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return (content as { type: string; text?: string }[])
    .filter((c) => c.type === 'output_text' && c.text)
    .map((c) => c.text)
    .join('\n');
}

/** Real user prompts only — Codex injects environment/skills context as user-role items. */
function userText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts = (content as { type: string; text?: string }[])
    .filter((c) => c.type === 'input_text' && c.text && !/^\s*</.test(c.text))
    .map((c) => c.text!);
  return parts.join('\n').trim();
}

function parseExchanges(full: string, n: number): { q: string; r: string }[] {
  const exchanges: { q: string; r: string }[] = [];
  const lines = full.split('\n');
  let replyParts: string[] = [];
  for (let i = lines.length - 1; i >= 0 && exchanges.length < n; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: { type?: string; payload?: { type?: string; role?: string; content?: unknown; phase?: string } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== 'response_item' || obj.payload?.type !== 'message') continue;
    if (obj.payload.role === 'assistant') {
      const text = assistantText(obj.payload.content);
      if (text) replyParts.unshift(text);
    } else if (obj.payload.role === 'user') {
      const q = userText(obj.payload.content);
      if (q && replyParts.length) {
        exchanges.unshift({ q, r: replyParts.join('\n\n') });
        replyParts = [];
      }
    }
  }
  return exchanges;
}

// -------------------------------------------------------------- adapter

/**
 * Codex asks "Do you trust the contents of this directory?" the first time it
 * runs in a folder and records the answer in config.toml. A -c override does
 * not satisfy it (verified), so the hub records the same answer up front for
 * folders it launches into — exactly what pressing "Yes, continue" would do.
 */
function ensureTrusted(cwd: string) {
  const file = join(CODEX_HOME, 'config.toml');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    /* no config yet */
  }
  const want = normCwd(cwd);
  const trusted = [...text.matchAll(/^\[projects\.(?:'([^']*)'|"([^"]*)")\]/gm)].some(
    (m) => normCwd((m[1] ?? m[2] ?? '').replace(/\\\\/g, '\\')) === want,
  );
  if (trusted) return;
  const key = cwd.replace(/'/g, '');
  const block = `\n[projects.'${key}']\ntrust_level = "trusted"\n`;
  mkdirSync(CODEX_HOME, { recursive: true });
  writeFileSync(file, (text.endsWith('\n') || !text ? text : text + '\n') + block);
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  label: 'Codex',
  clientChosenId: false,
  resolveExe,
  available: () => resolveExe() !== 'codex',
  beforeSpawn: (cwd) => {
    try {
      ensureTrusted(cwd);
    } catch {
      /* the trust prompt then appears; the waiting regex catches it */
    }
  },

  buildArgs({ sessionId, resume, cwd, model, permissionMode, initialPrompt }) {
    const args: string[] = [];
    if (resume) args.push('resume', sessionId);
    args.push('--dangerously-bypass-hook-trust', '-C', cwd);
    if (permissionMode && MODE_FLAGS[permissionMode]) args.push(...MODE_FLAGS[permissionMode]);
    if (model) args.push('-m', model);
    if (initialPrompt) args.push(initialPrompt);
    return args;
  },

  /** Hub-owned entries in ~/.codex/hooks.json; anything of the user's is kept. */
  writeHooks(port) {
    let doc: { hooks?: Record<string, { matcher?: string; hooks?: { command?: string }[] }[]> } = {};
    try {
      doc = JSON.parse(readFileSync(HOOKS_FILE, 'utf8'));
    } catch {
      /* fresh file */
    }
    doc.hooks ??= {};
    const script = HOOK_SCRIPT.replace(/\\/g, '/'); // hooks run under bash even on Windows
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Stop', 'Interrupt']) {
      const groups = (doc.hooks[event] ?? []).filter(
        (g) => !(g.hooks ?? []).some((h) => h.command?.includes(HOOK_MARK)),
      );
      groups.push({
        ...(event === 'PreToolUse' || event === 'PermissionRequest' ? { matcher: '.*' } : {}),
        hooks: [{ type: 'command', timeout: 5, command: `node "${script}" ${port} ${event}` } as { command: string }],
      });
      doc.hooks[event] = groups;
    }
    mkdirSync(CODEX_HOME, { recursive: true });
    writeFileSync(HOOKS_FILE, JSON.stringify(doc, null, 2));
  },

  mapHookEvent(event, body) {
    switch (event) {
      case 'UserPromptSubmit':
        return { state: 'WORKING' };
      case 'PreToolUse':
        return { state: 'WORKING', detail: body.tool_name ? `using ${body.tool_name}` : undefined };
      case 'PermissionRequest':
        return { state: 'WAITING_PERMISSION', detail: body.tool_name ? `approval: ${body.tool_name}` : 'approval requested' };
      case 'Stop':
        return { state: 'IDLE', detail: 'turn finished' };
      case 'Interrupt':
        return { state: 'IDLE', detail: 'interrupted' };
      default:
        return null; // SessionStart only binds the id (hooksReceiver); SessionEnd is the PTY exit
    }
  },

  outputWaitingRegex: OUTPUT_WAITING_REGEX,
  acceptKeystroke: '\r',

  transcript: {
    file(cwd, sessionId) {
      // synchronous by contract: look for an existing rollout named with this id
      const found = findRolloutSync(sessionId);
      if (found) return found;
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
      void cwd;
      return join(SESSIONS_DIR, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()), `rollout-${stamp}-${sessionId}.jsonl`);
    },
    async listFolder(cwd) {
      const want = normCwd(cwd);
      const rows = await threads();
      if (rows.length) {
        const out: TranscriptRef[] = [];
        for (const r of rows) {
          if (r.archived || !r.cwd || normCwd(r.cwd) !== want) continue;
          const ref = await refFromRow(r);
          if (ref) out.push(ref);
        }
        return out;
      }
      const out: TranscriptRef[] = [];
      for (const ref of await scanRollouts()) {
        const c = await rolloutCwd(ref.path);
        if (c && normCwd(c) === want) out.push(ref);
      }
      return out;
    },
    async listAll() {
      const rows = await threads();
      if (rows.length) {
        const out: TranscriptRef[] = [];
        for (const r of rows) {
          if (r.archived) continue;
          const ref = await refFromRow(r);
          if (ref) out.push(ref);
        }
        return out;
      }
      return scanRollouts();
    },
    parseTail,
    parseExchanges,
    async activeSessionIds() {
      // no live status file — a thread touched in the last 10 minutes counts as open
      const ids = new Set<string>();
      const cutoff = Date.now() - 10 * 60_000;
      for (const r of await threads()) if ((r.updated_at_ms ?? 0) > cutoff) ids.add(r.id);
      return ids;
    },
    async install(cwd, sessionId, body) {
      // the rollout's own timestamp decides its date folder, so Codex finds it where it expects
      const head = body.toString('utf8', 0, 2000);
      const ts = head.match(/"timestamp":"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const [y, m, day, hh, mm, ss] = ts
        ? [ts[1], ts[2], ts[3], ts[4], ts[5], ts[6]]
        : [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()), pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())];
      const dir = join(SESSIONS_DIR, y, m, day);
      await mkdir(dir, { recursive: true });
      const path = join(dir, `rollout-${y}-${m}-${day}T${hh}-${mm}-${ss}-${sessionId}.jsonl`);
      await writeFile(path, body);
      void cwd;
      return path;
    },
  },

  models: [
    { value: 'gpt-6-astra', label: 'gpt-6-astra' },
    { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
    { value: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
    { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
    { value: 'gpt-5.5', label: 'gpt-5.5' },
    { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
  ],
  permissionModes: [
    { value: 'approve-for-me', label: 'approve-for-me (auto review)' },
    { value: 'read-only', label: 'read-only sandbox' },
    { value: 'full-access', label: 'full access (asks)' },
    { value: 'bypass', label: 'bypass approvals + sandbox' },
  ],
};

/** Synchronous rollout lookup by id (contract requires file() to be sync). */
function findRolloutSync(sessionId: string): string | undefined {
  const walk = (dir: string, depth: number): string | undefined => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    // newest date folders first
    entries.sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) {
        const hit = walk(p, depth + 1);
        if (hit) return hit;
      } else if (e.isFile() && e.name.endsWith(`-${sessionId}.jsonl`)) return p;
    }
    return undefined;
  };
  return walk(SESSIONS_DIR, 0);
}
