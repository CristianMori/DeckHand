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
  /** the project folder it works in (top folder under its hub's projects root), set by the owning hub */
  project?: string | null;
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
  /** this session is waiting on the user; absent otherwise (see needsYou.ts) */
  attention?: Attention;
  /** who hears on each outside channel when it waits, chosen per session: nobody by default */
  alerts?: AlertChannels;
  /** architect: designs and delegates; subarchitect: the same for one module, under an architect; worker: one task. Absent: a plain session */
  role?: SessionRole;
  worker?: WorkerLink;
  /** tool calls so far by tool name, kept for workers */
  toolUse?: Record<string, number>;
}

export type SessionRole = 'architect' | 'subarchitect' | 'worker';

/** A worker's or sub-architect's tie to who leads it, its task and how it went (see swarm.ts). */
export interface WorkerLink {
  /** the architect's conversation id: survives its restarts, unlike a hub id */
  architect: string;
  architectName: string;
  task: string;
  followUps?: string[];
  baseFolder: string;
  /** the project's name, which holds on every machine, unlike a path */
  project?: string;
  /** the architect runs on another machine: code travels between the hubs as git bundles */
  architectMachine?: string;
  /** process.platform of the architect's machine, and of its own: they can differ */
  architectPlatform?: string;
  platform?: string;
  /** its branch has commits the architect's repo doesn't have yet */
  sendBranch?: boolean;
  /** its own checkout and branch; absent when the folder is not a git repo */
  worktree?: string;
  repo?: string;
  branch?: string;
  baseCommit?: string;
  status: 'working' | 'asking' | 'stalled' | 'reported' | 'failed';
  startedAt: number;
  result?: string;
  reportedAt?: number;
  commits?: number;
  files?: number;
  question?: string;
  askedAt?: number;
  nudgedAt?: number;
  /** stateSince of the last prompt already passed to the architect */
  forwardedWait?: number;
  /** messages for the architect, waiting until it is idle */
  outbox?: string[];
}

/** People by name, as Hermod and the text gateway know them. Empty: that channel is off. */
export interface AlertChannels {
  discord: string[];
  text: string[];
}

/** A session waiting on the user: one per waiting episode. */
export interface Attention {
  /** stable id of this waiting episode: dedupe popups on it */
  episode: string;
  /** question: a turn ended asking in text; ask: AskUserQuestion or the like; permission: a tool approval */
  kind: 'question' | 'ask' | 'permission';
  text: string;
  since: number;
  /** when the alert went out, once the session had waited long enough */
  alertedAt?: number;
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
  /** carried over from the machine this conversation last ran on */
  alerts?: AlertChannels;
  role?: SessionRole;
  worker?: WorkerLink;
  /** terminal sessions: run this command non-interactively, then exit */
  command?: string;
}
