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
  detail?: string;
  summary?: string;
  createdAt: number;
  alive: boolean;
  autoYes?: boolean;
  machine?: string;
  unreachable?: boolean;
  handoff?: { fromAgent: string; fromSessionId: string; fromMachine: string };
  frozen?: boolean;
  /** files the session handed to the user (dh_send_file), newest first */
  files?: { id: string; name: string; size: number; at: number; url: string }[];
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

export interface GatewayAgent {
  id: string;
  /** requested = asked for access, waiting for the user; accepted = may mint its token until request.mintUntil */
  status: 'enrolled' | 'pending' | 'requested' | 'accepted';
  request?: { id: string; name: string; reason: string; ip: string; createdAt: string; mintUntil?: string };
  enrolledAt?: string;
  tokenExpiresAt?: string;
  lastSeen?: string;
  live: boolean;
  requests: number;
  denied: number;
  lastRequest?: string;
  webhook?: string;
  inbox: number;
  lastMessage?: { at: string; delivered: string; webhookError?: string };
}

export interface GatewayAgentsInfo {
  machine: string;
  present: boolean;
  agents: GatewayAgent[];
}

export interface GatewayLogLine {
  at: string;
  req?: string;
  ip?: string;
  method?: string;
  path?: string;
  status?: number;
  ms?: number;
  client?: string;
  event?: string;
  authError?: string;
  text?: string;
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

/** Mimir's view of one outside agent (times are UTC without a Z) */
export interface MimirAgent {
  id: string;
  available: boolean;
  deckhandAccess: string | string[];
  lastMessageInAtUtc: string | null;
  lastMessageOutAtUtc: string | null;
  lastDeckhandCallAtUtc: string | null;
  openTasks: number;
}
