import { EventEmitter } from 'node:events';
import { agentFor } from './agents/index.js';
import type { HubSession, SessionManager } from './sessionManager.js';
import type { SessionState } from './types.js';
import { SIG_HOOK, SIG_OUTPUT } from './types.js';

const HIGHER_SIGNAL_SHIELD_MS = 3000;
const SETTLE_MS = 1200; // output burst must be over this long before the screen is read // lower-precedence signals can't override within this window
const ALERT_DEBOUNCE_MS = 1500; // state must persist this long before alerting
const QUIET_IDLE_MS = 120_000; // a WORKING card with a silent PTY this long is idle

const ALERT_STATES: SessionState[] = ['WAITING_QUESTION', 'WAITING_PERMISSION', 'IDLE'];

/**
 * Fuses the four status signals (PTY exit, hooks, ~/.claude/sessions files, output
 * heuristics) into one state per session, with precedence and alert debouncing.
 * Events: 'alert' ({ session, state, detail }).
 */
export class StatusEngine extends EventEmitter {
  private alertTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private settleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private scheduleSettle(session: HubSession) {
    const prev = this.settleTimers.get(session.hubId);
    if (prev) clearTimeout(prev);
    this.settleTimers.set(
      session.hubId,
      setTimeout(() => {
        this.settleTimers.delete(session.hubId);
        if (!session.proc || session.hooksSeen) return;
        let activity: 'working' | 'idle' | null = null;
        try {
          activity = agentFor(session).screenActivity?.(session.screenText()) ?? null;
        } catch {
          /* mirror mid-resize */
        }
        if (activity === 'idle') this.signal(session, SIG_OUTPUT, 'IDLE', 'ready');
        else this.signal(session, SIG_OUTPUT, 'WORKING');
      }, SETTLE_MS),
    );
  }

  constructor(private manager: SessionManager) {
    super();
    // S4: raw output flow marks WORKING; prompt-box patterns suggest WAITING.
    manager.on('data', (session: HubSession, chunk: string) => {
      if (session.hooksSeen) return; // hooks + sessions-file carry the load once seen
      const { outputWaitingRegex: waitingRx, outputIdleRegex: idleRx } = agentFor(session);
      if (waitingRx && waitingRx.test(chunk)) {
        this.signal(session, SIG_OUTPUT, 'WAITING_PERMISSION', 'prompt detected in output');
      } else if (idleRx && idleRx.test(chunk)) {
        this.signal(session, SIG_OUTPUT, 'IDLE', 'ready');
      } else if (
        chunk.length > 4 &&
        // ignore boot noise, but never let a session sit in STARTING forever
        // when hook delivery is broken on a machine — output is proof of life
        (session.state !== 'STARTING' || Date.now() - session.createdAt > 15_000)
      ) {
        // Output alone is not work: a resize or an opened tab repaints the whole
        // screen. Let the burst settle, then read the screen the TUI drew — its
        // activity line means WORKING, an empty composer means IDLE.
        this.scheduleSettle(session);
      }
    });
    manager.on('exit', (session: HubSession) => this.clearAlert(session.hubId));

    // Backstop for agents that announce the start of work but not its end
    // (a resumed Claude Code session fires no hook until its first prompt and
    // sat WORKING for hours). A busy TUI repaints constantly; a WORKING card
    // whose PTY has been silent for QUIET_IDLE_MS, with no hook in that time,
    // is idle whatever the last signal said.
    const quiet = setInterval(() => {
      const now = Date.now();
      for (const session of manager.sessions.values()) {
        if (!session.proc || (session.state !== 'WORKING' && session.state !== 'STARTING')) continue;
        if (now - session.stateSince < QUIET_IDLE_MS) continue;
        if (now - (session.lastOutputAt || 0) < QUIET_IDLE_MS) continue;
        const lastHook = session.lastSignalAt[SIG_HOOK] ?? 0;
        if (now - lastHook < QUIET_IDLE_MS) continue;
        this.signal(session, SIG_OUTPUT, 'IDLE', 'quiet');
      }
    }, 15_000);
    quiet.unref();
  }

  /**
   * Apply a status signal. Lower `precedence` wins; a signal may only change state
   * if no strictly-higher-precedence signal arrived in the last few seconds.
   */
  signal(session: HubSession, precedence: number, state: SessionState, detail?: string) {
    const now = Date.now();
    session.lastSignalAt[precedence] = now;

    if (session.state === 'EXITED' && state !== 'EXITED') return; // only respawn revives
    if (session.state === state) {
      if (detail && detail !== session.detail) {
        session.detail = detail;
        this.manager.emit('change', session);
      }
      return;
    }

    for (let p = 1; p < precedence; p++) {
      if (now - (session.lastSignalAt[p] ?? 0) < HIGHER_SIGNAL_SHIELD_MS) return;
    }

    session.state = state;
    session.stateSince = now;
    session.detail = detail;
    this.manager.emit('change', session);
    this.scheduleAlert(session, state);
  }

  private scheduleAlert(session: HubSession, state: SessionState) {
    this.clearAlert(session.hubId);
    if (!ALERT_STATES.includes(state)) return;
    const timer = setTimeout(() => {
      this.alertTimers.delete(session.hubId);
      if (session.state === state) {
        this.emit('alert', { session, state, detail: session.detail });
      }
    }, ALERT_DEBOUNCE_MS);
    this.alertTimers.set(session.hubId, timer);
  }

  private clearAlert(hubId: string) {
    const timer = this.alertTimers.get(hubId);
    if (timer) clearTimeout(timer);
    this.alertTimers.delete(hubId);
  }
}
