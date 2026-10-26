import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type express from 'express';
import { DATA_DIR } from './config.js';
import { TRUST_ORIGIN, trustEntries, type Memory } from './fleetMemory.js';

/**
 * What an outside agent may reach in Deckhand — decided here, by the hub,
 * before a request gets anywhere near a session. Enrollment in Mimir only
 * says who the agent is; access comes from grants the user made in the
 * dashboard's TRUST panel. No grant, no access: not even the session list.
 *
 * Grants are fleet memories with originSession TRUST_ORIGIN (only the
 * /api/trust route writes those) and tags
 *
 *   trusted-agent client:<agent> access:<discover|observe|interact>
 *   folders:<A,B | *>   and/or   sessions:<conversationId,…>
 *
 * so sessions read them in their briefing like any memory, but the decision
 * is made from the tags, in code.
 *
 *   discover  the session appears in lists, its card can be read
 *   observe   + exchanges, screen, wait
 *   interact  + prompt (and project memories in that folder)
 *
 * Calls on an agent's behalf come from Mimir with X-Deckhand-Caller
 * gateway:<agent> and the delegate key (data/delegate.key, read by Mimir on
 * this machine) in X-Deckhand-Delegate-Key. A hub that forwards such a call
 * keeps the caller, so the target hub checks the same grants again.
 */

export type Access = 'discover' | 'observe' | 'interact';
export const ACCESS_LEVELS: Access[] = ['discover', 'observe', 'interact'];
const rank = (a: Access | null) => (a ? ACCESS_LEVELS.indexOf(a) + 1 : 0);

export interface Grant {
  id: string;
  agent: string;
  access: Access;
  /** '*' = every folder */
  folders: string[] | '*';
  sessions: string[];
  fact: string;
  createdAt: number;
  originMachine: string;
}

const tagValue = (tags: string[], key: string) => tags.find((t) => t.toLowerCase().startsWith(`${key}:`))?.slice(key.length + 1);

export function grantOf(m: Memory): Grant | undefined {
  if (m.originSession !== TRUST_ORIGIN || m.deleted) return undefined;
  const tags = m.tags.split(/\s+/).filter(Boolean);
  if (!tags.some((t) => t.toLowerCase() === 'trusted-agent')) return undefined;
  const agent = tagValue(tags, 'client')?.toLowerCase();
  if (!agent) return undefined;
  const access = (tagValue(tags, 'access')?.toLowerCase() ?? 'interact') as Access;
  if (!ACCESS_LEVELS.includes(access)) return undefined;
  const f = tagValue(tags, 'folders');
  const folders = f === '*' ? '*' : (f ?? '').split(',').filter(Boolean);
  const sessions = (tagValue(tags, 'sessions') ?? '').split(',').filter(Boolean);
  if (folders !== '*' && !folders.length && !sessions.length) return undefined;
  return { id: m.id, agent, access, folders, sessions, fact: m.fact, createdAt: m.createdAt, originMachine: m.originMachine };
}

export function allGrants(): Grant[] {
  return trustEntries().map(grantOf).filter((g): g is Grant => !!g);
}

export function grantsFor(agent: string): Grant[] {
  const a = agent.toLowerCase();
  return allGrants().filter((g) => g.agent === a);
}

/**
 * The strongest access any of the agent's grants gives on this session; null = none.
 * A folder grant matches the session's project — the top folder under its
 * hub's projects root, stamped by the owning hub — so it covers everything
 * inside that project (Cassandra → its vet: sessions in subfolders) and never
 * a same-named folder elsewhere. Project folder names are the fleet-wide
 * identity (sync, resume, handoff and rename all key on them). A session
 * outside any projects root has no project: only * or a session grant reaches it.
 */
export function accessTo(agent: string, session: { project?: string | null; claudeSessionId?: string }): Access | null {
  const project = (session.project ?? '').toLowerCase();
  const conv = session.claudeSessionId ?? '';
  let best: Access | null = null;
  for (const g of grantsFor(agent)) {
    const byFolder = g.folders === '*' || (!!project && g.folders.some((f) => f.toLowerCase() === project));
    const bySession = !!conv && g.sessions.some((s) => s === conv || (s.length >= 8 && conv.startsWith(s)));
    if ((byFolder || bySession) && rank(g.access) > rank(best)) best = g.access;
  }
  return best;
}

/** Strongest access on a project folder (folder grants only). */
export function accessToFolder(agent: string, folder: string): Access | null {
  let best: Access | null = null;
  for (const g of grantsFor(agent)) {
    if ((g.folders === '*' || g.folders.some((f) => f.toLowerCase() === folder.toLowerCase())) && rank(g.access) > rank(best)) best = g.access;
  }
  return best;
}

export const atLeast = (have: Access | null, need: Access) => rank(have) >= rank(need);

/** The agent a caller acts for ("gateway:ron" → "ron"), or undefined. */
export function delegatedAgent(caller: string | undefined): string | undefined {
  const m = /^gateway:([\w.@-]+)$/i.exec(caller ?? '');
  return m ? m[1].toLowerCase() : undefined;
}

// ------------------------------------------------------------ delegate key

export const DELEGATE_KEY_FILE = join(DATA_DIR, 'delegate.key');
let delegateKey = '';

/** Mimir's key for calls on an agent's behalf; minted on first start. */
export function loadDelegateKey(): string {
  if (delegateKey) return delegateKey;
  try {
    if (existsSync(DELEGATE_KEY_FILE)) delegateKey = readFileSync(DELEGATE_KEY_FILE, 'utf8').trim();
  } catch {
    /* unreadable — regenerate below */
  }
  if (!delegateKey) {
    delegateKey = randomBytes(32).toString('hex');
    writeFileSync(DELEGATE_KEY_FILE, delegateKey + '\n', { mode: 0o600 });
    console.log(`[access] generated the delegate key in ${DELEGATE_KEY_FILE}`);
  }
  return delegateKey;
}

export function hasDelegateKey(req: express.Request): boolean {
  const v = req.headers['x-deckhand-delegate-key'];
  const given = Buffer.from(String(Array.isArray(v) ? v[0] : v ?? ''));
  const want = Buffer.from(loadDelegateKey());
  return given.length === want.length && timingSafeEqual(given, want);
}

// ------------------------------------------------------------- grant text

/** The memory a grant is stored as: words for people, tags for the hub. */
export function grantMemory(g: { agent: string; access: Access; folders: string[] | '*'; sessions: string[]; sessionNames?: string[]; note?: string }) {
  const where = [
    g.folders === '*' ? 'every folder' : g.folders.length ? `folder${g.folders.length > 1 ? 's' : ''} ${g.folders.join(', ')}` : '',
    g.sessions.length ? `session${g.sessions.length > 1 ? 's' : ''} ${(g.sessionNames?.length ? g.sessionNames : g.sessions.map((s) => s.slice(0, 8))).join(', ')}` : '',
  ].filter(Boolean).join(' and ');
  const verb = g.access === 'interact' ? 'may read and prompt' : g.access === 'observe' ? 'may read (not prompt)' : 'may see (not read or prompt)';
  const fact = `TRUSTED AGENT: ${g.agent} ${verb} ${where}. Enforced by the hub; granted by the user in the TRUST panel.${g.note ? ` ${g.note}` : ''}`;
  const tags = [
    'trusted-agent',
    `client:${g.agent}`,
    `access:${g.access}`,
    g.folders === '*' ? 'folders:*' : g.folders.length ? `folders:${g.folders.join(',')}` : '',
    g.sessions.length ? `sessions:${g.sessions.join(',')}` : '',
  ].filter(Boolean).join(' ');
  return { fact: fact.slice(0, 500), tags };
}

/** A memory that would read as a grant, written anywhere but the TRUST panel. */
export function looksLikeGrant(b: { fact?: unknown; tags?: unknown; originSession?: unknown }): boolean {
  return (
    b.originSession === TRUST_ORIGIN ||
    /(^|\s)#?trusted-agent(\s|$)/i.test(String(b.tags ?? '')) ||
    /^\s*TRUSTED AGENT\s*:/i.test(String(b.fact ?? ''))
  );
}
