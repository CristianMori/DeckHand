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
  /** terminal card running one command (dh_run), not an interactive shell */
  command?: string;
  /** exit code of an EXITED process, when known */
  exitCode?: number;
  /** files this session handed to the user (dh_send_file), newest first */
  files?: SharedFile[];
  /** the latest tool call, as one display line: what a permission prompt is about */
  tool?: { name: string; summary: string; detail: string; at: number };
}

/** A file a session gave the user: a download link served by the owning hub. */
export interface SharedFile {
  id: string;
  name: string;
  size: number;
  at: number;
  /** absolute download URL on the owning hub (tailnet address when there is one) */
  url: string;
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
  /** terminal sessions: run this command non-interactively, then exit */
  command?: string;
}
