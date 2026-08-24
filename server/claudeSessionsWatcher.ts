import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_SESSIONS_DIR } from './config.js';
import type { SessionManager } from './sessionManager.js';
import type { StatusEngine } from './statusEngine.js';
import { SIG_SESSIONS_FILE } from './types.js';

interface ClaudeSessionRecord {
  pid?: number;
  sessionId?: string;
  status?: string; // "busy" | "waiting"
  waitingFor?: string; // e.g. "permission prompt"
  updatedAt?: number;
}

const POLL_MS = 2000;
const STALE_MS = 5 * 60_000;

/**
 * Redundancy layer: Claude Code itself publishes per-session status to
 * ~/.claude/sessions/<pid>.json. Works even if hook injection ever fails.
 */
export function startClaudeSessionsWatcher(manager: SessionManager, engine: StatusEngine) {
  const tick = async () => {
    let files: string[];
    try {
      files = await readdir(CLAUDE_SESSIONS_DIR);
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      let rec: ClaudeSessionRecord;
      try {
        rec = JSON.parse(await readFile(join(CLAUDE_SESSIONS_DIR, file), 'utf8'));
      } catch {
        continue; // partial write or gone — next poll catches it
      }
      if (!rec.sessionId) continue;
      const session = manager.byClaudeSessionId(rec.sessionId);
      if (!session || !session.proc) continue;
      if (rec.updatedAt && Date.now() - rec.updatedAt > STALE_MS) continue;

      if (rec.status === 'waiting') {
        engine.signal(session, SIG_SESSIONS_FILE, 'WAITING_PERMISSION', rec.waitingFor ?? 'waiting');
      } else if (rec.status === 'busy') {
        engine.signal(session, SIG_SESSIONS_FILE, 'WORKING');
      } else if (rec.status === 'idle') {
        engine.signal(session, SIG_SESSIONS_FILE, 'IDLE', 'turn finished');
      }
    }
  };
  const interval = setInterval(tick, POLL_MS);
  interval.unref();
  return () => clearInterval(interval);
}
