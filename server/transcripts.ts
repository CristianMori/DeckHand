import { existsSync } from 'node:fs';
import { agentFor } from './agents/index.js';
import { readTail } from './transcriptIo.js';

/**
 * Last assistant text of a session's transcript (trimmed) for the dashboard
 * summary line. Best-effort — undefined on any miss.
 */
export async function lastAssistantText(session: {
  agentType?: string;
  claudeSessionId: string;
  cwd: string;
}): Promise<string | undefined> {
  const t = agentFor(session).transcript;
  if (!t) return undefined;
  const path = t.file(session.cwd, session.claudeSessionId);
  if (!existsSync(path)) return undefined;
  try {
    const text = t.parseTail(await readTail(path)).lastText;
    return text && text.length > 160 ? text.slice(0, 157) + '…' : text;
  } catch {
    return undefined;
  }
}
