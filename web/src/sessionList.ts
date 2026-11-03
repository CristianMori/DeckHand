import type { SessionInfo, SessionState } from './types';

// needs attention first, then what is being worked on, then the rest;
// cards of an unreachable machine always sink to the bottom
const STATE_RANK: Record<SessionState, number> = {
  WAITING_QUESTION: 0,
  WAITING_PERMISSION: 0,
  WORKING: 1,
  STARTING: 1,
  IDLE: 2,
  EXITED: 3,
};
const UNREACHABLE_RANK = 4;

function rankOf(s: SessionInfo): number {
  return s.unreachable ? UNREACHABLE_RANK : STATE_RANK[s.state];
}

const CHIP: Record<SessionState, { cls: string; label: string }> = {
  WAITING_QUESTION: { cls: 'waiting', label: 'QUESTION' },
  WAITING_PERMISSION: { cls: 'waiting', label: 'PERMISSION' },
  IDLE: { cls: 'idle', label: 'IDLE' },
  STARTING: { cls: 'starting', label: 'STARTING' },
  WORKING: { cls: 'working', label: 'WORKING' },
  EXITED: { cls: 'exited', label: 'EXITED' },
};

function shortPath(cwd: string): string {
  if (cwd.length <= 34) return cwd;
  return cwd.slice(0, 6) + '…' + cwd.slice(-25);
}

function elapsed(since: number): string {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

export function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    const rank = rankOf(a) - rankOf(b);
    if (rank !== 0) return rank;
    if (rankOf(a) === 0) return a.stateSince - b.stateSince; // oldest wait first
    // within working, idle and exited: the card that entered the state most
    // recently sits at the top of its band — a session that just finished
    // lands right under the working ones, a session that just exited lands
    // right under the idle ones, each pushing its older siblings down one
    if (rankOf(a) >= 1 && rankOf(a) <= 3) return b.stateSince - a.stateSince;
    return b.createdAt - a.createdAt;
  });
}

/** Each follows who leads it. Finished ones stay out of the list: the swarm view has them. */
function grouped(sessions: SessionInfo[]): { session: SessionInfo; depth: number }[] {
  const sorted = sortSessions(sessions);
  const hasLead = (s: SessionInfo) => sessions.some((x) => x.claudeSessionId === s.worker?.architect);
  const crew = (s: SessionInfo) => sorted.filter((w) => w.worker?.architect === s.claudeSessionId);
  // a finished sub-architect stays while a worker of its own is still going
  const shows = (s: SessionInfo): boolean => !finished(s) || crew(s).some(shows);
  const out: { session: SessionInfo; depth: number }[] = [];
  const add = (s: SessionInfo, depth: number) => {
    out.push({ session: s, depth });
    if (depth < 2) for (const w of crew(s)) if (shows(w)) add(w, depth + 1);
  };
  for (const s of sorted) if (!s.worker || !hasLead(s)) add(s, 0);
  return out;
}

const ROLE_LABEL = { architect: 'ARCHITECT', subarchitect: 'SUB-ARCHITECT', worker: 'WORKER' } as const;

const finished = (s: SessionInfo) => !s.alive && (s.worker?.status === 'reported' || s.worker?.status === 'failed');

export function renderSessionList(
  root: HTMLElement,
  sessions: SessionInfo[],
  selected: string | null,
  handlers: {
    onSelect: (s: SessionInfo, e: MouseEvent) => void;
    onResume: (s: SessionInfo) => void;
    onRemove: (s: SessionInfo) => void;
    onRename: (s: SessionInfo) => void;
    onHandoff: (s: SessionInfo) => void;
    onFiles: (s: SessionInfo) => void;
    onRestart: (s: SessionInfo) => void;
    onDismissRestartError: (s: SessionInfo) => void;
    onSwarm: (s: SessionInfo) => void;
    onContextMenu: (s: SessionInfo, e: MouseEvent) => void;
  },
  restart: { running: Set<string>; failed: Map<string, string> },
) {
  root.innerHTML = '';
  if (sessions.length === 0) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.innerHTML = 'NO SESSIONS<br/>launch one with + NEW SESSION';
    root.appendChild(note);
    return;
  }

  for (const { session: s, depth } of grouped(sessions)) {
    const chip = s.unreachable ? { cls: 'exited', label: 'UNREACHABLE' } : CHIP[s.state];
    const card = document.createElement('div');
    const waiting = !s.unreachable && (s.state === 'WAITING_QUESTION' || s.state === 'WAITING_PERMISSION');
    card.className = `card s-${waiting ? 'waiting' : chip.cls}${s.hubId === selected ? ' selected' : ''}${s.unreachable ? ' unreachable' : ''}${restart.failed.has(s.hubId) ? ' restart-failed' : ''}${depth ? ` nested depth-${depth}` : ''}`;
    card.dataset.hubId = s.hubId;

    const stateWord = waiting ? 'waiting' : s.state === 'WORKING' ? 'working' : s.state.toLowerCase();
    card.innerHTML = `
      <div class="card-top">
        <span class="card-name"></span>
        <span class="chip ${chip.cls}">${chip.label}</span>
      </div>
      <div class="card-tags">
        <span class="agent-tag"></span>
        ${s.role ? `<span class="role-tag ${s.role}">${ROLE_LABEL[s.role]}</span>` : ''}
        ${s.model?.startsWith('local/') ? '<span class="tag local">LOCAL</span>' : ''}
        ${s.machine ? '<span class="machine-tag"></span>' : ''}
        ${s.frozen ? '<span class="frozen-tag" title="folder frozen to this machine">❄</span>' : ''}
      </div>
      <div class="card-meta">
        <span class="cwd"></span>
        <span class="elapsed">${stateWord} ${elapsed(s.stateSince)}</span>
      </div>
      ${s.handoff ? '<div class="card-lineage"></div>' : ''}
      ${s.role === 'architect' || s.role === 'subarchitect' ? '<button class="card-swarm" title="View swarm"></button>' : ''}
      ${s.summary ? '<div class="card-summary"></div>' : ''}
      ${s.detail && waiting ? '<div class="card-detail"></div>' : ''}
      ${restart.failed.has(s.hubId) ? '<div class="card-restart-fail"><span></span><button class="ghost-btn" title="Dismiss">✕</button></div>' : ''}
      <div class="card-foot">
        ${s.model?.startsWith('local/') ? '<span class="tag model"></span>' : ''}
        <button class="ghost-btn card-files" title="Browse this session's folder on its machine">FILES</button>
      </div>
      <div class="card-actions"></div>
    `;
    (card.querySelector('.card-files') as HTMLButtonElement).onclick = (e) => {
      e.stopPropagation();
      handlers.onFiles(s);
    };
    const restartError = restart.failed.get(s.hubId);
    if (restartError) {
      const fail = card.querySelector('.card-restart-fail') as HTMLElement;
      (fail.querySelector('span') as HTMLElement).textContent = `RESTART FAILED: ${restartError}`;
      (fail.querySelector('button') as HTMLButtonElement).onclick = (e) => {
        e.stopPropagation();
        handlers.onDismissRestartError(s);
      };
    }
    if (!s.unreachable && (s.state !== 'EXITED' || restart.running.has(s.hubId))) {
      const restartBtn = document.createElement('button');
      restartBtn.className = 'ghost-btn card-restart';
      const running = restart.running.has(s.hubId);
      restartBtn.textContent = running ? 'RESTARTING…' : 'RESTART';
      restartBtn.disabled = running;
      restartBtn.title = 'Kill this session and start it again on the same conversation';
      restartBtn.onclick = (e) => {
        e.stopPropagation();
        handlers.onRestart(s);
      };
      card.querySelector('.card-files')!.before(restartBtn);
    }
    if (s.role === 'architect' || s.role === 'subarchitect') {
      const crew = sessions.filter((w) => w.worker?.architect === s.claudeSessionId);
      const done = crew.filter(finished).length;
      const btn = card.querySelector('.card-swarm') as HTMLButtonElement;
      btn.textContent = crew.length ? `⛭ ${crew.length - done} working · ${done} finished` : '⛭ no workers';
      btn.onclick = (e) => {
        e.stopPropagation();
        handlers.onSwarm(s);
      };
    }
    if (s.handoff) {
      (card.querySelector('.card-lineage') as HTMLElement).textContent =
        `← handed off from ${s.handoff.fromAgent} @ ${s.handoff.fromMachine}`;
    }
    (card.querySelector('.card-name') as HTMLElement).textContent = s.name;
    const terminal = s.agentType === 'shell';
    const engine = terminal ? 'terminal' : s.agentType || 'claude';
    (card.querySelector('.agent-tag') as HTMLElement).textContent = engine;
    const modelTag = card.querySelector('.tag.model') as HTMLElement | null;
    if (modelTag && s.model) {
      const id = s.model.slice('local/'.length);
      modelTag.textContent = id.length > 18 ? id.slice(0, 17) + '…' : id;
      modelTag.title = s.model;
    }
    if (s.machine) (card.querySelector('.machine-tag') as HTMLElement).textContent = s.machine;
    (card.querySelector('.cwd') as HTMLElement).textContent = shortPath(s.cwd);
    if (s.summary) (card.querySelector('.card-summary') as HTMLElement).textContent = s.summary;
    if (s.detail && waiting) (card.querySelector('.card-detail') as HTMLElement).textContent = `⚠ ${s.detail}`;

    const actions = card.querySelector('.card-actions') as HTMLElement;
    const handoff = document.createElement('button');
    handoff.className = 'ghost-btn';
    handoff.textContent = 'HAND OFF';
    handoff.title = 'Continue this work with another engine, machine or folder';
    handoff.onclick = (e) => { e.stopPropagation(); handlers.onHandoff(s); };
    if (s.unreachable) {
      actions.remove(); // owning hub is down — nothing can act on this session
    } else if (s.state === 'EXITED') {
      const resume = document.createElement('button');
      resume.className = 'primary-btn';
      // a terminal has no conversation: it restarts as a fresh shell in the same folder
      resume.textContent = terminal ? 'RESTART · TERMINAL' : `RESUME · ${engine.toUpperCase()}`;
      resume.onclick = (e) => { e.stopPropagation(); handlers.onResume(s); };
      const remove = document.createElement('button');
      remove.className = 'ghost-btn danger';
      remove.textContent = 'REMOVE';
      remove.onclick = (e) => { e.stopPropagation(); handlers.onRemove(s); };
      const rename = document.createElement('button');
      rename.className = 'ghost-btn';
      rename.textContent = 'RENAME';
      rename.title = terminal ? 'Rename this card' : 'Rename the session and its folder on every machine';
      rename.onclick = (e) => { e.stopPropagation(); handlers.onRename(s); };
      if (terminal) actions.append(resume, rename, remove);
      else actions.append(resume, handoff, rename, remove);
    } else if (terminal) {
      actions.remove(); // nothing to hand off
    } else if (s.hubId === selected) {
      actions.append(handoff); // live: offered on the selected card only, keeps the list quiet
    } else {
      actions.remove();
    }

    card.onclick = (e) => handlers.onSelect(s, e);
    card.oncontextmenu = (e) => {
      e.preventDefault();
      handlers.onContextMenu(s, e);
    };
    root.appendChild(card);
  }
}
