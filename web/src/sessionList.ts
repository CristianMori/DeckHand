import type { SessionInfo, SessionState } from './types';

const STATE_RANK: Record<SessionState, number> = {
  WAITING_QUESTION: 0,
  WAITING_PERMISSION: 0,
  IDLE: 1,
  STARTING: 2,
  WORKING: 2,
  EXITED: 3,
};

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
    const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (rank !== 0) return rank;
    if (STATE_RANK[a.state] === 0) return a.stateSince - b.stateSince; // oldest wait first
    return b.createdAt - a.createdAt;
  });
}

export function renderSessionList(
  root: HTMLElement,
  sessions: SessionInfo[],
  selected: string | null,
  handlers: {
    onSelect: (s: SessionInfo) => void;
    onResume: (s: SessionInfo) => void;
    onRemove: (s: SessionInfo) => void;
    onHandoff: (s: SessionInfo) => void;
  },
) {
  root.innerHTML = '';
  if (sessions.length === 0) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.innerHTML = 'NO SESSIONS<br/>launch one with + NEW SESSION';
    root.appendChild(note);
    return;
  }

  for (const s of sortSessions(sessions)) {
    const chip = s.unreachable ? { cls: 'exited', label: 'UNREACHABLE' } : CHIP[s.state];
    const card = document.createElement('div');
    const waiting = !s.unreachable && (s.state === 'WAITING_QUESTION' || s.state === 'WAITING_PERMISSION');
    card.className = `card s-${waiting ? 'waiting' : chip.cls}${s.hubId === selected ? ' selected' : ''}${s.unreachable ? ' unreachable' : ''}`;
    card.dataset.hubId = s.hubId;

    const stateWord = waiting ? 'waiting' : s.state === 'WORKING' ? 'working' : s.state.toLowerCase();
    card.innerHTML = `
      <div class="card-top">
        <span class="card-name"></span>
        <span class="agent-tag"></span>
        ${s.machine ? '<span class="machine-tag"></span>' : ''}
        ${s.frozen ? '<span class="frozen-tag" title="folder frozen to this machine">❄</span>' : ''}
        <span class="chip ${chip.cls}">${chip.label}</span>
      </div>
      <div class="card-meta">
        <span class="cwd"></span>
        <span class="elapsed">${stateWord} ${elapsed(s.stateSince)}</span>
      </div>
      ${s.handoff ? '<div class="card-lineage"></div>' : ''}
      ${s.summary ? '<div class="card-summary"></div>' : ''}
      ${s.detail && waiting ? '<div class="card-detail"></div>' : ''}
      <div class="card-actions"></div>
    `;
    if (s.handoff) {
      (card.querySelector('.card-lineage') as HTMLElement).textContent =
        `← handed off from ${s.handoff.fromAgent} @ ${s.handoff.fromMachine}`;
    }
    (card.querySelector('.card-name') as HTMLElement).textContent = s.name;
    const engine = s.agentType || 'claude';
    (card.querySelector('.agent-tag') as HTMLElement).textContent = engine;
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
      resume.textContent = `RESUME · ${engine.toUpperCase()}`;
      resume.onclick = (e) => { e.stopPropagation(); handlers.onResume(s); };
      const remove = document.createElement('button');
      remove.className = 'ghost-btn danger';
      remove.textContent = 'REMOVE';
      remove.onclick = (e) => { e.stopPropagation(); handlers.onRemove(s); };
      actions.append(resume, handoff, remove);
    } else if (s.hubId === selected) {
      actions.append(handoff); // live: offered on the selected card only, keeps the list quiet
    } else {
      actions.remove();
    }

    card.onclick = () => handlers.onSelect(s);
    root.appendChild(card);
  }
}
