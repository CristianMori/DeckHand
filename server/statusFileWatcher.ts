import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listAgents } from './agents/index.js';
import type { SessionManager } from './sessionManager.js';
import type { StatusEngine } from './statusEngine.js';
import { SIG_SESSIONS_FILE } from './types.js';

const POLL_MS = 2000;
const STALE_MS = 5 * 60_000;

/**
 * Redundancy layer: agents that publish per-session status files (Claude Code
 * writes ~/.claude/sessions/<pid>.json) are polled and fused in at
 * sessions-file precedence. Works even if hook injection ever fails.
 */
export function startStatusFileWatcher(manager: SessionManager, engine: StatusEngine) {
  const tick = async () => {
    for (const agent of listAgents()) {
      if (!agent.statusDir || !agent.parseStatusRecord) continue;
      let files: string[];
      try {
        files = await readdir(agent.statusDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        let rec;
        try {
          rec = agent.parseStatusRecord(JSON.parse(await readFile(join(agent.statusDir, file), 'utf8')));
        } catch {
          continue; // partial write or gone — next poll catches it
        }
        if (!rec?.sessionId || !rec.state) continue;
        const session = manager.byClaudeSessionId(rec.sessionId);
        if (!session || !session.proc || session.agentType !== agent.id) continue;
        if (rec.updatedAt && Date.now() - rec.updatedAt > STALE_MS) continue;
        engine.signal(session, SIG_SESSIONS_FILE, rec.state, rec.detail);
      }
    }
  };
  const interval = setInterval(tick, POLL_MS);
  interval.unref();
  return () => clearInterval(interval);
}
