import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

export const HUB_ROOT = join(import.meta.dirname, '..');
export const DATA_DIR = process.env.HUB_DATA_DIR || join(HUB_ROOT, 'data');
export const PUBLIC_DIR = join(HUB_ROOT, 'server', 'public');
export const HOOKS_TEMPLATE = join(HUB_ROOT, 'hooks', 'hub-hooks.template.json');
export const HOOKS_JSON = join(DATA_DIR, 'hub-hooks.json');
export const PERSIST_FILE = join(DATA_DIR, 'hub-sessions.json');

export const CLAUDE_HOME = join(homedir(), '.claude');
export const CLAUDE_SESSIONS_DIR = join(CLAUDE_HOME, 'sessions');
export const CLAUDE_PROJECTS_DIR = join(CLAUDE_HOME, 'projects');

export const PROJECTS_ROOT =
  process.env.HUB_PROJECTS_ROOT ||
  (process.platform === 'win32' ? join(homedir(), 'Projects') : '/srv/sync');
export const DEFAULT_PORT = Number(process.env.HUB_PORT) || 5959;

/** Port range sibling hubs are probed on (DEFAULT_PORT may walk up when taken). */
export const FLEET_PORT_MIN = 5959;
export const FLEET_PORT_MAX = 5969;

mkdirSync(DATA_DIR, { recursive: true });

/** Resolve the claude binary once at boot — install paths move on updates. */
export function resolveClaudeExe(): string {
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

/** Claude Code encodes a project cwd into a transcript folder name: non-alphanumerics become '-'. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Resolve the tailscale CLI; absent tailscale just disables fleet discovery. */
export function resolveTailscaleExe(): string | null {
  const candidates =
    process.platform === 'win32'
      ? ['C:\\Program Files\\Tailscale\\tailscale.exe']
      : ['/usr/bin/tailscale', '/usr/local/bin/tailscale'];
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const probe = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(probe, ['tailscale'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (out && existsSync(out)) return out;
  } catch {
    /* not installed */
  }
  return null;
}
