import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import type { AgentAdapter } from './types.js';

export const DEFAULT_AGENT = 'claude';

const registry = new Map<string, AgentAdapter>([
  [claudeAdapter.id, claudeAdapter],
  [codexAdapter.id, codexAdapter],
]);

export function registerAgent(adapter: AgentAdapter) {
  registry.set(adapter.id, adapter);
}

/** Adapter by id; unknown/missing ids fall back to the default (old records, old peers). */
export function getAgent(id?: string | null): AgentAdapter {
  return registry.get(id || DEFAULT_AGENT) ?? registry.get(DEFAULT_AGENT)!;
}

export function agentFor(session: { agentType?: string }): AgentAdapter {
  return getAgent(session.agentType);
}

export function listAgents(): AgentAdapter[] {
  return [...registry.values()];
}

export type { AgentAdapter } from './types.js';
