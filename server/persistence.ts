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
  const records: PersistedSession[] = [...manager.sessions.values()].map((s) => ({
    agentType: s.agentType,
    claudeSessionId: s.claudeSessionId,
    name: s.name,
    cwd: s.cwd,
    model: s.model,
    permissionMode: s.permissionMode,
    summary: s.summary,
    createdAt: s.createdAt,
  }));
  try {
    writeFileSync(PERSIST_FILE, JSON.stringify(records, null, 2));
  } catch (err) {
    console.error('[persistence] save failed:', err);
  }
}
