import { execFile } from 'node:child_process';
import { existsSync, openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HUB_ROOT } from './config.js';

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
  /**
   * enrolled = holds keys; pending = token minted, not used yet;
   * requested = asked for access, waiting for the user; accepted = the user
   * said yes, the agent has until mintUntil to mint its token
   */
  status: 'enrolled' | 'pending' | 'requested' | 'accepted';
  /** an access request behind this row */
  request?: { id: string; name: string; reason: string; ip: string; createdAt: string; mintUntil?: string };
  enrolledAt?: string;
  tokenExpiresAt?: string;
  lastSeen?: string;
  live: boolean;
  requests: number;
  denied: number;
  lastRequest?: string;
  /** messages to this agent: its webhook, how many wait in its inbox, how the last one went */
  webhook?: string;
  inbox: number;
  lastMessage?: { at: string; delivered: string; webhookError?: string };
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
    if (!agents.has(id)) agents.set(id, { id, status, live: false, requests: 0, denied: 0, inbox: 0 });
    return agents.get(id)!;
  };
  // only current holders: enrolled clients and unused tokens (revoked ones drop off; their log stays)
  // a token that expired unused is no longer valid: it does not list
  for (const p of pending.filter((x) => x.expiresAt > Date.now())) Object.assign(ensure(p.id, 'pending'), { status: 'pending', tokenExpiresAt: new Date(p.expiresAt).toISOString() });
  for (const c of clients as { id: string; enrolledAt?: string; webhook?: string }[]) {
    Object.assign(ensure(c.id, 'enrolled'), {
      status: 'enrolled',
      enrolledAt: c.enrolledAt,
      webhook: c.webhook,
      inbox: readJson<unknown[]>(join(GATEWAY_DIR, 'inbox', `${c.id}.json`), []).length,
    });
  }
  // open access requests wait for the user's ACCEPT / REJECT
  const reqs = readJson<{ id: string; clientId: string; name: string; reason: string; ip: string; createdAt: string; status: string; mintUntil?: number }[]>(
    join(GATEWAY_DIR, 'requests.json'),
    [],
  );
  for (const r of reqs) {
    const open = r.status === 'pending' || (r.status === 'accepted' && (r.mintUntil ?? 0) > Date.now());
    if (!open || agents.has(r.clientId)) continue;
    Object.assign(ensure(r.clientId, r.status === 'pending' ? 'requested' : 'accepted'), {
      request: { id: r.id, name: r.name, reason: r.reason, ip: r.ip, createdAt: r.createdAt, ...(r.mintUntil ? { mintUntil: new Date(r.mintUntil).toISOString() } : {}) },
    });
  }
  for (const l of lines as (GatewayLogLine & { delivered?: string; webhookError?: string })[]) {
    if (l.event === 'message' && l.client && agents.has(l.client)) {
      agents.get(l.client)!.lastMessage = { at: l.at, delivered: l.delivered ?? '?', ...(l.webhookError ? { webhookError: l.webhookError } : {}) };
      continue;
    }
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
  // requests waiting for a decision first, then by last interaction
  const rank = (a: GatewayAgent) => (a.status === 'requested' ? 0 : a.status === 'accepted' ? 1 : 2);
  return [...agents.values()].sort((x, y) => rank(x) - rank(y) || (y.lastSeen ?? '').localeCompare(x.lastSeen ?? '') || x.id.localeCompare(y.id));
}

/** Every logged line about one client, newest first. */
export function gatewayAgentLog(id: string, limit: number): GatewayLogLine[] {
  return logLines()
    .filter((l) => l.client === id)
    .reverse()
    .slice(0, limit);
}

/** Accept or reject an access request through the gateway's own CLI (it owns its files). */
export function decideRequest(requestId: string, decision: 'accept' | 'reject'): Promise<{ id: string; clientId: string; name: string; reason: string; status: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [join(HUB_ROOT, 'gateway', 'deckhand-gateway.mjs'), decision, requestId],
      { env: { ...process.env, DECKHAND_GATEWAY_DIR: GATEWAY_DIR, DECKHAND_GATEWAY_LOG: GATEWAY_LOG }, timeout: 15_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim()));
        try {
          resolve(JSON.parse(String(stdout).trim().split('\n').pop() ?? ''));
        } catch {
          reject(new Error('gateway gave no answer'));
        }
      },
    );
  });
}

/** Hand a message to the gateway: pushed to the agent's webhook, or left in its inbox. */
export function sendAgentMessage(clientId: string, from: string, text: string, extra: { taskId?: string; inReplyTo?: string } = {}): Promise<{ id: string; delivered: 'webhook' | 'inbox'; webhookError?: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [join(HUB_ROOT, 'gateway', 'deckhand-gateway.mjs'), 'message', clientId],
      { env: { ...process.env, DECKHAND_GATEWAY_DIR: GATEWAY_DIR, DECKHAND_GATEWAY_LOG: GATEWAY_LOG }, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim()));
        try {
          resolve(JSON.parse(String(stdout).trim().split('\n').pop() ?? ''));
        } catch {
          reject(new Error('gateway gave no answer'));
        }
      },
    );
    child.stdin?.end(JSON.stringify({ from, text, ...extra }));
  });
}

/** Revoke a client through the gateway's CLI: its key and any pending token go. */
export function revokeAgent(clientId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [join(HUB_ROOT, 'gateway', 'deckhand-gateway.mjs'), 'revoke', clientId],
      { env: { ...process.env, DECKHAND_GATEWAY_DIR: GATEWAY_DIR, DECKHAND_GATEWAY_LOG: GATEWAY_LOG }, timeout: 15_000 },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout).trim())),
    );
  });
}
