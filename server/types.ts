export type SessionState =
  | 'STARTING'
  | 'WORKING'
  | 'WAITING_QUESTION'
  | 'WAITING_PERMISSION'
  | 'IDLE'
  | 'EXITED';

/** Signal precedence: lower number wins. */
export const SIG_PTY_EXIT = 1;
export const SIG_HOOK = 2;
export const SIG_SESSIONS_FILE = 3;
export const SIG_OUTPUT = 4;

export interface SessionInfo {
  hubId: string;
  /** which agent adapter runs this session ('claude', 'codex', ...) */
  agentType: string;
  /** the agent's own conversation id (name kept for wire/persistence compatibility) */
  claudeSessionId: string;
  name: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  state: SessionState;
  stateSince: number;
  detail?: string;
  summary?: string;
  createdAt: number;
  alive: boolean;
  /** per-session auto-approve of permission prompts */
  autoYes?: boolean;
  /** which fleet machine owns this session (tagged by its hub) */
  machine?: string;
  /** instanceId of the hub that owns this session — peers filter broadcasts on
   *  this to take only sessions the sender itself owns (kills gossip loops) */
  origin?: string;
  /** true when the owning hub is currently unreachable — card data is a cached snapshot */
  unreachable?: boolean;
  /** this session was started as a handoff from another session */
  handoff?: HandoffLineage;
  /** the session's folder is frozen to its machine — never synced or moved */
  frozen?: boolean;
}

export interface HandoffLineage {
  fromAgent: string;
  fromSessionId: string;
  fromMachine: string;
}

export interface FleetMachine {
  machine: string;
  self: boolean;
  connected: boolean;
  url?: string;
}

export interface SpawnOptions {
  cwd: string;
  agentType?: string;
  name?: string;
  model?: string;
  permissionMode?: string;
  initialPrompt?: string;
  resumeSessionId?: string;
  handoff?: HandoffLineage;
}
