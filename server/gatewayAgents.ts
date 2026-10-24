import { existsSync, openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The public gateway's clients, as the admin view shows them: who was given
 * a token, whether they enrolled, whether they are active now, when they last
 * did something, and every request they made. Read straight from the
 * gateway's own files on the machine that runs it (the gateway opens no
 * admin port: anything it listens on is public through Funnel).
 */

export const GATEWAY_DIR = process.env.DECKHAND_GATEWAY_DIR || '/etc/deckhand-gateway';
export const GATEWAY_LOG = process.env.DECKHAND_GATEWAY_LOG || '/var/log/deckhand-gateway/audit.log';
/** a client counts as live when it made an authenticated request this recently */
const LIVE_MS = 5 * 60_000;
/** how much of the audit log (from its end) the summaries look at */
const TAIL_BYTES = 8 * 1024 * 1024;

export interface GatewayAgent {
  id: string;
  /** enrolled = holds keys; pending = token minted, not used yet; revoked = had a key, gone now */
  status: 'enrolled' | 'pending' | 'revoked';
  enrolledAt?: string;
  tokenExpiresAt?: string;
  lastSeen?: string;
  live: boolean;
  requests: number;
  denied: number;
  lastRequest?: string;
}

export interface GatewayLogLine {
  at: string;
  ip?: string;
  method?: string;
  path?: string;
  status?: number;
  ms?: number;
  client?: string;
  event?: string;
  authError?: string;
  text?: string;
  req?: string;
}

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback;
  } catch {
    return fallback;
  }
};

function tail(file: string, bytes: number): string[] {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // partial first line
    return lines.filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

function logLines(): GatewayLogLine[] {
  const out: GatewayLogLine[] = [];
  for (const l of tail(GATEWAY_LOG, TAIL_BYTES)) {
    try {
      out.push(JSON.parse(l));
    } catch {
      /* torn line */
    }
  }
  return out;
}

export function gatewayPresent(): boolean {
  return existsSync(GATEWAY_DIR);
}

export function gatewayAgents(): GatewayAgent[] {
  const clients = readJson<{ id: string; enrolledAt?: string }[]>(join(GATEWAY_DIR, 'clients.json'), []);
  const pending = readJson<{ id: string; expiresAt: number }[]>(join(GATEWAY_DIR, 'bootstrap.json'), []);
  const lines = logLines();
  const agents = new Map<string, GatewayAgent>();
  const ensure = (id: string, status: GatewayAgent['status']) => {
    if (!agents.has(id)) agents.set(id, { id, status, live: false, requests: 0, denied: 0 });
    return agents.get(id)!;
  };
  // everyone who ever got a token shows up, revoked ones included
  for (const l of lines) {
    if (l.event === 'bootstrap' && l.client) ensure(l.client, 'revoked');
    if (l.event === 'enroll' && l.client && l.status === 200) ensure(l.client, 'revoked');
  }
  for (const p of pending) Object.assign(ensure(p.id, 'pending'), { status: 'pending', tokenExpiresAt: new Date(p.expiresAt).toISOString() });
  for (const c of clients) Object.assign(ensure(c.id, 'enrolled'), { status: 'enrolled', enrolledAt: c.enrolledAt });
  for (const l of lines) {
    if (!l.client || !agents.has(l.client) || l.event) continue;
    const a = agents.get(l.client)!;
    if (l.status === 401) {
      a.denied++;
      continue;
    }
    a.requests++;
    a.lastSeen = l.at;
    a.lastRequest = `${l.method} ${l.path} → ${l.status}`;
  }
  const now = Date.now();
  for (const a of agents.values()) a.live = a.status === 'enrolled' && !!a.lastSeen && now - Date.parse(a.lastSeen) < LIVE_MS;
  return [...agents.values()].sort((x, y) => (y.lastSeen ?? '').localeCompare(x.lastSeen ?? '') || x.id.localeCompare(y.id));
}

/** Every logged line about one client, newest first. */
export function gatewayAgentLog(id: string, limit: number): GatewayLogLine[] {
  return logLines()
    .filter((l) => l.client === id)
    .reverse()
    .slice(0, limit);
}
