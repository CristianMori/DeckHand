import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import * as pty from '@lydell/node-pty';
import type { Terminal as HeadlessTerminalType } from '@xterm/headless';
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize';
import { agentFor, getAgent } from './agents/index.js';

// @xterm packages ship CJS without named ESM exports
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');
import type { HandoffLineage, SessionInfo, SessionState, SpawnOptions } from './types.js';

const RING_BUFFER_CAP = 1_000_000; // ~1 MB of terminal output per session

class RingBuffer {
  private chunks: string[] = [];
  private total = 0;

  push(data: string) {
    this.chunks.push(data);
    this.total += data.length;
    while (this.total > RING_BUFFER_CAP && this.chunks.length > 1) {
      this.total -= this.chunks.shift()!.length;
    }
  }

  read(): string {
    return this.chunks.join('');
  }

  clear() {
    this.chunks = [];
    this.total = 0;
  }
}

export class HubSession {
  hubId = randomUUID().slice(0, 8);
  agentType: string;
  /** the agent's own conversation id; `pending-*` until an agent that mints
   *  its own id reports it through its first hook */
  claudeSessionId: string;
  name: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  handoff?: HandoffLineage;
  state: SessionState = 'STARTING';
  stateSince = Date.now();
  detail?: string;
  summary?: string;
  createdAt = Date.now();
  buffer = new RingBuffer();
  proc: pty.IPty | null = null;
  /** server-side mirror of the real screen — source of truth for reconnect snapshots */
  mirror: HeadlessTerminalType | null = null;
  serializer: SerializeAddonType | null = null;
  cols = 120;
  rows = 32;
  /** true once any hook POST arrived — gates output heuristics down */
  hooksSeen = false;
  /** per-session auto-approve: answer permission prompts yes until turned off */
  autoYes = false;
  /** stateSince of the last permission prompt we auto-answered (dedupe guard) */
  autoAnsweredAt = 0;
  lastOutputAt = 0;
  /** timestamp of last accepted signal per precedence level */
  lastSignalAt: Record<number, number> = {};

  constructor(opts: SpawnOptions) {
    this.agentType = getAgent(opts.agentType).id;
    this.claudeSessionId =
      opts.resumeSessionId ??
      (agentFor(this).clientChosenId ? randomUUID() : `pending-${this.hubId}`);
    this.cwd = opts.cwd;
    this.name = opts.name || basename(opts.cwd);
    this.model = opts.model;
    this.permissionMode = opts.permissionMode;
    this.handoff = opts.handoff;
  }

  info(): SessionInfo {
    return {
      hubId: this.hubId,
      agentType: this.agentType,
      claudeSessionId: this.claudeSessionId,
      name: this.name,
      cwd: this.cwd,
      model: this.model,
      permissionMode: this.permissionMode,
      state: this.state,
      stateSince: this.stateSince,
      detail: this.detail,
      summary: this.summary,
      createdAt: this.createdAt,
      alive: this.proc !== null,
      autoYes: this.autoYes,
      handoff: this.handoff,
    };
  }

  /** Current mouse-reporting state from the mirror — the client can't infer
   *  this from a reconnect snapshot (DECSET modes aren't replayed), so we tell
   *  it authoritatively in the init frame. 'none' when the TUI isn't tracking. */
  mouseMode(): string {
    try {
      return (this.mirror as unknown as { modes?: { mouseTrackingMode?: string } })?.modes
        ?.mouseTrackingMode ?? 'none';
    } catch {
      return 'none';
    }
  }

  /** Exact current screen state (incl. colors, cursor, alt-screen) as an ANSI stream. */
  snapshot(): string {
    try {
      return this.serializer?.serialize({ scrollback: 2000 }) ?? this.buffer.read();
    } catch {
      return this.buffer.read();
    }
  }
}

/**
 * Owns all agent PTYs.
 * Events: 'data' (session, chunk), 'change' (session), 'exit' (session).
 */
export class SessionManager extends EventEmitter {
  sessions = new Map<string, HubSession>();
  /** agent id -> resolved executable (install paths move on updates; resolve once) */
  private exeCache = new Map<string, string>();

  private exeFor(agentType: string): string {
    let exe = this.exeCache.get(agentType);
    if (!exe) {
      exe = getAgent(agentType).resolveExe();
      this.exeCache.set(agentType, exe);
    }
    return exe;
  }

  /** An agent that mints its own conversation id has reported it — adopt it. */
  bindSessionId(session: HubSession, id: string) {
    if (session.claudeSessionId === id) return;
    session.claudeSessionId = id;
    this.emit('change', session);
  }

  create(opts: SpawnOptions): HubSession {
    // resuming a conversation supersedes its EXITED cards — leaving them
    // around both clutters the sidebar and poisons claudeSessionId lookups
    if (opts.resumeSessionId) {
      for (const [hubId, s] of this.sessions) {
        if (s.claudeSessionId === opts.resumeSessionId && !s.proc) this.sessions.delete(hubId);
      }
    }
    const session = new HubSession(opts);
    this.sessions.set(session.hubId, session);
    this.spawnInto(session, opts.initialPrompt, !!opts.resumeSessionId);
    return session;
  }

  /** Re-spawn an EXITED session's conversation via --resume. */
  resume(hubId: string): HubSession | undefined {
    const session = this.sessions.get(hubId);
    if (!session || session.proc) return session;
    session.buffer.clear();
    this.spawnInto(session, undefined, true);
    return session;
  }

  private spawnInto(session: HubSession, initialPrompt: string | undefined, isResume: boolean) {
    const adapter = agentFor(session);
    adapter.beforeSpawn?.(session.cwd);
    const args = adapter.buildArgs({
      sessionId: session.claudeSessionId,
      resume: isResume,
      name: session.name,
      cwd: session.cwd,
      model: session.model,
      permissionMode: session.permissionMode,
      initialPrompt,
    });

    const proc = pty.spawn(this.exeFor(session.agentType), args, {
      name: 'xterm-256color',
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      env: { ...process.env } as Record<string, string>,
      useConpty: true,
    });
    session.proc = proc;
    session.state = 'STARTING';
    session.stateSince = Date.now();
    session.detail = undefined;

    session.mirror?.dispose();
    session.mirror = new HeadlessTerminal({
      cols: session.cols,
      rows: session.rows,
      scrollback: 5000,
      allowProposedApi: true,
    });
    session.serializer = new SerializeAddon();
    session.mirror.loadAddon(session.serializer);

    proc.onData((chunk) => {
      session.buffer.push(chunk);
      session.mirror?.write(chunk);
      session.lastOutputAt = Date.now();
      this.emit('data', session, chunk);
    });

    proc.onExit(({ exitCode }) => {
      session.proc = null;
      session.state = 'EXITED';
      session.stateSince = Date.now();
      session.detail = `exit code ${exitCode}`;
      this.emit('change', session);
      this.emit('exit', session);
    });

    this.emit('change', session);
  }

  write(hubId: string, data: string) {
    this.sessions.get(hubId)?.proc?.write(data);
  }

  resize(hubId: string, cols: number, rows: number) {
    const session = this.sessions.get(hubId);
    if (!session?.proc) return;
    if (cols === session.cols && rows === session.rows) return;
    session.cols = cols;
    session.rows = rows;
    try {
      session.proc.resize(cols, rows);
      session.mirror?.resize(cols, rows);
    } catch {
      /* PTY may be mid-exit */
    }
  }

  kill(hubId: string) {
    const session = this.sessions.get(hubId);
    if (!session?.proc) return;
    const pid = session.proc.pid;
    try {
      session.proc.kill();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (session.proc && session.proc.pid === pid) {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/F', '/T', '/PID', String(pid)], () => {});
        } else {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }
    }, 3000);
  }

  remove(hubId: string) {
    const session = this.sessions.get(hubId);
    if (!session) return;
    if (session.proc) this.kill(hubId);
    this.sessions.delete(hubId);
    this.emit('change', session);
  }

  /** Register a persisted record from a previous hub run as an EXITED card with Resume available. */
  addExitedRecord(rec: {
    agentType?: string;
    claudeSessionId: string;
    name: string;
    cwd: string;
    model?: string;
    permissionMode?: string;
    summary?: string;
    createdAt?: number;
    handoff?: HandoffLineage;
  }) {
    const session = new HubSession({
      cwd: rec.cwd,
      agentType: rec.agentType,
      name: rec.name,
      model: rec.model,
      permissionMode: rec.permissionMode,
      resumeSessionId: rec.claudeSessionId,
      handoff: rec.handoff,
    });
    session.state = 'EXITED';
    session.detail = 'hub restarted';
    session.summary = rec.summary;
    if (rec.createdAt) session.createdAt = rec.createdAt;
    this.sessions.set(session.hubId, session);
    return session;
  }

  byClaudeSessionId(id: string): HubSession | undefined {
    // resumes create new cards that share a claudeSessionId with older EXITED
    // ones — a dead match would swallow hook/watcher signals meant for the
    // live session, so the living always win
    let dead: HubSession | undefined;
    for (const s of this.sessions.values()) {
      if (s.claudeSessionId !== id) continue;
      if (s.proc) return s;
      dead ??= s;
    }
    return dead;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }
}
