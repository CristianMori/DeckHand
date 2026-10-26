import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import * as pty from '@lydell/node-pty';
import type { Terminal as HeadlessTerminalType } from '@xterm/headless';
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize';
import { agentFor, getAgent } from './agents/index.js';
import { HUB_ROOT } from './config.js';
import { fleetBriefing, identityEnv, projectFolderOf, type Identity } from './etiquette.js';

// @xterm packages ship CJS without named ESM exports
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');
import type { HandoffLineage, SessionInfo, SessionState, SharedFile, SpawnOptions } from './types.js';

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
  /** last keystroke written into the PTY (tells typing echo from real output) */
  lastInputAt = 0;
  /** the one command a dh_run card runs; cleared when it is restarted as a shell */
  command?: string;
  exitCode?: number;
  /** files handed to the user with dh_send_file, newest first (kept in memory) */
  files: SharedFile[] = [];
  /** latest tool call from the PreToolUse hook (shared so other hubs can describe prompts) */
  lastTool?: SessionInfo['tool'];
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
    this.command = opts.command;
  }

  info(): SessionInfo {
    return {
      hubId: this.hubId,
      agentType: this.agentType,
      claudeSessionId: this.claudeSessionId,
      name: this.name,
      cwd: this.cwd,
      project: projectFolderOf(this.cwd),
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
      command: this.command,
      exitCode: this.exitCode,
      files: this.files.length ? this.files : undefined,
      tool: this.lastTool,
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

  /** Everything the terminal still holds (scrollback included) as plain text,
   *  soft-wrapped rows joined back into their logical lines. */
  fullText(): string {
    const mirror = this.mirror;
    if (!mirror) return '';
    const buf = mirror.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(!buf.getLine(i + 1)?.isWrapped);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join('\n').replace(/\s+$/, '');
  }

  /** The visible screen (plus optional scrollback rows) as plain text, bottom row last. */
  screenText(scrollback = 0): string {
    const mirror = this.mirror;
    if (!mirror) return '';
    const buf = mirror.buffer.active;
    const from = Math.max(0, buf.length - mirror.rows - Math.max(0, scrollback));
    const lines: string[] = [];
    for (let i = from; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n').replace(/\s+$/, '');
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
  /** who this hub is, for the briefing every session receives (set by the hub at boot) */
  identity: { machine: string; hubUrl: string } = { machine: 'this machine', hubUrl: 'http://127.0.0.1:5959' };
  /** agent id -> resolved executable (install paths move on updates; resolve once) */
  private exeCache = new Map<string, string>();

  private exeFor(agentType: string, option?: string): string {
    const key = `${agentType}:${option ?? ''}`;
    let exe = this.exeCache.get(key);
    if (!exe) {
      exe = getAgent(agentType).resolveExe(option);
      this.exeCache.set(key, exe);
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
    this.spawnInto(session, opts.initialPrompt, !!opts.resumeSessionId, opts.command);
    return session;
  }

  /** Re-spawn an EXITED session's conversation via --resume. */
  resume(hubId: string): HubSession | undefined {
    const session = this.sessions.get(hubId);
    if (!session || session.proc) return session;
    session.buffer.clear();
    // a finished dh_run card comes back as a plain shell — never re-run its command
    session.command = undefined;
    this.spawnInto(session, undefined, true);
    return session;
  }

  private spawnInto(session: HubSession, initialPrompt: string | undefined, isResume: boolean, command?: string) {
    const adapter = agentFor(session);
    const identity: Identity = {
      hubId: session.hubId,
      conversationId: session.claudeSessionId,
      machine: this.identity.machine,
      engine: session.agentType,
      cwd: session.cwd,
      hubUrl: this.identity.hubUrl,
    };
    adapter.beforeSpawn?.(session.cwd);
    const args = adapter.buildArgs({
      sessionId: session.claudeSessionId,
      resume: isResume,
      name: session.name,
      cwd: session.cwd,
      model: session.model,
      permissionMode: session.permissionMode,
      initialPrompt,
      command,
      briefing: fleetBriefing(identity),
      // the node running the hub runs the server too — no PATH lookup in a service session
      // identity goes in explicitly: Codex does not hand its own environment to MCP servers
      mcp: { name: 'deckhand', command: process.execPath, args: [join(HUB_ROOT, 'mcp', 'deckhand-mcp.mjs')], env: identityEnv(identity) },
    });

    const proc = pty.spawn(this.exeFor(session.agentType, session.model), args, {
      name: 'xterm-256color',
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      env: { ...process.env, ...identityEnv(identity) } as Record<string, string>,
      useConpty: true,
    });
    session.proc = proc;
    // a one-shot command is working from its first instant until it exits
    session.state = command ? 'WORKING' : 'STARTING';
    session.stateSince = Date.now();
    session.detail = command ? 'running' : undefined;
    session.exitCode = undefined;

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
      session.exitCode = exitCode;
      session.state = 'EXITED';
      session.stateSince = Date.now();
      session.detail = `exit code ${exitCode}`;
      this.emit('change', session);
      this.emit('exit', session);
    });

    // an engine without a prompt flag (a shell) gets its initial prompt typed
    // in once it has drawn its prompt
    if (initialPrompt && adapter.outputOnlyStatus && !command) {
      setTimeout(() => {
        if (session.proc !== proc) return;
        this.write(session.hubId, initialPrompt);
        setTimeout(() => session.proc === proc && this.write(session.hubId, '\r'), 120);
      }, 1200);
    }

    this.emit('change', session);
  }

  write(hubId: string, data: string) {
    const session = this.sessions.get(hubId);
    if (!session?.proc) return;
    session.lastInputAt = Date.now();
    session.proc.write(data);
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
    alive?: boolean;
    stateSince?: number;
    savedAt?: number;
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
    // a card that was running when the hub went down exited at that moment;
    // one that was already EXITED keeps its original exit time — so the
    // sidebar's "most recently exited first" order survives the restart
    session.stateSince = rec.alive ? (rec.savedAt ?? Date.now()) : (rec.stateSince ?? rec.createdAt ?? Date.now());
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
