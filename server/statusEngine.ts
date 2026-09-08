import { EventEmitter } from 'node:events';
import { agentFor } from './agents/index.js';
import type { HubSession, SessionManager } from './sessionManager.js';
import type { SessionState } from './types.js';
import { SIG_OUTPUT } from './types.js';

const HIGHER_SIGNAL_SHIELD_MS = 3000; // lower-precedence signals can't override within this window
const ALERT_DEBOUNCE_MS = 1500; // state must persist this long before alerting

const ALERT_STATES: SessionState[] = ['WAITING_QUESTION', 'WAITING_PERMISSION', 'IDLE'];

/**
 * Fuses the four status signals (PTY exit, hooks, ~/.claude/sessions files, output
 * heuristics) into one state per session, with precedence and alert debouncing.
 * Events: 'alert' ({ session, state, detail }).
 */
export class StatusEngine extends EventEmitter {
  private alertTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private manager: SessionManager) {
    super();
    // S4: raw output flow marks WORKING; prompt-box patterns suggest WAITING.
    manager.on('data', (session: HubSession, chunk: string) => {
      if (session.hooksSeen) return; // hooks + sessions-file carry the load once seen
      const waitingRx = agentFor(session).outputWaitingRegex;
      if (waitingRx && waitingRx.test(chunk)) {
        this.signal(session, SIG_OUTPUT, 'WAITING_PERMISSION', 'prompt detected in output');
      } else if (
        chunk.length > 4 &&
        // ignore boot noise, but never let a session sit in STARTING forever
        // when hook delivery is broken on a machine — output is proof of life
        (session.state !== 'STARTING' || Date.now() - session.createdAt > 15_000)
      ) {
        this.signal(session, SIG_OUTPUT, 'WORKING');
      }
    });
    manager.on('exit', (session: HubSession) => this.clearAlert(session.hubId));
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
