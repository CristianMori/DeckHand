import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type express from 'express';
import { DATA_DIR } from './config.js';

/**
 * Provenance: who asked this hub to do what, on whose behalf, through which
 * machines. Every request that changes something — and every read made by an
 * agent, a gateway client or another hub's user action — becomes one JSON line
 * in data/provenance.jsonl. A request keeps its id as it is forwarded between
 * hubs (X-Deckhand-Request), the caller travels with it (X-Deckhand-Caller),
 * and each hop adds itself to X-Deckhand-Via, so one action can be followed
 * across the fleet.
 *
 * Callers: "session:<hubId>/<conversation>@<machine>" (an agent, stamped by
 * the deckhand MCP server), "gateway:<client>" (the public gateway),
 * "hub:<machine>" (a hub acting on its own: sync, catch-up), "dashboard"
 * (a browser), or "api" (anything else).
 */

export interface TraceContext {
  id: string;
  caller: string;
  via: string[];
}

export interface ProvenanceEntry {
  id: string;
  at: string;
  machine: string;
  caller: string;
  via: string[];
  ip: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  /** the session the request acted on, when there is one */
  target?: { id: string; hubId?: string; name?: string; conversationId?: string };
  /** what was asked: prompt text, command, new name, fact — first 300 characters */
  detail?: string;
}

const FILE = join(DATA_DIR, 'provenance.jsonl');
const ROTATE_BYTES = 20 * 1024 * 1024;
const KEEP_FILES = 5;

const store = new AsyncLocalStorage<TraceContext>();
let selfName = () => 'this machine';

export function initProvenance(self: () => string) {
  selfName = self;
}

/** Headers that carry the current trace to another hub (or a fresh hub-originated one). */
export function traceHeaders(): Record<string, string> {
  const ctx = store.getStore();
  const self = selfName();
  return {
    'X-Deckhand-Request': ctx?.id ?? randomUUID(),
    'X-Deckhand-Caller': ctx?.caller ?? `hub:${self}`,
    'X-Deckhand-Via': [...(ctx?.via ?? []), self].join(','),
  };
}

/** The trace of the request being handled (undefined outside one). */
export function currentTrace(): TraceContext | undefined {
  return store.getStore();
}

const header = (req: express.Request, name: string) => {
  const v = req.headers[name.toLowerCase()];
  return (Array.isArray(v) ? v[0] : v ?? '').slice(0, 300);
};

function callerOf(req: express.Request): string {
  const stated = header(req, 'X-Deckhand-Caller').replace(/[^\w:./@()\- ]/g, '');
  if (stated) return stated;
  return /mozilla/i.test(header(req, 'User-Agent')) ? 'dashboard' : 'api';
}

/** Which requests are worth a line: every change, and reads made by agents, gateway clients or people elsewhere. */
function worthLogging(req: express.Request, caller: string): boolean {
  if (!req.path.startsWith('/api/')) return false;
  if (req.path === '/api/hook') return false; // agents' own lifecycle hooks, many per turn
  if (req.method !== 'GET' && req.method !== 'HEAD') return true;
  // a hub's background polling (sync, catch-up, memory pulls) is not an action
  if (caller.startsWith('hub:')) return false;
  return caller !== 'dashboard' && caller !== 'api';
}

function detailOf(req: express.Request): string | undefined {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const pick = [b.text, b.command, b.name, b.fact, b.keys, b.folder, b.targetAgent].find((v) => v !== undefined && v !== '');
  if (pick === undefined) return undefined;
  return (typeof pick === 'string' ? pick : JSON.stringify(pick)).slice(0, 300);
}

function write(entry: ProvenanceEntry) {
  try {
    if (existsSync(FILE) && statSync(FILE).size > ROTATE_BYTES) {
      for (let i = KEEP_FILES - 1; i >= 1; i--) {
        const from = `${FILE}.${i}`;
        if (existsSync(from)) renameSync(from, `${FILE}.${i + 1}`);
      }
      renameSync(FILE, `${FILE}.1`);
    }
    appendFileSync(FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.warn(`[provenance] ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Express middleware: opens the trace for this request (adopting the id and
 * caller a forwarding hub sent) and writes the line when the answer goes out.
 * `describe` names the session a path points at.
 */
export function provenanceMiddleware(
  describe: (id: string) => ProvenanceEntry['target'] | undefined,
): express.RequestHandler {
  return (req, res, next) => {
    const caller = callerOf(req);
    const ctx: TraceContext = {
      id: header(req, 'X-Deckhand-Request').replace(/[^\w-]/g, '').slice(0, 64) || randomUUID(),
      caller,
      via: header(req, 'X-Deckhand-Via').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10),
    };
    res.setHeader('X-Deckhand-Request', ctx.id);
    const started = Date.now();
    res.on('finish', () => {
      if (!worthLogging(req, caller)) return;
      const sid = /^\/api\/sessions\/([^/]+)/.exec(req.path)?.[1];
      const target = sid && sid !== 'adopt' ? (describe(sid) ?? { id: sid }) : undefined;
      write({
        id: ctx.id,
        at: new Date(started).toISOString(),
        machine: selfName(),
        caller,
        via: ctx.via,
        ip: req.socket.remoteAddress ?? '',
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
        ...(target ? { target } : {}),
        ...(detailOf(req) ? { detail: detailOf(req) } : {}),
      });
    });
    store.run(ctx, () => next());
  };
}

/** Newest first, filtered; reads the current file and the rotated ones as needed. */
export function readProvenance(opts: { limit: number; q?: string; id?: string; since?: number }): ProvenanceEntry[] {
  const out: ProvenanceEntry[] = [];
  const q = opts.q?.toLowerCase();
  for (const file of [FILE, ...Array.from({ length: KEEP_FILES }, (_, i) => `${FILE}.${i + 1}`)]) {
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n').reverse();
    for (const line of lines) {
      if (!line) continue;
      if (q && !line.toLowerCase().includes(q)) continue;
      let e: ProvenanceEntry;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (opts.id && e.id !== opts.id) continue;
      if (opts.since && Date.parse(e.at) < opts.since) return out;
      out.push(e);
      if (out.length >= opts.limit) return out;
    }
  }
  return out;
}
