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
