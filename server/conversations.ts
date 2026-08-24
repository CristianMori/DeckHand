import { readdir, readFile, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_PROJECTS_DIR, CLAUDE_SESSIONS_DIR } from './config.js';

export interface ConversationEntry {
  claudeSessionId: string;
  cwd?: string;
  title?: string;
  lastText?: string;
  updatedAt: number;
  /** a live claude process (outside the hub) currently has this conversation open */
  activeElsewhere: boolean;
}

const MAX_RESULTS = 40;
const TAIL_BYTES = 64 * 1024;

export async function readTail(path: string): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Extract cwd / title / last assistant text from a transcript tail. */
export function parseTranscriptTail(tail: string): { cwd?: string; title?: string; lastText?: string } {
  const out: { cwd?: string; title?: string; lastText?: string } = {};
  out.cwd = tail.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\\\/g, '\\');
  const titleMatch = tail.match(/"type":"custom-title","title":"((?:[^"\\]|\\.)*)"/);
  if (titleMatch) out.title = titleMatch[1];
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0 && !out.lastText; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'assistant' || obj.isSidechain) continue;
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .filter((c: { type: string; text?: string }) => c.type === 'text' && c.text)
        .map((c: { text: string }) => c.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) out.lastText = text.length > 140 ? text.slice(0, 137) + '…' : text;
    } catch {
      /* partial first line of tail window */
    }
  }
  return out;
}

export async function activeSessionIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    for (const file of await readdir(CLAUDE_SESSIONS_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(await readFile(join(CLAUDE_SESSIONS_DIR, file), 'utf8'));
        // ignore records that stopped updating long ago (dead process leftovers)
        if (rec.sessionId && rec.updatedAt && Date.now() - rec.updatedAt < 10 * 60_000) {
          ids.add(rec.sessionId);
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no sessions dir */
  }
  return ids;
}

/** List recent Claude Code conversations across all projects, newest first. */
export async function listRecentConversations(
  excludeSessionIds: Set<string>,
): Promise<ConversationEntry[]> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }

  const files: { path: string; sessionId: string; mtime: number }[] = [];
  for (const dir of projectDirs) {
    const full = join(CLAUDE_PROJECTS_DIR, dir);
    let entries: string[];
    try {
      entries = await readdir(full);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const sessionId = f.slice(0, -6);
      if (excludeSessionIds.has(sessionId)) continue;
      try {
        const s = await stat(join(full, f));
        if (s.size > 0) files.push({ path: join(full, f), sessionId, mtime: s.mtimeMs });
      } catch {
        /* skip */
      }
    }
  }

  files.sort((a, b) => b.mtime - a.mtime);
  const picked = files.slice(0, MAX_RESULTS);
  const active = await activeSessionIds();

  const results: ConversationEntry[] = [];
  for (const f of picked) {
    const entry: ConversationEntry = {
      claudeSessionId: f.sessionId,
      updatedAt: f.mtime,
      activeElsewhere: active.has(f.sessionId),
    };
    try {
      const parsed = parseTranscriptTail(await readTail(f.path));
      entry.cwd = parsed.cwd;
      entry.title = parsed.title;
      entry.lastText = parsed.lastText;
    } catch {
      /* unreadable transcript — still listed, just bare */
    }
    if (entry.cwd) results.push(entry); // can't resume without knowing the folder
  }
  return results;
}
