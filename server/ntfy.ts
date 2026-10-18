import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

/**
 * Phone push through ntfy (https://ntfy.sh, or a self-hosted server): when a
 * session needs permission, asks a question or finishes a turn, the hub
 * publishes one short message to a topic. The ntfy iPhone app shows it at
 * once, app closed or not, and the Even app mirrors phone notifications onto
 * the glasses.
 *
 * Configured in data/ntfy.json, read on every send so edits apply live:
 *   { "url": "https://ntfy.sh/<secret-topic>", "token": "tk_…" (optional),
 *     "click": "http://<hub>:5959" (optional, opened when the push is tapped),
 *     "done": true (optional, false = only waiting sessions) }
 * One configured hub covers the whole fleet (the glasses bridge watches every
 * machine's sessions); configure more than one and pushes arrive twice.
 */

export const NTFY_FILE = join(DATA_DIR, 'ntfy.json');

export interface NtfyConfig {
  url: string;
  token?: string;
  click?: string;
  done?: boolean;
}

export type AlertKind = 'permission' | 'question' | 'done';

export function loadNtfy(): NtfyConfig | null {
  try {
    if (!existsSync(NTFY_FILE)) return null;
    const cfg = JSON.parse(readFileSync(NTFY_FILE, 'utf8')) as NtfyConfig;
    return typeof cfg?.url === 'string' && /^https?:\/\/[^/]+\/[\w-]+$/.test(cfg.url) ? cfg : null;
  } catch {
    return null;
  }
}

/** Validate and store; null clears it. Returns the stored config. */
export function saveNtfy(cfg: NtfyConfig | null): NtfyConfig | null {
  if (!cfg) {
    writeFileSync(NTFY_FILE, '{}\n', { mode: 0o600 });
    return null;
  }
  const url = String(cfg.url ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+\/[\w-]+$/.test(url)) throw new Error('url must look like https://ntfy.sh/<topic>');
  const out: NtfyConfig = { url };
  if (cfg.token) out.token = String(cfg.token);
  if (cfg.click) out.click = String(cfg.click);
  if (cfg.done === false) out.done = false;
  writeFileSync(NTFY_FILE, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  return out;
}

const PRIORITY: Record<AlertKind, number> = { permission: 4, question: 4, done: 3 };
const TAGS: Record<AlertKind, string[]> = {
  permission: ['warning'],
  question: ['question'],
  done: ['white_check_mark'],
};

/** Publish one alert. Uses ntfy's JSON API, so titles may hold any characters.
 *  `click` overrides the configured tap target (a file push opens its download). */
export async function sendNtfy(title: string, message: string, kind: AlertKind, click?: string): Promise<boolean> {
  const cfg = loadNtfy();
  if (!cfg) return false;
  if (kind === 'done' && cfg.done === false) return false;
  const u = new URL(cfg.url);
  const topic = u.pathname.replace(/^\/+/, '');
  try {
    const res = await fetch(u.origin, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify({
        topic,
        title,
        message,
        priority: PRIORITY[kind],
        tags: TAGS[kind],
        ...(click || cfg.click ? { click: click || cfg.click } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.warn(`[ntfy] ${res.status} from ${u.origin}: ${(await res.text()).slice(0, 200)}`);
    return res.ok;
  } catch (err) {
    console.warn(`[ntfy] send failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
