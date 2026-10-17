import type { Request, Response } from 'express';
import { agentFor, listAgents } from './agents/index.js';
import type { HookPayload } from './agents/types.js';
import { editedPaths, folderOwner, ownershipWarning, projectFolderOf } from './etiquette.js';
import type { SessionManager } from './sessionManager.js';
import type { StatusEngine } from './statusEngine.js';
import { normCwd } from './transcriptIo.js';
import type { SessionInfo } from './types.js';
import { SIG_HOOK } from './types.js';

const BIND_WINDOW_MS = 120_000;

/**
 * Receives hook POSTs from agent sessions (Claude: injected via --settings;
 * others: hub-owned hooks.json). Agents that mint their own conversation id
 * are bound here: the first hook from an unknown id whose cwd matches a
 * freshly spawned, still-unbound session of that agent claims it.
 *
 * Replies are normally an empty 204 so hooks never slow the agent down. The
 * one exception is fleet etiquette: a PreToolUse edit into a folder owned by
 * another live session gets a JSON warning back, which both Claude Code and
 * Codex surface to the agent (additionalContext) and the user (systemMessage).
 */
export function makeHookHandler(
  manager: SessionManager,
  engine: StatusEngine,
  fleetSessions: () => SessionInfo[],
) {
  return (req: Request, res: Response) => {
    const event = String(req.query.event ?? '');
    const agentId = typeof req.query.agent === 'string' ? req.query.agent : undefined;
    const body = (req.body ?? {}) as HookPayload & { tool_input?: unknown };
    const sessionId = body.session_id;
    if (!sessionId) return res.status(204).end();

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
    if (!session) return res.status(204).end();
    session.hooksSeen = true;

    const sig = agentFor(session).mapHookEvent(event, body);
    if (sig) engine.signal(session, SIG_HOOK, sig.state, sig.detail);

    // etiquette level 2: warn on edits into another live session's folder
    if (event === 'PreToolUse') {
      try {
        const warning = ownershipCheck(session.claudeSessionId, body, fleetSessions());
        if (warning) {
          console.log(`[etiquette] ${session.name}: ${warning.slice(0, 120)}…`);
          return res.json({
            systemMessage: warning,
            hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warning },
          });
        }
      } catch {
        /* never let etiquette break a hook */
      }
    }
    res.status(204).end();
  };
}

function ownershipCheck(
  editingConversationId: string,
  body: HookPayload & { tool_input?: unknown },
  live: SessionInfo[],
): string | null {
  for (const file of editedPaths(body.tool_name, body.tool_input, body.cwd)) {
    const folder = projectFolderOf(file);
    if (!folder) continue;
    const owner = folderOwner(folder, editingConversationId, live);
    if (owner) return ownershipWarning(owner, folder, file);
  }
  return null;
}
