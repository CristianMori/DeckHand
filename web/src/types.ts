export type SessionState =
  | 'STARTING'
  | 'WORKING'
  | 'WAITING_QUESTION'
  | 'WAITING_PERMISSION'
  | 'IDLE'
  | 'EXITED';

export interface SessionInfo {
  hubId: string;
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
  machine?: string;
  unreachable?: boolean;
}

export interface FleetMachine {
  machine: string;
  self: boolean;
  connected: boolean;
  url?: string;
}

export interface FolderConversation {
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
