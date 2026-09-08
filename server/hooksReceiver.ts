import type { Request, Response } from 'express';
import { agentFor, listAgents } from './agents/index.js';
import type { HookPayload } from './agents/types.js';
import type { SessionManager } from './sessionManager.js';
import type { StatusEngine } from './statusEngine.js';
import { normCwd } from './transcriptIo.js';
import { SIG_HOOK } from './types.js';

const BIND_WINDOW_MS = 120_000;

/**
 * Receives hook POSTs from agent sessions (Claude: injected via --settings;
 * others: hub-owned hooks.json). Responds 204 immediately so hooks never slow
 * the agent down. Agents that mint their own conversation id are bound here:
 * the first hook from an unknown id whose cwd matches a freshly spawned,
 * still-unbound session of that agent claims it.
 */
export function makeHookHandler(manager: SessionManager, engine: StatusEngine) {
  return (req: Request, res: Response) => {
    res.status(204).end();

    const event = String(req.query.event ?? '');
    const agentId = typeof req.query.agent === 'string' ? req.query.agent : undefined;
    const body = (req.body ?? {}) as HookPayload;
    const sessionId = body.session_id;
    if (!sessionId) return;

    let session = manager.byClaudeSessionId(sessionId);
    if (!session && body.cwd) {
      const want = normCwd(body.cwd);
      const now = Date.now();
      for (const agent of listAgents()) {
        if (agent.clientChosenId || (agentId && agentId !== agent.id)) continue;
        const candidate = [...manager.sessions.values()]
          .filter(
            (s) =>
              s.proc &&
              s.agentType === agent.id &&
              s.claudeSessionId.startsWith('pending-') &&
              normCwd(s.cwd) === want &&
              now - s.createdAt < BIND_WINDOW_MS,
          )
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        if (candidate) {
          manager.bindSessionId(candidate, sessionId);
          session = candidate;
          break;
        }
      }
    }

    console.log(
      `[hook] ${event} from ${sessionId.slice(0, 8)}${session ? ` (${session.name})` : ' (not hub-owned)'}${body.message ? `: ${body.message}` : ''}`,
    );
    if (!session) return;
    session.hooksSeen = true;

    const sig = agentFor(session).mapHookEvent(event, body);
    if (sig) engine.signal(session, SIG_HOOK, sig.state, sig.detail);
  };
}
