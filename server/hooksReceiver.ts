import type { Request, Response } from 'express';
import type { SessionManager } from './sessionManager.js';
import type { StatusEngine } from './statusEngine.js';
import { SIG_HOOK } from './types.js';

interface HookPayload {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  message?: string;
}

/**
 * Receives hook POSTs from claude sessions (injected via --settings hub-hooks.json).
 * Responds 204 immediately so hooks never slow Claude down.
 */
export function makeHookHandler(manager: SessionManager, engine: StatusEngine) {
  return (req: Request, res: Response) => {
    res.status(204).end();

    const event = String(req.query.event ?? '');
    const body = (req.body ?? {}) as HookPayload;
    const sessionId = body.session_id;
    if (!sessionId) return;
    const session = manager.byClaudeSessionId(sessionId);
    console.log(`[hook] ${event} from ${sessionId.slice(0, 8)}${session ? ` (${session.name})` : ' (not hub-owned)'}${body.message ? `: ${body.message}` : ''}`);
    if (!session) return;
    session.hooksSeen = true;

    switch (event) {
      case 'UserPromptSubmit':
        engine.signal(session, SIG_HOOK, 'WORKING');
        break;
      case 'AskUserQuestion':
        engine.signal(session, SIG_HOOK, 'WAITING_QUESTION', 'Claude is asking you a question');
        break;
      case 'PreToolUse':
        engine.signal(session, SIG_HOOK, 'WORKING', body.tool_name ? `using ${body.tool_name}` : undefined);
        break;
      case 'Stop':
        engine.signal(session, SIG_HOOK, 'IDLE', 'turn finished');
        break;
      case 'Notification': {
        const msg = body.message ?? '';
        if (/permission/i.test(msg)) {
          engine.signal(session, SIG_HOOK, 'WAITING_PERMISSION', msg);
        } else if (/waiting for your input/i.test(msg)) {
          engine.signal(session, SIG_HOOK, 'IDLE', msg);
        } else if (msg) {
          engine.signal(session, SIG_HOOK, 'WAITING_QUESTION', msg);
        }
        break;
      }
    }
  };
}
