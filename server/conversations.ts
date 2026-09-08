import { getAgent, listAgents } from './agents/index.js';
import type { TranscriptRef } from './agents/types.js';
import { readTail } from './transcriptIo.js';

export { readTail } from './transcriptIo.js';

export interface ConversationEntry {
  agentType: string;
  claudeSessionId: string;
  cwd?: string;
  title?: string;
  lastText?: string;
  updatedAt: number;
  /** a live agent process (outside the hub) currently has this conversation open */
  activeElsewhere: boolean;
}

const MAX_RESULTS = 40;

/** Conversation ids currently open by agent processes outside the hub. */
export async function activeSessionIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const agent of listAgents()) {
    if (!agent.transcript) continue;
    for (const id of await agent.transcript.activeSessionIds()) ids.add(id);
  }
  return ids;
}

/** List recent conversations of every agent across all projects, newest first. */
export async function listRecentConversations(
  excludeSessionIds: Set<string>,
): Promise<ConversationEntry[]> {
  const files: (TranscriptRef & { agentType: string })[] = [];
  for (const agent of listAgents()) {
    if (!agent.transcript) continue;
    for (const ref of await agent.transcript.listAll()) {
      if (!excludeSessionIds.has(ref.sessionId)) files.push({ ...ref, agentType: agent.id });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const picked = files.slice(0, MAX_RESULTS);
  const active = await activeSessionIds();

  const results: ConversationEntry[] = [];
  for (const f of picked) {
    const entry: ConversationEntry = {
      agentType: f.agentType,
      claudeSessionId: f.sessionId,
      updatedAt: f.mtime,
      activeElsewhere: active.has(f.sessionId),
    };
    try {
      const parsed = getAgent(f.agentType).transcript!.parseTail(await readTail(f.path));
      entry.cwd = parsed.cwd;
      entry.title = parsed.title;
      entry.lastText = parsed.lastText;
    } catch {
      /* unreadable transcript — still listed, just bare */
    }
    if (entry.cwd) results.push(entry); // can't resume without knowing the folder
  }
  return results;
}
