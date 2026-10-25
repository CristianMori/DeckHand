import { existsSync, readFileSync } from 'node:fs';

/**
 * Mimir, RAVEN's broker for outside agents (desktop-master:5102). Deckhand
 * sessions hand it tasks ("research the best hotel in London"); it delegates
 * them to an enrolled agent such as Ron and answers the requesting session
 * with a "[Mimir, task T7] …" prompt. The dashboard shows Mimir's view of the
 * agents (open tasks, last messages, Deckhand access).
 *
 * Calls carry the "tasks"-scope key Mimir issued for Deckhand. Only the
 * machine holding that key file talks to Mimir; other hubs forward to it
 * (HUB_MIMIR_MACHINE).
 */

export const MIMIR_URL = (process.env.HUB_MIMIR_URL || 'http://127.0.0.1:5102').replace(/\/+$/, '');
const KEY_FILE = process.env.HUB_MIMIR_TASKS_KEY || 'D:\\DataDrive\\Mimir\\data\\secrets\\deckhand-hub-tasks.key';
export const MIMIR_MACHINE = process.env.HUB_MIMIR_MACHINE || 'desktop-master';

export const mimirHere = () => existsSync(KEY_FILE);

export async function mimirCall(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const key = readFileSync(KEY_FILE, 'utf8').trim();
  const res = await fetch(`${MIMIR_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { error: text.slice(0, 300) } };
  }
}
