import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

/**
 * Fleet folder renames, remembered so a machine that was offline catches up
 * when it comes back. Every hub keeps the log and copies entries it has not
 * seen from its peers, so the news spreads even when the renaming hub is
 * down. `seen` holds the entries this machine has already dealt with —
 * applied, or decided not to — so a folder created later under an old name
 * is never renamed behind anyone's back.
 */
export interface RenameEntry {
  id: string;
  from: string;
  to: string;
  at: number;
  /** machine that ran the rename */
  by: string;
}

const FILE = join(DATA_DIR, 'renames.json');
const KEEP_MS = 180 * 24 * 3600_000;

let entries: RenameEntry[] = [];
let seen = new Set<string>();
try {
  if (existsSync(FILE)) {
    const j = JSON.parse(readFileSync(FILE, 'utf8')) as { entries?: RenameEntry[]; seen?: string[] };
    entries = j.entries ?? [];
    seen = new Set(j.seen ?? []);
  }
} catch {
  /* fresh */
}

function save() {
  const cutoff = Date.now() - KEEP_MS;
  entries = entries.filter((e) => e.at > cutoff);
  const ids = new Set(entries.map((e) => e.id));
  seen = new Set([...seen].filter((id) => ids.has(id)));
  writeFileSync(FILE, JSON.stringify({ entries, seen: [...seen] }, null, 2));
}

/** A rename that just ran here (or that this machine took part in): logged and already seen. */
export function recordRename(from: string, to: string, by: string, id: string = randomUUID(), at = Date.now()): RenameEntry {
  let e = entries.find((x) => x.id === id);
  if (!e) {
    e = { id, from, to, at, by };
    entries.push(e);
  }
  seen.add(id);
  save();
  return e;
}

export function renameLog(): RenameEntry[] {
  return entries;
}

/** Add entries learned from a peer; returns how many were new. */
export function mergeRenames(incoming: RenameEntry[]): number {
  let added = 0;
  const cutoff = Date.now() - KEEP_MS;
  for (const e of incoming) {
    if (!e?.id || typeof e.from !== 'string' || typeof e.to !== 'string' || !(e.at > cutoff)) continue;
    if (entries.some((x) => x.id === e.id)) continue;
    entries.push({ id: e.id, from: e.from, to: e.to, at: e.at, by: String(e.by ?? '') });
    added++;
  }
  if (added) save();
  return added;
}

/** Entries this machine has not dealt with yet, oldest first (so a→b→c applies in order). */
export function unseenRenames(): RenameEntry[] {
  return entries.filter((e) => !seen.has(e.id)).sort((a, b) => a.at - b.at);
}

export function markRenameSeen(id: string) {
  seen.add(id);
  save();
}
