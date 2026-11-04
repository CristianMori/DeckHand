import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DATA_DIR, warnOnce } from '../config.js';
import {
  CLAUDE_PROJECTS_DIR,
  CLAUDE_SESSIONS_DIR,
  HOOKS_JSON,
  HOOKS_TEMPLATE,
  encodeProjectDir,
} from '../config.js';
import { moveDir } from '../transcriptIo.js';
import type { AgentAdapter, StatusRecord, TranscriptRef, TranscriptTail } from './types.js';

/** the hub's MCP server entry handed to every Claude session via --mcp-config */
/** one MCP config per conversation: the env inside carries that session's
 *  identity, and Claude reads the file some time after spawn — a shared file
 *  rewritten by the next spawn (session restore starts them seconds apart)
 *  handed sessions each other's identity */
const MCP_DIR = join(DATA_DIR, 'mcp');
const mcpJsonFor = (sessionId: string) => join(MCP_DIR, `${sessionId.replace(/[^\w-]/g, '_')}.json`);

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
  // installed after the hub started (the hub's PATH is the one it was born
  // with), or by the native installer into a folder the service PATH lacks
  const home = homedir();
  const known =
    process.platform === 'win32'
      ? [join(home, '.local', 'bin', 'claude.exe')]
      : [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  return known.find((p) => existsSync(p)) ?? 'claude'; // else let the PTY resolve via PATH
}

/** Claude Code's official native installer: no Node, no sudo, lands in ~/.local/bin. */
const INSTALL_COMMAND =
  process.platform === 'win32'
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash';

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

/**
 * Claude asks "Is this a project you trust?" the first time it runs in a
 * folder and records the answer under projects[<path>] in ~/.claude.json.
 * A hub-launched session has nobody at the keyboard to answer (a script, or
 * NEW SESSION into a folder it just created), so the hub records the answer
 * up front — exactly what choosing "Yes, I trust this folder" would do.
 */
function ensureTrusted(cwd: string) {
  const file = join(homedir(), '.claude.json');
  let root: { projects?: Record<string, Record<string, unknown>> } = {};
  try {
    root = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* no config yet */
  }
  // Claude keys projects by forward-slash path, no trailing slash
  const key = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const projects = (root.projects ??= {});
  const existing = Object.keys(projects).find((k) => k.toLowerCase() === key.toLowerCase());
  if (existing && projects[existing].hasTrustDialogAccepted === true) return;
  projects[existing ?? key] = { ...(projects[existing ?? key] ?? {}), hasTrustDialogAccepted: true };
  // whole-file rewrite through a temp name — never leave a half-written config
  const tmp = `${file}.deckhand-tmp`;
  writeFileSync(tmp, JSON.stringify(root, null, 2));
  renameSync(tmp, file);
}

/** Which project .mcp.json servers a folder's sessions have enabled. */
export interface McpChoices {
  enableAll: boolean;
  enabled: string[];
}

/**
 * Where Claude records a project's MCP choice: the project's
 * .claude/settings.local.json or settings.json (enabledMcpjsonServers /
 * disabledMcpjsonServers / enableAllProjectMcpServers), and ~/.claude.json
 * under projects[<folder>]. Merged the way Claude merges them: enabled is the
 * union minus everything any source disables; enableAll from any source wins.
 */
export function leadMcpChoices(folder: string, home = homedir()): McpChoices {
  const read = (file: string): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const sources = [read(join(folder, '.claude', 'settings.local.json')), read(join(folder, '.claude', 'settings.json'))];
  const projects = (read(join(home, '.claude.json')).projects ?? {}) as Record<string, Record<string, unknown>>;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const hit = Object.keys(projects).find((k) => norm(k) === norm(folder));
  if (hit) sources.push(projects[hit]);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const enabled = new Set(sources.flatMap((s) => list(s.enabledMcpjsonServers)));
  for (const s of sources) for (const name of list(s.disabledMcpjsonServers)) enabled.delete(name);
  return { enableAll: sources.some((s) => s.enableAllProjectMcpServers === true), enabled: [...enabled] };
}

/** Server names in the project's .mcp.json, looked for from cwd up to the repository root. */
export function projectMcpServers(cwd: string): string[] {
  for (let dir = cwd, i = 0; i < 50; i++) {
    const file = join(dir, '.mcp.json');
    if (existsSync(file)) {
      try {
        const doc = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> };
        return Object.keys(doc.mcpServers ?? {});
      } catch {
        return []; // malformed: Claude ignores it too
      }
    }
    if (existsSync(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}

/**
 * The settings file a session starts with. A worker in a fresh worktree is a
 * new, unapproved project to Claude, and its ".mcp.json servers found" dialog
 * has nobody at the keyboard — so the worker's settings decide every server in
 * the worktree's .mcp.json up front, from the choice its lead recorded: the
 * same servers enabled, every other one disabled, nothing left to ask about.
 */
function settingsFor(sessionId: string, cwd: string, choices?: McpChoices): string {
  const servers = choices ? projectMcpServers(cwd) : [];
  if (!choices || !servers.length) return HOOKS_JSON;
  const enabled = servers.filter((s) => choices.enableAll || choices.enabled.includes(s));
  if (!enabled.length) {
    warnOnce(`[claude] ${cwd}: its lead recorded no project MCP choice, so all ${servers.length} servers in .mcp.json are disabled for this session`);
  }
  let hooks: Record<string, unknown> = {};
  try {
    hooks = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  } catch {
    /* hooks not materialized yet (tests) */
  }
  const file = join(MCP_DIR, `${sessionId.replace(/[^\w-]/g, '_')}-settings.json`);
  mkdirSync(MCP_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...hooks, enabledMcpjsonServers: enabled, disabledMcpjsonServers: servers.filter((s) => !enabled.includes(s)) }, null, 2));
  return file;
}

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  label: 'Claude Code',
  clientChosenId: true,
  resolveExe,
  available: () => resolveExe() !== 'claude',
  installCommand: INSTALL_COMMAND,
  beforeSpawn: (cwd) => {
    try {
      ensureTrusted(cwd);
    } catch {
      /* the trust prompt then appears on screen; keys can answer it */
    }
  },

  buildArgs({ sessionId, resume, name, cwd, model, permissionMode, initialPrompt, briefing, mcp, alwaysAllow, mcpChoices }) {
    const args: string[] = [];
    if (mcp) {
      // the hub's MCP server rides along as an extra server; the project's own
      // .mcp.json and the user's servers are untouched (no --strict-mcp-config).
      // --mcp-config is variadic (<configs...>): it must come FIRST, or the
      // positional initial prompt after it is read as another config path and
      // Claude dies with ENAMETOOLONG
      const mcpJson = mcpJsonFor(sessionId);
      mkdirSync(MCP_DIR, { recursive: true });
      writeFileSync(mcpJson, JSON.stringify({ mcpServers: { [mcp.name]: { command: mcp.command, args: mcp.args, env: mcp.env } } }, null, 2));
      args.push('--mcp-config', mcpJson);
    }
    if (resume) args.push('--resume', sessionId);
    else args.push('--session-id', sessionId);
    args.push('-n', name, '--settings', settingsFor(sessionId, cwd, mcpChoices));
    if (alwaysAllow?.length) args.push('--allowedTools', alwaysAllow.join(','));
    if (permissionMode) args.push('--permission-mode', permissionMode);
    if (model) args.push('--model', model);
    if (briefing) args.push('--append-system-prompt', briefing);
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
  screenActivity: (screen) => {
    const tail = screen.split('\n').slice(-14);
    // "✻ Kerfuffling… (3m 40s · ↓ 7.9k tokens)" / "… (esc to interrupt)"
    if (tail.some((l) => /…\s*\([^)]*(?:tokens|esc to interrupt|\d+[smh]\b)[^)]*\)/.test(l))) return 'working';
    // an empty composer with nothing above it running
    if (tail.some((l) => /^\s?[>›]\s*$/.test(l))) return 'idle';
    return null;
  },
  // The composer is the "> " (or "❯ ") line Claude Code frames between two
  // horizontal rules; while it is empty it may show a "Try \"…\"" hint. The
  // framing matters: dialog cursors (❯ No, exit) and quoted text are bare.
  composerText: (screen) => {
    const rule = (l: string | undefined) => !!l && /─{20,}/.test(l);
    const lines = screen.split('\n');
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 14); i--) {
      const m = /^\s{0,2}[>❯›](?:\s(.*))?$/.exec(lines[i]);
      if (!m || (!rule(lines[i - 1]) && !rule(lines[i + 1]))) continue;
      const text = (m[1] ?? '').trim();
      return /^Try "/.test(text) ? '' : text;
    }
    return undefined;
  },
  acceptKeystroke: '\r',
  isProtectedPrompt: (screen) => PLAN_EXIT_MARKER.test(screen),
  startupDialog: (screen) => {
    const mcp = screen.match(/(?:\d+ )?new MCP servers? found/i);
    if (mcp) return `Claude's "${mcp[0]}" project dialog`;
    // both wordings seen in the wild: older builds ask about files, current ones "Quick safety check: Is this a project you created or one you trust?"
    if (/Do you trust the files in this folder\?|Is this a project you created or one you trust\?/i.test(screen)) return "Claude's folder trust dialog";
    if (/Select login method|Sign in to Claude/i.test(screen)) return "Claude's login screen";
    return undefined;
  },
  // Signed out mid-session (seen 2026-11-04): every prompt is answered with one
  // line and no hook fires. The reply area says "Login expired · Please run
  // /login"; the status line under the composer says "Not logged in · Run /login".
  loggedOut: (screen) => {
    const tail = screen.split('\n').slice(-14).join('\n');
    if (/Login expired|Please run \/login/i.test(tail)) return "Claude's login expired (run /login)";
    if (/Not logged in\s*·\s*Run \/login/i.test(tail)) return 'Claude is not logged in (run /login)';
    return undefined;
  },

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
    // transcripts, subagent logs and the auto-memory all live in the one
    // folder Claude derives from the cwd
    async moveFolder(fromCwd, toCwd) {
      return moveDir(join(CLAUDE_PROJECTS_DIR, encodeProjectDir(fromCwd)), join(CLAUDE_PROJECTS_DIR, encodeProjectDir(toCwd)));
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
