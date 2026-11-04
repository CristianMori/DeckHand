import type { SessionInfo, SessionState } from './types';
import { orderSessions, finished, type OrderedCard } from './sessionOrder';

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

const ROLE_LABEL = { architect: 'ARCHITECT', subarchitect: 'SUB-ARCHITECT', worker: 'WORKER', role: 'ROLE' } as const;

/** A role instance is labelled by the charter it runs ("tester"); the others by their role. */
const roleLabel = (s: SessionInfo) => (s.role === 'role' ? s.worker?.charter || ROLE_LABEL.role : ROLE_LABEL[s.role!]);

export interface CardHandlers {
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
}

interface RestartState {
  running: Set<string>;
  failed: Map<string, string>;
}

// Cards are KEYED and REUSED between renders: a card is rebuilt only when
// something it shows changed, and the list's DOM order is touched only when
// the order itself changed — a re-render must never replace the element the
// pointer is about to click.
interface CardEntry {
  el: HTMLDivElement;
  sig: string;
  s: SessionInfo; // latest data; handlers read this ref so a reused card acts on fresh state
}
const cards = new Map<string, CardEntry>();

// While the pointer is over the list the ROOT order is held still (data keeps
// updating), and the fresh order is applied the moment the pointer leaves —
// so the cards cannot slide away from under a click. Children are stable by
// construction (ordered by start time), so only roots need holding.
let hovering = false;
let heldRootOrder: string[] | null = null;
let lastRootOrder: string[] = [];
let renderAgain: (() => void) | null = null;

function attachHold(root: HTMLElement) {
  if (root.dataset.holdOrder) return;
  root.dataset.holdOrder = '1';
  root.addEventListener('pointerenter', () => {
    hovering = true;
    heldRootOrder = [...lastRootOrder];
  });
  root.addEventListener('pointerleave', () => {
    hovering = false;
    heldRootOrder = null;
    renderAgain?.(); // apply the fresh order now that nothing is under the pointer
  });
}

/** Families (one root + its crew block) reordered to a previous root order; new families keep their fresh place at the end. */
function holdOrder(entries: OrderedCard[], rootOrder: string[]): OrderedCard[] {
  const families: OrderedCard[][] = [];
  for (const e of entries) {
    if (e.depth === 0 || !families.length) families.push([]);
    families[families.length - 1].push(e);
  }
  const pos = new Map(rootOrder.map((id, i) => [id, i]));
  return families
    .map((fam, fresh) => ({ fam, at: pos.get(fam[0].session.hubId) ?? rootOrder.length + fresh }))
    .sort((a, b) => a.at - b.at)
    .flatMap((x) => x.fam);
}

function note(root: HTMLElement, html: string) {
  cards.clear();
  root.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'empty-note';
  el.innerHTML = html;
  root.appendChild(el);
}

export function renderSessionList(
  root: HTMLElement,
  sessions: SessionInfo[],
  selected: string | null,
  handlers: CardHandlers,
  restart: RestartState,
  filter = '',
) {
  attachHold(root);
  renderAgain = () => renderSessionList(root, sessions, selected, handlers, restart, filter);

  if (sessions.length === 0) {
    lastRootOrder = [];
    note(root, 'NO SESSIONS<br/>launch one with + NEW SESSION');
    return;
  }

  let entries = orderSessions(sessions, filter);
  if (entries.length === 0) {
    lastRootOrder = [];
    note(root, 'NO MATCHES<br/>clear the filter with Esc');
    return;
  }
  if (hovering && heldRootOrder) entries = holdOrder(entries, heldRootOrder);
  lastRootOrder = entries.filter((e) => e.depth === 0).map((e) => e.session.hubId);

  // leftover notes (NO SESSIONS / NO MATCHES) from a previous render
  for (const stale of root.querySelectorAll('.empty-note')) stale.remove();

  const present = new Set<string>();
  for (const { session: s, depth } of entries) {
    present.add(s.hubId);
    const crew = sessions.filter((w) => w !== s && w.worker?.architect === s.claudeSessionId);
    const crewDone = crew.filter(finished).length;
    const sig = signature(s, depth, s.hubId === selected, restart, crew.length, crewDone);
    let entry = cards.get(s.hubId);
    if (!entry) {
      entry = { el: document.createElement('div'), sig: '', s };
      cards.set(s.hubId, entry);
    }
    entry.s = s;
    if (entry.sig !== sig) {
      entry.sig = sig;
      buildCard(entry, depth, selected, handlers, restart, crew.length, crewDone);
    } else {
      // only time moved: refresh the elapsed text in place, no DOM churn
      const el = entry.el.querySelector('.elapsed');
      if (el) el.textContent = `${stateWord(s)} ${elapsed(s.stateSince)}`;
    }
  }
  for (const [id, entry] of cards) {
    if (!present.has(id)) {
      entry.el.remove();
      cards.delete(id);
    }
  }

  // touch the DOM order only when it actually changed
  const desired = entries.map((e) => cards.get(e.session.hubId)!.el);
  const current = Array.from(root.children);
  if (current.length !== desired.length || desired.some((el, i) => current[i] !== el)) {
    for (const el of desired) root.appendChild(el);
  }
}

const stateWord = (s: SessionInfo) => {
  const waiting = !s.unreachable && (s.state === 'WAITING_QUESTION' || s.state === 'WAITING_PERMISSION');
  return waiting ? 'waiting' : s.state.toLowerCase();
};

/** Everything the card's markup depends on — a changed signature rebuilds the card in place. */
function signature(
  s: SessionInfo,
  depth: number,
  selected: boolean,
  restart: RestartState,
  crewCount: number,
  crewDone: number,
): string {
  return JSON.stringify([
    depth, selected, s.state, !!s.unreachable, s.name, s.cwd, s.machine, s.agentType, s.model,
    s.role, s.worker?.charter, !!s.frozen, s.docsBehind, s.summary, s.detail, !!s.alive,
    s.handoff?.fromAgent, s.handoff?.fromMachine,
    restart.running.has(s.hubId), restart.failed.get(s.hubId),
    crewCount, crewDone,
  ]);
}

function buildCard(
  entry: CardEntry,
  depth: number,
  selected: string | null,
  handlers: CardHandlers,
  restart: RestartState,
  crewCount: number,
  crewDone: number,
) {
  const s = entry.s;
  const card = entry.el;
  const chip = s.unreachable ? { cls: 'exited', label: 'UNREACHABLE' } : CHIP[s.state];
  const waiting = !s.unreachable && (s.state === 'WAITING_QUESTION' || s.state === 'WAITING_PERMISSION');
  card.className = `card s-${waiting ? 'waiting' : chip.cls}${s.hubId === selected ? ' selected' : ''}${s.unreachable ? ' unreachable' : ''}${restart.failed.has(s.hubId) ? ' restart-failed' : ''}${depth ? ` nested depth-${depth}` : ''}`;
  card.dataset.hubId = s.hubId;

  card.innerHTML = `
    <div class="card-top">
      <span class="card-name"></span>
      <span class="chip ${chip.cls}">${chip.label}</span>
    </div>
    <div class="card-tags">
      <span class="agent-tag"></span>
      ${s.role ? `<span class="role-tag ${s.role}"></span>` : ''}
      ${s.model?.startsWith('local/') ? '<span class="tag local">LOCAL</span>' : ''}
      ${s.machine ? '<span class="machine-tag"></span>' : ''}
      ${s.frozen ? '<span class="frozen-tag" title="folder frozen to this machine">❄</span>' : ''}
      ${(s.role === 'architect' || s.role === 'subarchitect') && (s.docsBehind ?? 0) >= 3 ? `<span class="tag docs" title="commits on this branch since docs/architect/ was last modified">docs ${s.docsBehind} behind</span>` : ''}
    </div>
    <div class="card-meta">
      <span class="cwd"></span>
      <span class="elapsed">${stateWord(s)} ${elapsed(s.stateSince)}</span>
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
    handlers.onFiles(entry.s);
  };
  const restartError = restart.failed.get(s.hubId);
  if (restartError) {
    const fail = card.querySelector('.card-restart-fail') as HTMLElement;
    (fail.querySelector('span') as HTMLElement).textContent = `RESTART FAILED: ${restartError}`;
    (fail.querySelector('button') as HTMLButtonElement).onclick = (e) => {
      e.stopPropagation();
      handlers.onDismissRestartError(entry.s);
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
      handlers.onRestart(entry.s);
    };
    card.querySelector('.card-files')!.before(restartBtn);
  }
  if (s.role === 'architect' || s.role === 'subarchitect') {
    const btn = card.querySelector('.card-swarm') as HTMLButtonElement;
    btn.textContent = crewCount ? `⛭ ${crewCount - crewDone} working · ${crewDone} finished` : '⛭ no workers';
    btn.onclick = (e) => {
      e.stopPropagation();
      handlers.onSwarm(entry.s);
    };
  }
  if (s.handoff) {
    (card.querySelector('.card-lineage') as HTMLElement).textContent =
      `← handed off from ${s.handoff.fromAgent} @ ${s.handoff.fromMachine}`;
  }
  (card.querySelector('.card-name') as HTMLElement).textContent = s.name;
  // textContent, not markup: a charter's name comes from a charter file
  if (s.role) (card.querySelector('.role-tag') as HTMLElement).textContent = roleLabel(s);
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
  handoff.onclick = (e) => { e.stopPropagation(); handlers.onHandoff(entry.s); };
  if (s.unreachable) {
    actions.remove(); // owning hub is down — nothing can act on this session
  } else if (s.state === 'EXITED') {
    const resume = document.createElement('button');
    resume.className = 'primary-btn';
    // a terminal has no conversation: it restarts as a fresh shell in the same folder
    resume.textContent = terminal ? 'RESTART · TERMINAL' : `RESUME · ${engine.toUpperCase()}`;
    resume.onclick = (e) => { e.stopPropagation(); handlers.onResume(entry.s); };
    const remove = document.createElement('button');
    remove.className = 'ghost-btn danger';
    remove.textContent = 'REMOVE';
    remove.onclick = (e) => { e.stopPropagation(); handlers.onRemove(entry.s); };
    const rename = document.createElement('button');
    rename.className = 'ghost-btn';
    rename.textContent = 'RENAME';
    rename.title = terminal ? 'Rename this card' : 'Rename the session and its folder on every machine';
    rename.onclick = (e) => { e.stopPropagation(); handlers.onRename(entry.s); };
    if (terminal) actions.append(resume, rename, remove);
    else actions.append(resume, handoff, rename, remove);
  } else if (terminal) {
    actions.remove(); // nothing to hand off
  } else if (s.hubId === selected) {
    actions.append(handoff); // live: offered on the selected card only, keeps the list quiet
  } else {
    actions.remove();
  }

  // left click selects and opens the session; right click opens the card menu.
  // iOS fires no contextmenu for touch, so a long press on the card (not on
  // its buttons) opens the menu there; where the platform does fire one on
  // long press (Android), opening the same menu twice is harmless.
  let suppressClick = false;
  let press: { timer: number; x: number; y: number } | null = null;
  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  card.onclick = (e) => {
    if (suppressClick) return;
    handlers.onSelect(entry.s, e);
  };
  card.oncontextmenu = (e) => {
    e.preventDefault();
    handlers.onContextMenu(entry.s, e);
  };
  card.onpointerdown = (e) => {
    suppressClick = false;
    if (e.pointerType !== 'touch' || (e.target as HTMLElement).closest('button')) return;
    const { clientX: x, clientY: y } = e;
    press = {
      x,
      y,
      timer: window.setTimeout(() => {
        press = null;
        suppressClick = true; // a click right after the long press must not open the session
        handlers.onContextMenu(entry.s, e);
      }, 500),
    };
  };
  card.onpointermove = (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
  };
  card.onpointerup = cancelPress;
  card.onpointercancel = cancelPress;
}
