export type SessionState =
  | 'STARTING'
  | 'WORKING'
  | 'WAITING_QUESTION'
  | 'WAITING_PERMISSION'
  | 'IDLE'
  | 'EXITED';

export interface SessionInfo {
  hubId: string;
  agentType?: string;
  claudeSessionId: string;
  name: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  state: SessionState;
  stateSince: number;
  /** when the pty last printed anything; absent on a hub too old to send it */
  lastOutputAt?: number;
  detail?: string;
  summary?: string;
  createdAt: number;
  alive: boolean;
  autoYes?: boolean;
  /** who hears on each channel; absent on a hub too old to have the setting (email: one too old for that channel) */
  alerts?: { discord: string[]; text: string[]; email?: string[] };
  machine?: string;
  unreachable?: boolean;
  handoff?: { fromAgent: string; fromSessionId: string; fromMachine: string };
  frozen?: boolean;
  /** files the session handed to the user (dh_send_file), newest first */
  files?: { id: string; name: string; size: number; at: number; url: string }[];
  /** architect: designs and delegates; subarchitect: the same for one module; worker: one task; role: a specialist instance that only reports. Absent: plain */
  role?: 'architect' | 'subarchitect' | 'worker' | 'role';
  /** architects: commits on the current branch since docs/architect/ last changed */
  docsBehind?: number;
  worker?: WorkerLink;
  /** letters waiting in its swarm inbox; absent when none, and on a hub too old to count them */
  inboxCount?: number;
  /** tool calls so far by tool name, kept for workers */
  toolUse?: Record<string, number>;
  /** the latest tool call */
  tool?: { name: string; summary: string; detail: string; at: number };
}

export interface WorkerLink {
  architect: string;
  architectName: string;
  task: string;
  followUps?: string[];
  baseFolder: string;
  project?: string;
  architectMachine?: string;
  platform?: string;
  /** a role instance: the name of the charter it runs — the card's label */
  charter?: string;
  worktree?: string;
  branch?: string;
  status: 'working' | 'asking' | 'stalled' | 'reported' | 'failed';
  startedAt: number;
  result?: string;
  reportedAt?: number;
  commits?: number;
  files?: number;
  question?: string;
}

export interface HandoffJob {
  id: string;
  phase: string;
  pct: number;
  error?: string;
  session?: SessionInfo;
}

export interface FleetMachine {
  machine: string;
  self: boolean;
  connected: boolean;
  url?: string;
}

export interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
}

export interface AgentInfo {
  id: string;
  label: string;
  /** CLI installed on that machine (old hubs omit it — treat as available) */
  available?: boolean;
  models: { value: string; label: string }[];
  permissionModes: { value: string; label: string }[];
  canResume: boolean;
  /** what the models list is called in the dialog (SHELL for terminals) */
  optionLabel?: string;
  /** a plain terminal, not a coding agent */
  terminal?: boolean;
  /** not installed there: the command that installs it */
  install?: string;
}

export interface FolderConversation {
  agentType?: string;
  claudeSessionId: string;
  title?: string;
  lastText?: string;
  updatedAt: number;
  activeElsewhere: boolean;
}

export interface FolderInfo {
  folder: string;
  path: string;
  machine?: string;
  synced: boolean;
  frozen?: boolean;
  activeHubSessions: number;
  updatedAt: number;
  conversations: FolderConversation[];
}

export interface FleetFolderGroup {
  folder: string;
  onVps: boolean;
  locations: FolderInfo[];
}

export interface AdminStatus {
  machine: string;
  version: string;
  build: number;
  builtAt?: string;
  uptimeS: number;
  latestBuild?: number;
  latestVersion?: string;
  updateAvailable: boolean;
  updating: boolean;
  lastCheckAt?: number;
  error?: string;
  /** left by UPDATE ALL: hubs that come back behind it update themselves */
  fleetTarget?: { build: number; version: string; requestedAt: string; requestedBy: string };
  /** release already downloaded and verified here */
  staged?: { build: number; version: string; bytes: number; at: string };
  staging?: boolean;
}

export interface UpdateAllResult {
  target: { build: number; version: string; requestedAt: string; requestedBy: string };
  machines: { machine: string; told: boolean; error?: string }[];
  offline: string[];
}

export interface ProvenanceEntry {
  id: string;
  at: string;
  machine: string;
  caller: string;
  via: string[];
  ip: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  target?: { id: string; hubId?: string; name?: string; conversationId?: string };
  detail?: string;
}

export interface ResumeJob {
  id: string;
  phase: string;
  pct: number;
  error?: string;
  session?: SessionInfo;
}

export interface ControlMessage {
  type: 'sessions' | 'alert';
  sessions?: SessionInfo[];
  hubId?: string;
  state?: SessionState;
  name?: string;
  detail?: string;
  machine?: string;
}

/** Mimir's view of one outside agent (times are UTC, sometimes without a Z) */
export interface MimirAgent {
  id: string;
  status: string;
  live: boolean;
  available: boolean;
  enrolledAt?: string;
  lastSeen?: string | null;
  webhook?: string;
  inbox?: number;
  lastMessageInAtUtc: string | null;
  lastMessageOutAtUtc: string | null;
  lastDeckhandCallAtUtc: string | null;
  openTasks: number;
}

/** What one outside agent may reach (enforced by the hub; made in ADMIN → TRUST) */
export interface AccessGrant {
  id: string;
  agent: string;
  access: 'discover' | 'observe' | 'interact';
  folders: string[] | '*';
  sessions: string[];
  fact: string;
  createdAt: number;
  originMachine: string;
}

export interface MimirRequest {
  id: string;
  agent: string;
  status: string;
  at: string;
  note?: string;
  name?: string;
  ip?: string;
}
