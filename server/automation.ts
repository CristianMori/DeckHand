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
  return: '\r',
  esc: '\x1b',
  escape: '\x1b',
  tab: '\t',
  backspace: '\x7f',
  del: '\x1b[3~',
  delete: '\x1b[3~',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-u': '\x15',
  'shift-tab': '\x1b[Z',
};

/** A named key (any case) as its escape sequence; anything else is typed literally. */
export const keyData = (k: string) => KEYS[k.toLowerCase()] ?? k;

/** The draft sitting in the session's composer ('' when it is empty), or
 *  undefined when the screen shows no composer or the engine can't tell. */
export function composerDraft(session: HubSession): string | undefined {
  try {
    return agentFor(session).composerText?.(session.screenText());
  } catch {
    return undefined; // mirror mid-resize, or a stand-in session with no screen
  }
}

/** True when typing now would merge with text already in the composer —
 *  a draft the user is writing, or a menu that reuses the composer line. */
export function composerBusy(session: HubSession): boolean {
  return !!composerDraft(session);
}

/** Prompts above this many UTF-8 bytes are refused outright — long content
 *  belongs in a file the prompt references. */
export const MAX_PROMPT_BYTES = 262_144;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * How a prompt is fed to the pty. ConPTY hands input to the client in ~4 KiB
 * pieces, and a TUI that is mid-render when a piece lands can lose whole
 * pieces (seen on Windows: a 3.7 KB prompt arrived missing its first 3 KB,
 * a 64 KB one kept only its first and last pieces). So: small writes with
 * breathing room between them, inside one bracketed paste so the TUI treats
 * every piece — newlines included — as one paste however the gaps fall.
 */
const WRITE_CHUNK = 1024;
const WRITE_GAP_MS = 15;

async function writePaced(manager: SessionManager, session: HubSession, data: string) {
  for (let i = 0; i < data.length; i += WRITE_CHUNK) {
    if (!session.proc) return;
    manager.write(session.hubId, data.slice(i, i + WRITE_CHUNK));
    if (i + WRITE_CHUNK < data.length) await sleep(WRITE_GAP_MS);
  }
}

/** Type a prompt into a live session's composer and submit it. False: the
 *  composer already held someone's text (nothing was typed), or mayEnter said no. */
export async function typePrompt(manager: SessionManager, session: HubSession, text: string, mayEnter: () => boolean = () => true) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_PROMPT_BYTES) {
    throw new Error(`prompt is ${bytes} bytes — the hub refuses prompts over ${MAX_PROMPT_BYTES} bytes; put the content in a file and send a prompt that references it`);
  }
  if (composerBusy(session)) return false;
  // a TUI agent gets the text as an explicit bracketed paste; a terminal
  // (plain shell) would read the markers as junk keystrokes, so it gets the
  // raw text — still paced, so ConPTY never swallows a piece
  const tui = !agentFor(session).outputOnlyStatus;
  if (tui) manager.write(session.hubId, PASTE_START);
  await writePaced(manager, session, text);
  if (tui) manager.write(session.hubId, PASTE_END);
  // the CR must arrive in its own chunk — text+CR together reads as a paste
  // to the TUI and lands in the composer without submitting. A long text
  // reaches the TUI as several paste chunks: give the last one time to land.
  await sleep(Math.min(3000, 120 + Math.floor(text.length / 8)));
  if (!mayEnter()) return false;
  manager.write(session.hubId, '\r');
  // a long paste can still outrun that: if the agent did not start, the CR
  // landed mid-paste and the prompt sits in the composer — submit once more
  // (an empty composer ignores a stray CR, so this never doubles a prompt)
  if (text.length > 500 && session.state !== 'WORKING') {
    const started = await waitUntil(manager, () => session.state === 'WORKING' || !session.proc, 2500);
    if (!started && mayEnter()) manager.write(session.hubId, '\r');
  }
  // delivery guard: a lost piece is silent at the pty layer, so check the
  // transcript (or screen) actually holds the text, and shout if it doesn't
  if (tui && text.length > 200) void verifyPromptDelivery(session, text).catch(() => {});
  return true;
}

/**
 * Three probes that catch every truncation shape seen in the wild: a lost
 * head (the 3.7 KB case), a lost middle (the 64 KB case — first and last
 * piece arrived, everything between vanished), and a lost tail. Each probe
 * is one line (or a 60-char slice of one), JSON-escaped so it can be found
 * verbatim inside a JSONL transcript.
 */
export function promptProbes(text: string): string[] {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length >= 8);
  if (!lines.length) return [text.trim().slice(0, 60)].filter(Boolean);
  const mid = lines[Math.floor(lines.length / 2)];
  const probes = [lines[0], mid, lines[lines.length - 1]];
  return [...new Set(probes.map((p) => p.slice(0, 60)))];
}

/** A probe as it appears inside a JSON string in a transcript file. */
export const jsonEscaped = (s: string) => JSON.stringify(s).slice(1, -1);

export function probesPresent(transcript: string, probes: string[]): boolean {
  return probes.every((p) => transcript.includes(jsonEscaped(p)) || transcript.includes(p));
}

/**
 * After a prompt was submitted: confirm the session really received it, by
 * finding the head, middle and tail of the text in the agent's transcript
 * (where the submitted message lands within moments) or, failing that, on
 * the screen. Logs loudly when the text cannot be found — a silently cut
 * prompt is exactly the failure this hub must never hide.
 */
export async function verifyPromptDelivery(
  session: HubSession,
  text: string,
  o: { attempts: number; delayMs: number } = { attempts: 20, delayMs: 500 },
): Promise<boolean> {
  const probes = promptProbes(text);
  const ops = agentFor(session).transcript;
  const path = ops?.file(session.cwd, session.claudeSessionId);
  let seen = ''; // the latest evidence looked at, for naming what is missing
  for (let attempt = 0; attempt < o.attempts; attempt++) {
    await sleep(o.delayMs);
    seen = '';
    if (path && existsSync(path)) {
      try {
        seen = await readFile(path, 'utf8');
      } catch {
        /* mid-write — retry */
      }
    }
    try {
      seen += '\n' + session.screenText(2000);
    } catch {
      /* mirror mid-resize — retry */
    }
    if (probesPresent(seen, probes)) return true;
    if (!session.proc) break;
  }
  const missing = probes.filter((p) => !probesPresent(seen, [p]));
  console.error(
    `[prompt-delivery] LOST PROMPT: session ${session.name} (${session.hubId}) shows no trace of ` +
      `${missing.length === probes.length ? 'the' : 'part of the'} ${text.length}-char prompt that was typed in — ` +
      `missing: ${missing.map((p) => JSON.stringify(p.slice(0, 40))).join(', ')}`,
  );
  return false;
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
  return session.screenText(scrollback);
}
