import type { SessionState } from '../types.js';

/** What a hook POST from an agent carries (Claude Code and Codex share this shape). */
export interface HookPayload {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  message?: string;
  cwd?: string;
  transcript_path?: string;
}

export interface BuildArgsInput {
  sessionId: string;
  resume: boolean;
  name: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  initialPrompt?: string;
}

export interface TranscriptRef {
  path: string;
  sessionId: string;
  mtime: number;
  /** label known to the agent's index but absent from the file itself */
  title?: string;
}

export interface TranscriptTail {
  cwd?: string;
  title?: string;
  lastText?: string;
}

/** Everything the hub needs to know about an agent's on-disk conversations. */
export interface TranscriptOps {
  /** where this agent keeps (or would keep) the transcript of a conversation */
  file(cwd: string, sessionId: string): string;
  /** transcripts belonging to one project folder */
  listFolder(cwd: string): Promise<TranscriptRef[]>;
  /** every transcript on this machine */
  listAll(): Promise<TranscriptRef[]>;
  parseTail(tail: string): TranscriptTail;
  /** last `n` question -> reply exchanges, oldest first */
  parseExchanges(full: string, n: number): { q: string; r: string }[];
  /** conversations a live agent process outside the hub currently has open */
  activeSessionIds(): Promise<Set<string>>;
  /** place a transcript fetched from another machine where this agent will find it */
  install(cwd: string, sessionId: string, body: Buffer): Promise<string>;
}

export interface StatusRecord {
  sessionId?: string;
  state?: SessionState;
  detail?: string;
  updatedAt?: number;
}

export interface AgentOption {
  value: string;
  label: string;
}

export interface AgentAdapter {
  id: string;
  label: string;
  /** true when the hub picks the conversation id up front (--session-id) */
  clientChosenId: boolean;
  resolveExe(): string;
  /** false when the CLI is not installed on this machine */
  available(): boolean;
  buildArgs(input: BuildArgsInput): string[];
  /** one-time preparation before a PTY spawn (e.g. pre-trusting a folder) */
  beforeSpawn?(cwd: string): void;

  /** materialize this agent's hook config for the given hub port (boot time) */
  writeHooks?(port: number): void;
  /** translate a hook event into a status signal; null = ignore */
  mapHookEvent(event: string, body: HookPayload): { state: SessionState; detail?: string } | null;

  /** live status feed on disk, if the agent publishes one */
  statusDir?: string;
  parseStatusRecord?(json: unknown): StatusRecord | null;

  /** prompt-box patterns in raw output (fallback before any hook arrives) */
  outputWaitingRegex?: RegExp;
  /** keystroke that accepts the highlighted default of a permission prompt */
  acceptKeystroke: string;
  /** prompts auto-yes must leave to a human (screen text test) */
  isProtectedPrompt?(screen: string): boolean;

  transcript?: TranscriptOps;

  models: AgentOption[];
  permissionModes: AgentOption[];
}
