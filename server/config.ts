import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

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
  (process.platform === 'linux' ? '/srv/sync' : join(homedir(), 'Projects'));
export const DEFAULT_PORT = Number(process.env.HUB_PORT) || 5959;

/** Port range sibling hubs are probed on (DEFAULT_PORT may walk up when taken). */
export const FLEET_PORT_MIN = 5959;
export const FLEET_PORT_MAX = 5969;

mkdirSync(DATA_DIR, { recursive: true });

const warned = new Set<string>();

/** For paths hit on every poll or send: the same complaint is said once per hub run. */
export function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/**
 * A secret from its own file — absolute, or relative to the data folder —
 * never from the config itself. A missing or unreadable file complains once
 * per run and reads as no secret: whatever needed it is simply off.
 */
export function readSecretFile(configured: string, tag: string): { file: string; secret?: string } {
  const file = isAbsolute(configured) ? configured : join(DATA_DIR, configured);
  try {
    if (!existsSync(file)) {
      warnOnce(`[${tag}] key file not found: ${file}`);
      return { file };
    }
    return { file, secret: readFileSync(file, 'utf8').trim() || undefined };
  } catch (err) {
    warnOnce(`[${tag}] cannot read ${file}: ${err instanceof Error ? err.message : err}`);
    return { file };
  }
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
      : [
          '/usr/bin/tailscale',
          '/usr/local/bin/tailscale',
          '/opt/homebrew/bin/tailscale',
          // macOS app (App Store / standalone) ships the CLI inside the bundle
          '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
        ];
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
