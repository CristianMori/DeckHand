import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { agentFor, listAgents } from './agents/index.js';
import type { HookPayload } from './agents/types.js';
import { readDocsRefeed } from './architectDocs.js';
import { architectEditDecision, editedPaths, folderOwner, ownershipWarning, projectFolderOf } from './etiquette.js';
import type { HubSession, SessionManager } from './sessionManager.js';
import type { StatusEngine } from './statusEngine.js';
import { normCwd } from './transcriptIo.js';
import type { SessionInfo } from './types.js';
import { SIG_HOOK } from './types.js';

const BIND_WINDOW_MS = 120_000;

/** Every hook from a hub-owned session, for listeners that want the raw
 *  payload (the glasses bridge reads tool names, inputs and questions). */
export const hookBus = new EventEmitter<{ hook: [HubSession, string, HookPayload & { tool_input?: unknown }] }>();

/**
 * Receives hook POSTs from agent sessions (Claude: injected via --settings;
 * others: hub-owned hooks.json). Agents that mint their own conversation id
 * are bound here: the first hook from an unknown id whose cwd matches a
 * freshly spawned, still-unbound session of that agent claims it.
 *
 * Replies are normally an empty 204 so hooks never slow the agent down. The
 * one exception is fleet etiquette on PreToolUse: an edit into a folder owned
 * by another live session gets a JSON warning back, which both Claude Code and
 * Codex surface to the agent (additionalContext) and the user (systemMessage);
 * and an architect's first attempt to edit code in its own folder is refused
 * with permissionDecision "deny", which both Claude Code and Codex honour —
 * a retry on the same file within ten minutes goes through with a warning.
 */
export function makeHookHandler(
  manager: SessionManager,
  engine: StatusEngine,
  fleetSessions: () => SessionInfo[],
) {
  // refused architect edits, "<sessionId>|<file>" → when; a retry goes through
  const architectAttempts = new Map<string, number>();
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

    hookBus.emit('hook', session, event, body);
    const sig = agentFor(session).mapHookEvent(event, body);
    if (sig) engine.signal(session, SIG_HOOK, sig.state, sig.detail);

    // an architect compacted or resumed lost its memory of the design: hand it
    // back its own documentation as additionalContext (Claude Code and Codex
    // both take this shape from a SessionStart hook)
    if (event === 'SessionStart' && (body.source === 'compact' || body.source === 'resume') && (session.role === 'architect' || session.role === 'subarchitect')) {
      try {
        const context = readDocsRefeed(session.cwd);
        if (context) {
          console.log(`[docs] ${session.name}: re-fed docs/architect after ${body.source} (${context.length} characters)`);
          return res.json({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
        }
      } catch {
        /* never let the refeed break a hook */
      }
    }

    // etiquette level 2: warn on edits into another live session's folder;
    // level 3: refuse an architect's first attempt to edit code itself
    if (event === 'PreToolUse') {
      try {
        // a worker with no worktree of its own works in its architect's folder by design
        const sharesFolder = session.worker && !session.worker.worktree;
        const warning = sharesFolder ? null : ownershipCheck(session.claudeSessionId, body, fleetSessions());
        if (warning) {
          console.log(`[etiquette] ${session.name}: ${warning.slice(0, 120)}…`);
          return res.json({
            systemMessage: warning,
            hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warning },
          });
        }
        if (session.role === 'architect' || session.role === 'subarchitect') {
          const verdict = architectEditDecision(
            architectAttempts,
            session.claudeSessionId,
            session.cwd,
            editedPaths(body.tool_name, body.tool_input, body.cwd),
          );
          if (verdict) {
            console.log(`[etiquette] ${session.name} (${verdict.decision}): ${verdict.message.slice(0, 120)}…`);
            return res.json({
              systemMessage: verdict.message,
              hookSpecificOutput:
                verdict.decision === 'deny'
                  ? { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.message }
                  : { hookEventName: 'PreToolUse', additionalContext: verdict.message },
            });
          }
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
