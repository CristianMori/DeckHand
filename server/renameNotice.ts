/**
 * A folder rename that ran while a session's conversation was not running.
 * Remembered on the card (and persisted with it) so the conversation is told
 * once, when it is next resumed — the absolute paths in its context are stale.
 */
export interface PendingRename {
  /** old and new folder name */
  from: string;
  to: string;
  /** old and new working directory of the session */
  fromCwd: string;
  toCwd: string;
}

/** Remember a rename on a card. A second rename before the notice keeps the original origin; a rename back cancels the notice. */
export function recordSessionRename(s: { renamed?: PendingRename }, r: PendingRename) {
  const merged = s.renamed ? { ...r, from: s.renamed.from, fromCwd: s.renamed.fromCwd } : r;
  s.renamed = merged.from === merged.to && merged.fromCwd === merged.toCwd ? undefined : merged;
}

/** The one notice a resumed conversation gets about the rename; taking it clears the record. */
export function takeRenameNotice(s: { renamed?: PendingRename }): string | undefined {
  const r = s.renamed;
  if (!r) return undefined;
  s.renamed = undefined;
  return (
    `[Deckhand] This session was renamed from ${r.from} to ${r.to}. ` +
    `Its folder moved from ${r.fromCwd} to ${r.toCwd} on every machine that holds it, with its conversations and memory. ` +
    `Use the new path from now on; old absolute paths in your context are stale.`
  );
}
