import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { agentFor } from './agents/index.js';
import type { HubSession, SessionManager } from './sessionManager.js';
import type { SessionState } from './types.js';

/**
 * Programmatic control of live sessions — the pieces the REST automation
 * endpoints and the handoff job share: type a prompt, wait for the turn to
 * end, read the reply back out of the transcript, read the screen as text.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** States in which the agent is not doing anything on its own. */
export const SETTLED_STATES: readonly SessionState[] = ['IDLE', 'WAITING_QUESTION', 'WAITING_PERMISSION', 'EXITED'];

export function isSettled(session: HubSession): boolean {
  return !session.proc || SETTLED_STATES.includes(session.state);
}

/** Named keys a script may send instead of raw escape sequences. */
export const KEYS: Record<string, string> = {
  enter: '\r',
  esc: '\x1b',
  escape: '\x1b',
  tab: '\t',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-u': '\x15',
  'shift-tab': '\x1b[Z',
};

/** Type a prompt into a live session's composer and submit it. */
export async function typePrompt(manager: SessionManager, session: HubSession, text: string) {
  manager.write(session.hubId, text);
  // the CR must arrive in its own chunk — text+CR together reads as a paste
  // to the TUI and lands in the composer without submitting
  await sleep(120);
  manager.write(session.hubId, '\r');
}

/** Resolve true when pred holds (checked on every state change and on a
 *  heartbeat), false when timeoutMs elapses first. */
export function waitUntil(manager: SessionManager, pred: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (pred()) return resolve(true);
    const finish = (ok: boolean) => {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      manager.off('change', check);
      resolve(ok);
    };
    const check = () => {
      if (pred()) finish(true);
    };
    const heartbeat = setInterval(check, 250);
    const deadline = setTimeout(() => finish(false), timeoutMs);
    manager.on('change', check);
  });
}

/**
 * Wait for the turn a just-submitted prompt started to finish: first the
 * agent must go WORKING within startMs (the prompt landed), then it must
 * settle again before totalMs (counted from the call) runs out. Returns
 * which phase timed out, if any.
 */
export async function waitForTurn(
  manager: SessionManager,
  session: HubSession,
  o: { startMs: number; totalMs: number },
): Promise<'start' | 'done' | null> {
  const deadline = Date.now() + o.totalMs;
  const started = await waitUntil(manager, () => session.state === 'WORKING' || !session.proc, o.startMs);
  if (!started) return 'start';
  const done = await waitUntil(manager, () => isSettled(session), Math.max(1, deadline - Date.now()));
  return done ? null : 'done';
}

/** The last n question→reply exchanges from the session's transcript
 *  (oldest first); undefined when the agent keeps no readable transcript. */
export async function lastExchanges(
  session: HubSession,
  n: number,
): Promise<{ q: string; r: string }[] | undefined> {
  const ops = agentFor(session).transcript;
  if (!ops) return undefined;
  const path = ops.file(session.cwd, session.claudeSessionId);
  if (!existsSync(path)) return [];
  return ops.parseExchanges(await readFile(path, 'utf8'), n);
}

/** The reply to a specific prompt — matched on the prompt text, falling back
 *  to the newest exchange. The transcript flushes a moment after the stop
 *  hook, so this retries briefly before giving up. */
export async function replyTo(session: HubSession, prompt: string): Promise<string | undefined> {
  const needle = prompt.trim().slice(0, 80);
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(500);
    const exchanges = (await lastExchanges(session, 5)) ?? [];
    const hit = [...exchanges].reverse().find((e) => e.q.includes(needle)) ?? exchanges[exchanges.length - 1];
    if (hit) return hit.r;
  }
  return undefined;
}

/** The screen as plain text: the visible rows plus `scrollback` lines above. */
export function screenText(session: HubSession, scrollback = 0): string {
  const mirror = session.mirror;
  if (!mirror) return '';
  const buf = mirror.buffer.active;
  const from = Math.max(0, buf.length - mirror.rows - Math.max(0, scrollback));
  const lines: string[] = [];
  for (let i = from; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n').replace(/\s+$/, '');
}
