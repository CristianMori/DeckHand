import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CLAUDE_PROJECTS_DIR,
  CLAUDE_SESSIONS_DIR,
  HOOKS_JSON,
  HOOKS_TEMPLATE,
  encodeProjectDir,
} from '../config.js';
import type { AgentAdapter, StatusRecord, TranscriptRef, TranscriptTail } from './types.js';

const OUTPUT_WAITING_REGEX = /Do you want|Would you like|❯\s*1\.|\(y\/n\)|Yes, and don't ask again/;
// The plan-mode exit prompt is the one permission auto-yes never answers —
// leaving plan mode is a real decision. Its options offer to keep planning.
const PLAN_EXIT_MARKER = /keep planning|exit plan mode|ready to (code|proceed)/i;

function resolveExe(): string {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8' });
      const exe = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.toLowerCase().endsWith('.exe'));
      if (exe && existsSync(exe)) return exe;
    } else {
      const out = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
      if (out && existsSync(out)) return out;
    }
  } catch {
    /* fall through */
  }
  return 'claude'; // let the PTY resolve via PATH
}

function textOf(content: unknown, sep: string): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join(sep);
}

function parseTail(tail: string): TranscriptTail {
  const out: TranscriptTail = {};
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
      const text = textOf(obj.message?.content, ' ').replace(/\s+/g, ' ').trim();
      if (text) out.lastText = text.length > 140 ? text.slice(0, 137) + '…' : text;
    } catch {
      /* partial first line of tail window */
    }
  }
  return out;
}

function parseExchanges(full: string, n: number): { q: string; r: string }[] {
  const exchanges: { q: string; r: string }[] = [];
  const lines = full.split('\n');
  let replyParts: string[] = [];
  // walk backwards: gather assistant text until the owning user question
  for (let i = lines.length - 1; i >= 0 && exchanges.length < n; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: { type?: string; isSidechain?: boolean; isMeta?: boolean; message?: { content?: unknown } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.isSidechain || obj.isMeta) continue;
    const content = obj.message?.content;
    if (obj.type === 'assistant' && Array.isArray(content)) {
      const text = textOf(content, '\n');
      if (text) replyParts.unshift(text);
    } else if (obj.type === 'user') {
      const q = textOf(content, '\n');
      if (q && replyParts.length) {
        exchanges.unshift({ q, r: replyParts.join('\n\n') });
        replyParts = [];
      }
    }
  }
  return exchanges;
}

async function listDir(dir: string): Promise<TranscriptRef[]> {
  const out: TranscriptRef[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const s = await stat(join(dir, f));
      if (s.size > 0) out.push({ path: join(dir, f), sessionId: f.slice(0, -6), mtime: s.mtimeMs });
    } catch {
      /* skip */
    }
  }
  return out;
}

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  label: 'Claude Code',
  clientChosenId: true,
  resolveExe,

  buildArgs({ sessionId, resume, name, model, permissionMode, initialPrompt }) {
    const args: string[] = [];
    if (resume) args.push('--resume', sessionId);
    else args.push('--session-id', sessionId);
    args.push('-n', name, '--settings', HOOKS_JSON);
    if (permissionMode) args.push('--permission-mode', permissionMode);
    if (model) args.push('--model', model);
    if (initialPrompt) args.push(initialPrompt);
    return args;
  },

  writeHooks(port) {
    let template = readFileSync(HOOKS_TEMPLATE, 'utf8').replaceAll('{{PORT}}', String(port));
    // hooks run under bash everywhere; the hard-coded curl path is Windows-only
    if (process.platform !== 'win32') {
      template = template.replaceAll('C:/Windows/System32/curl.exe', 'curl');
    }
    writeFileSync(HOOKS_JSON, template);
  },

  mapHookEvent(event, body) {
    switch (event) {
      case 'UserPromptSubmit':
        return { state: 'WORKING' };
      case 'AskUserQuestion':
        return { state: 'WAITING_QUESTION', detail: 'Claude is asking you a question' };
      case 'PreToolUse':
        return { state: 'WORKING', detail: body.tool_name ? `using ${body.tool_name}` : undefined };
      case 'Stop':
        return { state: 'IDLE', detail: 'turn finished' };
      case 'Notification': {
        const msg = body.message ?? '';
        if (/permission/i.test(msg)) return { state: 'WAITING_PERMISSION', detail: msg };
        if (/waiting for your input/i.test(msg)) return { state: 'IDLE', detail: msg };
        if (msg) return { state: 'WAITING_QUESTION', detail: msg };
        return null;
      }
      default:
        return null;
    }
  },

  statusDir: CLAUDE_SESSIONS_DIR,
  parseStatusRecord(json): StatusRecord | null {
    const rec = json as { sessionId?: string; status?: string; waitingFor?: string; updatedAt?: number };
    if (!rec?.sessionId) return null;
    const out: StatusRecord = { sessionId: rec.sessionId, updatedAt: rec.updatedAt };
    if (rec.status === 'waiting') {
      out.state = 'WAITING_PERMISSION';
      out.detail = rec.waitingFor ?? 'waiting';
    } else if (rec.status === 'busy') out.state = 'WORKING';
    else if (rec.status === 'idle') {
      out.state = 'IDLE';
      out.detail = 'turn finished';
    }
    return out;
  },

  outputWaitingRegex: OUTPUT_WAITING_REGEX,
  acceptKeystroke: '\r',
  isProtectedPrompt: (screen) => PLAN_EXIT_MARKER.test(screen),

  transcript: {
    file: (cwd, sessionId) => join(CLAUDE_PROJECTS_DIR, encodeProjectDir(cwd), `${sessionId}.jsonl`),
    listFolder: (cwd) => listDir(join(CLAUDE_PROJECTS_DIR, encodeProjectDir(cwd))),
    async listAll() {
      let dirs: string[];
      try {
        dirs = await readdir(CLAUDE_PROJECTS_DIR);
      } catch {
        return [];
      }
      const out: TranscriptRef[] = [];
      for (const d of dirs) out.push(...(await listDir(join(CLAUDE_PROJECTS_DIR, d))));
      return out;
    },
    parseTail,
    parseExchanges,
    async activeSessionIds() {
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
    },
    async install(cwd, sessionId, body) {
      const dir = join(CLAUDE_PROJECTS_DIR, encodeProjectDir(cwd));
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${sessionId}.jsonl`);
      await writeFile(path, body);
      return path;
    },
  },

  models: [
    { value: 'opus', label: 'opus' },
    { value: 'sonnet', label: 'sonnet' },
    { value: 'haiku', label: 'haiku' },
  ],
  permissionModes: [
    { value: 'acceptEdits', label: 'acceptEdits' },
    { value: 'plan', label: 'plan' },
    { value: 'bypassPermissions', label: 'bypassPermissions' },
  ],
};
