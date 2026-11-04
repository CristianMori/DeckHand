// DOM-free so the server test suite can exercise the ordering.
import type { SessionInfo, SessionState } from './types.js';

// needs attention first, then what is being worked on, then the rest;
// cards of an unreachable machine always sink to the bottom
const STATE_RANK: Record<SessionState, number> = {
  WAITING_QUESTION: 0,
  WAITING_PERMISSION: 0,
  WORKING: 1,
  STARTING: 1,
  IDLE: 2,
  EXITED: 3,
};
const UNREACHABLE_RANK = 4;

function rankOf(s: SessionInfo): number {
  return s.unreachable ? UNREACHABLE_RANK : STATE_RANK[s.state];
}

/** When the session last did something: pty output, else its last state change, else birth. */
const lastActive = (s: SessionInfo) => s.lastOutputAt || s.stateSince || s.createdAt;

/**
 * Orders the sessions it is given against each other — in the card list this is
 * the ROOTS only (architects and plain sessions): a family sits where its
 * topmost parent puts it, never where a child's state would.
 */
export function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    // architects always lead the list, the most recently active first — never
    // by state rank: a waiting architect does not jump above a busier one
    const arch = Number(b.role === 'architect') - Number(a.role === 'architect');
    if (arch !== 0) return arch;
    if (a.role === 'architect') return lastActive(b) - lastActive(a);
    const rank = rankOf(a) - rankOf(b);
    if (rank !== 0) return rank;
    if (rankOf(a) === 0) return a.stateSince - b.stateSince; // oldest wait first
    // within working, idle and exited: the card that entered the state most
    // recently sits at the top of its band — a session that just finished
    // lands right under the working ones, a session that just exited lands
    // right under the idle ones, each pushing its older siblings down one
    if (rankOf(a) >= 1 && rankOf(a) <= 3) return b.stateSince - a.stateSince;
    return b.createdAt - a.createdAt;
  });
}

export interface OrderedCard {
  session: SessionInfo;
  depth: number;
}

/** Done for good: its report (or failure) is in; the card leaves the list. */
export const finished = (s: SessionInfo) =>
  !s.alive && (s.worker?.status === 'reported' || s.worker?.status === 'failed');

/** Siblings keep a stable order: by when their task started (else birth), never by status. */
const siblingKey = (s: SessionInfo) => s.worker?.startedAt || s.createdAt;

/** Does this card match the filter text? Name, folder/cwd, machine and role all count. */
export function matchesFilter(s: SessionInfo, needle: string): boolean {
  if (!needle) return true;
  const role = s.role === 'role' ? s.worker?.charter || 'role' : (s.role ?? '');
  return [s.name, s.cwd, s.machine ?? '', role].some((v) => v.toLowerCase().includes(needle));
}

/**
 * The card list, flattened: each family is one block — the root first, its
 * crew under it (two levels at most), siblings in a stable start-time order.
 * Only the ROOT's state and activity place the block in the list, so a
 * child's status change never moves the family or reorders its siblings.
 * `filter` (case-insensitive) keeps a card when it, an ancestor or a
 * descendant matches, so the tree around a match stays readable.
 */
export function orderSessions(sessions: SessionInfo[], filter = ''): OrderedCard[] {
  const needle = filter.trim().toLowerCase();
  const hasLead = (s: SessionInfo) =>
    !!s.worker && sessions.some((x) => x !== s && x.claudeSessionId === s.worker!.architect);
  const crewOf = (s: SessionInfo) =>
    sessions
      .filter((w) => w !== s && w.worker?.architect === s.claudeSessionId)
      .sort((a, b) => siblingKey(a) - siblingKey(b) || a.hubId.localeCompare(b.hubId));
  // a finished sub-architect stays while a worker of its own is still going
  const shows = (s: SessionInfo): boolean => !finished(s) || crewOf(s).some(shows);
  const subtreeMatches = (s: SessionInfo): boolean =>
    matchesFilter(s, needle) || crewOf(s).some(subtreeMatches);

  const out: OrderedCard[] = [];
  const add = (s: SessionInfo, depth: number, ancestorMatched: boolean) => {
    const selfOk = ancestorMatched || matchesFilter(s, needle);
    if (!selfOk && !crewOf(s).some(subtreeMatches)) return;
    out.push({ session: s, depth });
    if (depth < 2) for (const w of crewOf(s)) if (shows(w)) add(w, depth + 1, selfOk);
  };
  for (const s of sortSessions(sessions.filter((s) => !hasLead(s)))) add(s, 0, false);
  return out;
}
