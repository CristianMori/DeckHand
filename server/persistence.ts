import { readFileSync, writeFileSync } from 'node:fs';
import { PERSIST_FILE } from './config.js';
import type { SessionManager } from './sessionManager.js';

export interface PersistedSession {
  agentType?: string;
  claudeSessionId: string;
  name: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  summary?: string;
  createdAt: number;
  handoff?: { fromAgent: string; fromSessionId: string; fromMachine: string };
  /** the process was running when this was written — restored on the next boot */
  alive?: boolean;
  autoYes?: boolean;
  /** when the card entered its current state — keeps the sidebar order across restarts */
  stateSince?: number;
  /** when this file was written; a card alive then is "exited since" this moment */
  savedAt?: number;
}

export function loadPersisted(): PersistedSession[] {
  try {
    const data = JSON.parse(readFileSync(PERSIST_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function savePersisted(manager: SessionManager) {
  const now = Date.now();
  const records: PersistedSession[] = [...manager.sessions.values()].map((s) => ({
    agentType: s.agentType,
    claudeSessionId: s.claudeSessionId,
    name: s.name,
    cwd: s.cwd,
    model: s.model,
    permissionMode: s.permissionMode,
    summary: s.summary,
    createdAt: s.createdAt,
    handoff: s.handoff,
    alive: s.proc !== null,
    autoYes: s.autoYes,
    stateSince: s.stateSince,
    savedAt: now,
  }));
  try {
    writeFileSync(PERSIST_FILE, JSON.stringify(records, null, 2));
  } catch (err) {
    console.error('[persistence] save failed:', err);
  }
}
