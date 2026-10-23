import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

/**
 * Fleet memory: small facts every session on every machine shares — "the
 * user has the Apple Developer subscription", "WSL2 + Ubuntu 22.04 is on the
 * laptop for ROS2". Facts about the world around the code, not about the code.
 *
 * One machine holds the truth (the store machine, normally the always-on
 * VPS). Every hub keeps a SQLite replica so recall and the start-of-session
 * briefing work when the VPS is out of reach. Writes go to the authority,
 * which numbers every change (`seq`); replicas pull the changes after their
 * cursor. A write made while the authority is unreachable lands locally and
 * waits in an outbox. Deletes are tombstones so they replicate too.
 */

export type MemoryScope = 'global' | 'machine' | 'project';

export interface Memory {
  id: string;
  fact: string;
  scope: MemoryScope;
  /** set for scope=machine */
  machine: string | null;
  /** project folder name, set for scope=project */
  project: string | null;
  tags: string;
  originSession: string;
  originMachine: string;
  originFolder: string;
  createdAt: number;
  updatedAt: number;
  /** the user said "remember this": listed first, never pruned */
  instructed: boolean;
  deleted: boolean;
  /** authority's change number; 0 = written here, not yet confirmed */
  seq: number;
}

export type MemoryOp =
  | { op: 'upsert'; memory: Memory }
  | { op: 'forget'; id: string }
  | { op: 'renameProject'; from: string; to: string };

export const MAX_FACT = 500;
const MAX_TAGS = 200;
/** live, non-instructed memories kept before the oldest are pruned */
const MAX_LIVE = 400;
const TOMBSTONE_MS = 90 * 24 * 3600_000;
/** budget for the start-of-session block (it rides on the command line) */
const BRIEF_CHARS = 6000;

type Db = import('node:sqlite').DatabaseSync;
let db: Db | undefined;

export interface MemoryDeps {
  selfName: () => string;
  authorityName: string;
  /** call the authority hub; undefined when it is not connected */
  callAuthority: (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: unknown } | undefined>;
}
let deps: MemoryDeps | undefined;

const isAuthority = () => !!deps && deps.selfName() === deps.authorityName;

export async function initFleetMemory(d: MemoryDeps): Promise<void> {
  deps = d;
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as typeof import('node:sqlite');
    db = new DatabaseSync(join(DATA_DIR, 'memories.sqlite'));
    db.exec(`
      create table if not exists memories (
        id text primary key, fact text not null, scope text not null, machine text, project text,
        tags text not null default '', origin_session text, origin_machine text, origin_folder text,
        created_at integer not null, updated_at integer not null,
        instructed integer not null default 0, deleted integer not null default 0, seq integer not null default 0);
      create index if not exists memories_seq on memories(seq);
      create virtual table if not exists memories_fts using fts5(id unindexed, fact, tags);
      create table if not exists outbox (n integer primary key autoincrement, op text not null);
      create table if not exists meta (k text primary key, v integer not null);
    `);
  } catch (err) {
    db = undefined;
    console.warn(`[memory] no local replica (${err instanceof Error ? err.message : err}): recall goes to ${d.authorityName}`);
  }
  setTimeout(() => void syncMemories(), 15_000).unref();
  setInterval(() => void syncMemories(), 60_000).unref();
}

// ------------------------------------------------------------------ storage

interface Row {
  id: string; fact: string; scope: string; machine: string | null; project: string | null; tags: string;
  origin_session: string | null; origin_machine: string | null; origin_folder: string | null;
  created_at: number; updated_at: number; instructed: number; deleted: number; seq: number;
}

const fromRow = (r: Row): Memory => ({
  id: r.id, fact: r.fact, scope: r.scope as MemoryScope, machine: r.machine, project: r.project, tags: r.tags,
  originSession: r.origin_session ?? '', originMachine: r.origin_machine ?? '', originFolder: r.origin_folder ?? '',
  createdAt: r.created_at, updatedAt: r.updated_at, instructed: !!r.instructed, deleted: !!r.deleted, seq: r.seq,
});

function meta(k: string): number {
  const r = db!.prepare('select v from meta where k = ?').get(k) as { v: number } | undefined;
  return r?.v ?? 0;
}
function setMeta(k: string, v: number) {
  db!.prepare('insert into meta(k, v) values(?, ?) on conflict(k) do update set v = excluded.v').run(k, v);
}

function getRow(id: string): Memory | undefined {
  const r = db!.prepare('select * from memories where id = ?').get(id) as Row | undefined;
  return r && fromRow(r);
}

/** Write one memory as given (replicas mirror the authority's copy exactly). */
function put(m: Memory) {
  db!.prepare(
    `insert into memories(id, fact, scope, machine, project, tags, origin_session, origin_machine, origin_folder,
       created_at, updated_at, instructed, deleted, seq) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     on conflict(id) do update set fact=excluded.fact, scope=excluded.scope, machine=excluded.machine,
       project=excluded.project, tags=excluded.tags, updated_at=excluded.updated_at, instructed=excluded.instructed,
       deleted=excluded.deleted, seq=excluded.seq`,
  ).run(m.id, m.fact, m.scope, m.machine, m.project, m.tags, m.originSession, m.originMachine, m.originFolder,
    m.createdAt, m.updatedAt, m.instructed ? 1 : 0, m.deleted ? 1 : 0, m.seq);
  db!.prepare('delete from memories_fts where id = ?').run(m.id);
  if (!m.deleted) db!.prepare('insert into memories_fts(id, fact, tags) values(?, ?, ?)').run(m.id, m.fact, m.tags);
}

/** Resolve a full id from an id or a unique prefix of one (live memories only). */
function resolveId(id: string): string | undefined {
  const hits = db!.prepare('select id from memories where id like ? and deleted = 0').all(`${id}%`) as { id: string }[];
  return hits.length === 1 ? hits[0].id : hits.find((h) => h.id === id)?.id;
}

// -------------------------------------------------------- authority: changes

/**
 * Apply one change on the authority: number it, dedupe, prune. Returns the
 * rows it touched, as stored.
 */
export function applyOnAuthority(op: MemoryOp): Memory[] {
  if (!db) throw new Error('fleet memory store is unavailable on this machine');
  const touched: Memory[] = [];
  const stamp = (m: Memory) => {
    const seq = meta('seq') + 1;
    setMeta('seq', seq);
    const out = { ...m, seq };
    put(out);
    touched.push(out);
  };
  db.exec('begin');
  try {
    if (op.op === 'upsert') {
      const m = clean(op.memory);
      // the same fact said again in the same scope refreshes the old one
      const dup = db.prepare(
        `select * from memories where deleted = 0 and id <> ? and lower(trim(fact)) = lower(trim(?)) and scope = ?
           and coalesce(machine, '') = coalesce(?, '') and lower(coalesce(project, '')) = lower(coalesce(?, ''))`,
      ).get(m.id, m.fact, m.scope, m.machine, m.project) as Row | undefined;
      const existing = getRow(m.id);
      if (dup && !existing) {
        const d = fromRow(dup);
        stamp({ ...d, updatedAt: Date.now(), instructed: d.instructed || m.instructed, tags: mergeTags(d.tags, m.tags) });
      } else {
        stamp({ ...m, createdAt: existing?.createdAt ?? m.createdAt, updatedAt: Date.now(), deleted: false });
      }
    } else if (op.op === 'forget') {
      const m = getRow(op.id);
      if (m && !m.deleted) stamp({ ...m, deleted: true, updatedAt: Date.now() });
    } else if (op.op === 'renameProject') {
      const rows = db.prepare('select * from memories where deleted = 0 and lower(project) = lower(?)').all(op.from) as unknown as Row[];
      for (const r of rows) stamp({ ...fromRow(r), project: op.to, updatedAt: Date.now() });
    }
    prune(stamp);
    db.exec('commit');
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
  return touched;
}

function prune(stamp: (m: Memory) => void) {
  const live = db!.prepare('select * from memories where deleted = 0 and instructed = 0 order by updated_at desc').all() as unknown as Row[];
  for (const r of live.slice(MAX_LIVE)) stamp({ ...fromRow(r), deleted: true, updatedAt: Date.now() });
  // tombstones go for good after a while; a replica that slept longer gets a full copy
  const cutoff = Date.now() - TOMBSTONE_MS;
  const gone = db!.prepare('select id, seq from memories where deleted = 1 and updated_at < ?').all(cutoff) as { id: string; seq: number }[];
  if (gone.length) {
    setMeta('purged', Math.max(meta('purged'), ...gone.map((g) => g.seq)));
    for (const g of gone) db!.prepare('delete from memories where id = ?').run(g.id);
  }
}

/** Changes after `since`, or everything (full=true) when the replica slept through a purge. */
export function changesSince(since: number): { rows: Memory[]; full: boolean; seq: number } {
  if (!db) throw new Error('fleet memory store is unavailable on this machine');
  const full = since < meta('purged');
  const rows = (db.prepare('select * from memories where seq > ? order by seq').all(full ? 0 : since) as unknown as Row[]).map(fromRow);
  return { rows, full, seq: meta('seq') };
}

// ------------------------------------------------------------- replica sync

let syncing = false;
/** Push queued writes to the authority, then pull its changes. */
export async function syncMemories(): Promise<void> {
  if (!deps || !db || isAuthority() || syncing) return;
  syncing = true;
  try {
    const queued = db.prepare('select n, op from outbox order by n').all() as { n: number; op: string }[];
    for (const q of queued) {
      const out = await deps.callAuthority('/api/memories/apply', { method: 'POST', body: JSON.parse(q.op) });
      if (!out) return; // authority not connected: try next round
      if (out.status !== 200 && out.status !== 400) return;
      db.prepare('delete from outbox where n = ?').run(q.n);
      // the authority merged it into an older copy (or refused it): drop the local draft
      const op = JSON.parse(q.op) as MemoryOp;
      const kept = out.status === 200 ? (out.body as { rows: Memory[] }).rows : [];
      if (op.op === 'upsert' && !kept.some((m) => m.id === op.memory.id)) {
        db.prepare('delete from memories where id = ? and seq = 0').run(op.memory.id);
        db.prepare('delete from memories_fts where id = ?').run(op.memory.id);
      }
    }
    const out = await deps.callAuthority(`/api/memories/changes?since=${meta('cursor')}`);
    if (!out || out.status !== 200) return;
    const { rows, full, seq } = out.body as { rows: Memory[]; full: boolean; seq: number };
    db.exec('begin');
    try {
      if (full) {
        // keep local writes the authority has not confirmed yet
        db.exec('delete from memories where seq > 0');
        db.exec('delete from memories_fts where id not in (select id from memories)');
      }
      for (const m of rows) put(m);
      setMeta('cursor', seq);
      db.exec('commit');
    } catch (err) {
      db.exec('rollback');
      throw err;
    }
  } catch (err) {
    console.warn(`[memory] sync: ${err instanceof Error ? err.message : err}`);
  } finally {
    syncing = false;
  }
}

/**
 * A change made on this hub: straight to the authority when it is here or
 * reachable, else applied locally and queued.
 */
async function submit(op: MemoryOp): Promise<{ rows: Memory[]; queued: boolean }> {
  if (!deps) throw new Error('fleet memory is not initialized');
  if (isAuthority()) return { rows: applyOnAuthority(op), queued: false };
  let out: { status: number; body: unknown } | undefined;
  try {
    out = await deps.callAuthority('/api/memories/apply', { method: 'POST', body: op });
  } catch {
    /* unreachable: queue below */
  }
  if (out?.status === 200) {
    const rows = (out.body as { rows: Memory[] }).rows;
    if (db) for (const m of rows) put(m);
    void syncMemories();
    return { rows, queued: false };
  }
  if (out?.status === 400) throw new Error(String((out.body as { error?: string })?.error ?? 'refused'));
  if (!db) throw new Error(`${deps.authorityName} is unreachable and this machine has no local memory store`);
  db.prepare('insert into outbox(op) values(?)').run(JSON.stringify(op));
  const rows: Memory[] = [];
  if (op.op === 'upsert') {
    put({ ...op.memory, seq: 0 });
    rows.push(op.memory);
  } else if (op.op === 'forget') {
    const m = getRow(op.id);
    if (m) put({ ...m, deleted: true, updatedAt: Date.now() });
  }
  return { rows, queued: true };
}

// ------------------------------------------------------------------- the API

function clean(m: Memory): Memory {
  const scope: MemoryScope = m.scope === 'machine' || m.scope === 'project' ? m.scope : 'global';
  return {
    ...m,
    fact: m.fact.trim().slice(0, MAX_FACT),
    scope,
    machine: scope === 'machine' ? m.machine || m.originMachine || null : null,
    project: scope === 'project' ? m.project || m.originFolder || null : null,
    tags: m.tags.trim().slice(0, MAX_TAGS),
  };
}

function mergeTags(a: string, b: string): string {
  const all = new Set(`${a} ${b}`.split(/[\s,]+/).filter(Boolean));
  return [...all].join(' ').slice(0, MAX_TAGS);
}

export interface RememberInput {
  fact: string;
  scope?: string;
  machine?: string;
  project?: string;
  tags?: string;
  instructed?: boolean;
  originSession?: string;
  originMachine?: string;
  originFolder?: string;
}

export async function remember(i: RememberInput): Promise<{ memory: Memory; queued: boolean }> {
  const fact = (i.fact ?? '').trim();
  if (!fact) throw new Error('fact is empty');
  if (fact.length > MAX_FACT) throw new Error(`fact is ${fact.length} characters; keep it under ${MAX_FACT}`);
  const scope = (i.scope ?? 'global') as MemoryScope;
  if (!['global', 'machine', 'project'].includes(scope)) throw new Error('scope: global, machine or project');
  const now = Date.now();
  const memory = clean({
    id: randomUUID(),
    fact,
    scope,
    machine: i.machine ?? null,
    project: i.project ?? null,
    tags: i.tags ?? '',
    originSession: i.originSession ?? '',
    originMachine: i.originMachine ?? deps?.selfName() ?? '',
    originFolder: i.originFolder ?? '',
    createdAt: now,
    updatedAt: now,
    instructed: !!i.instructed,
    deleted: false,
    seq: 0,
  });
  if (memory.scope === 'project' && !memory.project) throw new Error('scope project needs a project folder');
  const { rows, queued } = await submit({ op: 'upsert', memory });
  return { memory: rows[0] ?? memory, queued };
}

export async function forget(id: string): Promise<{ id: string; queued: boolean }> {
  let full = id;
  if (db) {
    full = resolveId(id) ?? '';
    if (!full) throw new Error(`no memory ${id} (or the prefix is ambiguous)`);
  }
  const { queued } = await submit({ op: 'forget', id: full });
  return { id: full, queued };
}

/** A project folder was renamed: its memories follow. */
export async function renameProjectMemories(from: string, to: string): Promise<void> {
  await submit({ op: 'renameProject', from, to }).catch((err) => console.warn(`[memory] rename ${from}: ${err}`));
}

/** Full-text search over live memories; every word counts, prefixes match. */
export async function recall(query: string, limit = 20): Promise<Memory[]> {
  if (!db) {
    if (!deps) return [];
    const out = await deps.callAuthority(`/api/memories?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!out || out.status !== 200) throw new Error(`${deps.authorityName} is unreachable and this machine has no local memory store`);
    return out.body as Memory[];
  }
  const words = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!words.length) {
    return (db.prepare('select * from memories where deleted = 0 order by instructed desc, updated_at desc limit ?').all(limit) as unknown as Row[]).map(fromRow);
  }
  const match = words.map((w) => `"${w}"*`).join(' OR ');
  const rows = db.prepare(
    `select m.* from memories_fts f join memories m on m.id = f.id
      where memories_fts match ? and m.deleted = 0 order by bm25(memories_fts), m.instructed desc limit ?`,
  ).all(match, limit) as unknown as Row[];
  return rows.map(fromRow);
}

/** Memories that apply to a session on `machine` in project `project`, instructed first. */
export function memoriesFor(machine: string, project: string | null): Memory[] {
  if (!db) return [];
  const rows = db.prepare(
    `select * from memories where deleted = 0 and (scope = 'global' or (scope = 'machine' and machine = ?)
       or (scope = 'project' and lower(project) = lower(?))) order by instructed desc, updated_at desc`,
  ).all(machine, project ?? '') as unknown as Row[];
  return rows.map(fromRow);
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

export function formatMemory(m: Memory): string {
  const where = m.scope === 'global' ? '' : m.scope === 'machine' ? ` [machine ${m.machine}]` : ` [project ${m.project}]`;
  const tags = m.tags ? ` #${m.tags.split(/[\s,]+/).filter(Boolean).join(' #')}` : '';
  return `- ${m.id.slice(0, 8)}${m.instructed ? ' (told by the user)' : ''}${where} ${m.fact}${tags} — ${day(m.updatedAt)}, ${m.originMachine || '?'}`;
}

/** The block injected at session start: the memories that apply, within budget. */
export function memoryBriefing(machine: string, project: string | null): string {
  const all = memoriesFor(machine, project);
  if (!all.length) return '';
  const lines: string[] = [];
  let size = 0;
  for (const m of all) {
    const line = formatMemory(m);
    if (size + line.length > BRIEF_CHARS) break;
    lines.push(line);
    size += line.length + 1;
  }
  const more = all.length - lines.length;
  return (
    `Fleet memory — facts other sessions recorded about this user's world (id, fact, date, machine; older dated observations may be stale):\n` +
    lines.join('\n') +
    (more ? `\n(${more} more: dh_recall searches them all.)` : '')
  );
}
