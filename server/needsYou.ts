import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentFor } from './agents/index.js';
import type { ApnsConfig } from './apns.js';
import { askingText } from './askDetect.js';
import { DATA_DIR } from './config.js';
import type { SmsConfig } from './sms.js';
import type { HubSession, SessionManager } from './sessionManager.js';
import type { AlertChannels, Attention, SessionInfo } from './types.js';

/**
 * Which sessions are waiting on the user, and telling the user once they have
 * waited a while. Each hub tracks its own sessions (NeedsYou) and publishes
 * the result on their cards; every hub reads the merged cards (FleetAttention)
 * to tell the clients connected to it, so nothing new crosses between hubs.
 */

const DEFAULT_DELAY_MS = 120_000;
const CONFIG_FILE = join(DATA_DIR, 'attention.json');
const FLUSH_WAITS_MS = [1200, 1500, 2000]; // the transcript flushes just after the stop hook
const PROMPT_TTL_MS = 60_000; // a typed prompt that never started a turn stops counting
const QUEUED_PROMPT_TTL_MS = 30 * 60_000; // a queued one starts when the running turn ends
/** Announced late (this hub restarted, a peer came back): only if still recent. */
const ANNOUNCE_WITHIN_MS = 10 * 60_000;
const HERMOD_TIMEOUT_MS = 10_000;
const SENT_FILE = join(DATA_DIR, 'attention-sent.json');
const SENT_KEEP = 1500; // up to three entries an episode, one per channel

interface AttentionConfig {
  delayMs?: number;
  hermod?: { url?: string; key?: string; person?: string };
  apns?: ApnsConfig;
  sms?: SmsConfig;
}

/** data/attention.json, read each time so adding a key needs no hub restart. */
export function attentionConfig(file = CONFIG_FILE): AttentionConfig {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as AttentionConfig) : {};
  } catch (err) {
    console.warn(`[attention] ignoring ${file}: ${err}`);
    return {};
  }
}

/** The sender answers these itself: a prompt from a session, an outside agent or Mimir. */
const answeredBySender = (caller: string | undefined) => /^(session:|agent:|gateway:|mimir\b)/i.test(caller ?? '');

interface Track {
  /** prompts typed through the API whose turn hasn't started, oldest first */
  pending: { bySender: boolean; expires: number }[];
  /** the running or last turn: who started it; undefined until one starts under this process */
  turnBySender?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** the reply last judged, so a late transcript flush isn't read as this turn's */
  judged?: string;
  /** what was already alerted since the last prompt */
  alerted?: string;
  /** bumps when the state moves on, to drop an async read that was overtaken */
  generation: number;
}

export class NeedsYou {
  private tracks = new Map<string, Track>();

  constructor(
    private manager: SessionManager,
    private deps: {
      lastReply: (session: HubSession) => Promise<string | undefined>;
      isProtectedPrompt?: (session: HubSession) => boolean;
      delayMs?: () => number;
      flushWaitsMs?: number[];
    },
  ) {
    manager.on('change', (session: HubSession) => this.update(session));
  }

  private track(session: HubSession): Track {
    let t = this.tracks.get(session.hubId);
    if (!t) this.tracks.set(session.hubId, (t = { pending: [], generation: 0 }));
    return t;
  }

  /** A prompt is being typed through the API; its turn starts at the next prompt hook. */
  promptFrom(session: HubSession, caller: string | undefined, queued: boolean) {
    const ttl = queued ? QUEUED_PROMPT_TTL_MS : PROMPT_TTL_MS;
    this.track(session).pending.push({ bySender: answeredBySender(caller), expires: Date.now() + ttl });
  }

  /** The agent took a prompt: whatever it was waiting on is over. */
  turnStarted(session: HubSession) {
    const t = this.track(session);
    const now = Date.now();
    t.pending = t.pending.filter((p) => p.expires > now);
    t.turnBySender = t.pending.shift()?.bySender ?? false; // none pending: typed in the terminal
    t.alerted = undefined;
    this.clear(session, t);
  }

  private clear(session: HubSession, t: Track) {
    t.generation++;
    if (t.timer) clearTimeout(t.timer);
    t.timer = undefined;
    if (session.attention) {
      session.attention = undefined;
      this.manager.emit('change', session);
    }
  }

  private update(session: HubSession) {
    if (agentFor(session).outputOnlyStatus) return;
    const t = this.track(session);
    const a = session.attention;
    switch (session.state) {
      case 'STARTING':
        t.turnBySender = undefined; // a new process: its old last reply is not a new question
        t.judged = undefined;
        return this.clear(session, t);
      case 'WORKING':
      case 'EXITED':
        return this.clear(session, t);
      case 'WAITING_QUESTION':
        return this.waiting(session, t, 'ask', session.detail ?? 'waiting for an answer');
      case 'WAITING_PERMISSION': {
        if (session.autoYes && !this.deps.isProtectedPrompt?.(session)) return; // auto-yes answers it
        const tool = session.lastTool ? `: ${session.lastTool.summary}` : '';
        return this.waiting(session, t, 'permission', `${session.detail ?? 'wants approval'}${tool}`);
      }
      case 'IDLE':
        if (a?.kind === 'question') return; // still the same unanswered question
        if (a) this.clear(session, t); // the prompt went away without a turn
        if (session.detail === 'turn finished' && t.turnBySender === false) void this.judgeReply(session, t);
    }
  }

  private async judgeReply(session: HubSession, t: Track) {
    const generation = ++t.generation;
    const since = session.stateSince;
    const waits = this.deps.flushWaitsMs ?? FLUSH_WAITS_MS;
    let reply: string | undefined;
    for (const wait of waits) {
      await new Promise((r) => setTimeout(r, wait));
      if (t.generation !== generation) return;
      reply = await this.deps.lastReply(session).catch(() => undefined);
      if (t.generation !== generation) return;
      if (reply !== undefined && reply !== t.judged) break;
    }
    if (reply === undefined || reply === t.judged) return;
    t.judged = reply;
    const text = askingText(reply);
    if (text && session.state === 'IDLE' && session.stateSince === since) this.waiting(session, t, 'question', text);
  }

  /** A waiting episode begins, or carries on under a new kind. */
  private waiting(session: HubSession, t: Track, kind: Attention['kind'], text: string) {
    if (t.turnBySender) return;
    const current = session.attention;
    if (current) {
      if (current.kind === kind && current.text === text) return;
      session.attention = { ...current, kind, text };
      this.manager.emit('change', session);
      return;
    }
    const since = Date.now();
    session.attention = { episode: `${session.hubId}-${since}`, kind, text, since };
    const delay = this.deps.delayMs?.() ?? attentionConfig().delayMs ?? DEFAULT_DELAY_MS;
    if (t.timer) clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      t.timer = undefined;
      const a = session.attention;
      if (!a || !session.proc) return;
      if (t.alerted === a.text) return; // the same thing again, with no prompt since
      t.alerted = a.text;
      session.attention = { ...a, alertedAt: Date.now() };
      this.manager.emit('change', session);
    }, delay);
    t.timer.unref?.();
    this.manager.emit('change', session);
  }
}

export type AttentionEvent = Attention & {
  type: 'attention';
  hubId: string;
  conversationId: string;
  name: string;
  machine?: string;
  state: SessionInfo['state'];
};

/** The client event for a session that is waiting on the user. */
export function attentionEvent(s: SessionInfo): AttentionEvent | undefined {
  if (!s.attention) return undefined;
  return { type: 'attention', ...s.attention, hubId: s.hubId, conversationId: s.claudeSessionId, name: s.name, machine: s.machine, state: s.state };
}

export interface AttentionCleared {
  type: 'attention-cleared';
  episode: string;
  hubId: string;
  conversationId: string;
  machine?: string;
}

/** Anything but exactly true is off: a missing, old or unreadable setting sends nothing. */
export function alertChannels(value: unknown): AlertChannels {
  const v = (value ?? {}) as Partial<Record<keyof AlertChannels, unknown>>;
  return { discord: v.discord === true, text: v.text === true };
}

export type SendChannel = 'push' | keyof AlertChannels;

/**
 * Episodes already sent outside the hub, per channel. A hub restarted within
 * the announce window sees a peer's alert as new, and would send it again.
 * A bare episode is from before channels were kept apart: it went out on all.
 */
export class SentLedger {
  private sent: string[];

  constructor(private file = SENT_FILE) {
    try {
      this.sent = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as string[]) : [];
    } catch {
      this.sent = [];
    }
  }

  has = (episode: string, channel: SendChannel = 'push') => this.sent.includes(episode) || this.sent.includes(`${channel}:${episode}`);

  /** True the first time an episode is claimed on a channel. */
  claim(episode: string, channel: SendChannel = 'push'): boolean {
    if (this.has(episode, channel)) return false;
    this.sent = [...this.sent, `${channel}:${episode}`].slice(-SENT_KEEP);
    try {
      writeFileSync(this.file, JSON.stringify(this.sent));
    } catch (err) {
      console.warn(`[attention] cannot save ${this.file}: ${err}`);
    }
    return true;
  }
}

/**
 * Send one alert outward. The card holds the session's choice: it comes from
 * the owning hub with alertedAt in the same message, so a change made during
 * the wait counts on whichever hub sends. A channel that is off claims nothing.
 */
export function sendAlert(
  event: AttentionEvent,
  card: Pick<SessionInfo, 'alerts'>,
  ledger: Pick<SentLedger, 'claim'>,
  send: Record<SendChannel, (event: AttentionEvent) => unknown>,
) {
  const on = alertChannels(card.alerts);
  if (ledger.claim(event.episode, 'push')) void send.push(event);
  if (on.discord && ledger.claim(event.episode, 'discord')) void send.discord(event);
  if (on.text && ledger.claim(event.episode, 'text')) void send.text(event);
}

/** One announcement per episode from the merged fleet cards, and one when it ends. */
export class FleetAttention {
  private live = new Map<string, AttentionCleared>();

  constructor(private out: { announce: (e: AttentionEvent, card: SessionInfo) => void; cleared: (e: AttentionCleared) => void }) {}

  scan(sessions: SessionInfo[], now = Date.now()) {
    const present = new Set<string>();
    for (const s of sessions) {
      const a = s.attention;
      if (!a?.alertedAt) continue;
      present.add(a.episode);
      if (this.live.has(a.episode)) continue;
      // tracked even when too old to announce: its end still has to be told
      this.live.set(a.episode, { type: 'attention-cleared', episode: a.episode, hubId: s.hubId, conversationId: s.claudeSessionId, machine: s.machine });
      if (now - a.alertedAt <= ANNOUNCE_WITHIN_MS) this.out.announce(attentionEvent(s)!, s);
    }
    for (const [episode, cleared] of this.live) {
      if (present.has(episode)) continue;
      this.live.delete(episode);
      this.out.cleared(cleared);
    }
  }
}

/** Tell the user on Discord through Hermod. Off without a key in data/attention.json. */
export async function sendToDiscord(e: AttentionEvent, config = attentionConfig(), fetcher: typeof fetch = fetch): Promise<boolean> {
  const hermod = config.hermod;
  if (!hermod?.key || !hermod.url) return false;
  const what = e.kind === 'permission' ? 'wants approval' : 'has a question';
  try {
    const res = await fetcher(`${hermod.url.replace(/\/+$/, '')}/api/v1/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hermod.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        person: hermod.person ?? 'cristian',
        channel: 'discord',
        subject: `${e.name}${e.machine ? ` on ${e.machine}` : ''} ${what}`,
        message: e.text,
        operation: 'deckhand-attention',
        correlationId: e.episode,
      }),
      signal: AbortSignal.timeout(HERMOD_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { delivered?: boolean; deferred?: boolean; reason?: string; error?: string };
    if (res.ok && (body.delivered || body.deferred)) return true;
    console.warn(`[attention] Hermod did not deliver ${e.episode}: ${res.status} ${body.error ?? body.reason ?? ''}`);
  } catch (err) {
    console.warn(`[attention] Hermod unreachable for ${e.episode}: ${err}`);
  }
  return false;
}
