import type { SessionInfo } from './types';

/**
 * One architect and its workers: who was told what, how each stands, what it
 * has been using. Live: drawn again when a session in it changes, so anything
 * open stays open.
 */

const STATUS: Record<string, { cls: string; label: string }> = {
  working: { cls: 'working', label: 'WORKING' },
  asking: { cls: 'waiting', label: 'ASKING' },
  stalled: { cls: 'waiting', label: 'STALLED' },
  reported: { cls: 'idle', label: 'REPORTED' },
  failed: { cls: 'exited', label: 'FAILED' },
};

let current: { architect: string; sessions: () => SessionInfo[]; open: (s: SessionInfo) => void } | null = null;
let drawn = '';
const expanded = new Set<string>();

function dialog() {
  return document.getElementById('swarm-dialog') as HTMLDialogElement;
}

function ago(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function chip(cls: string, label: string): HTMLSpanElement {
  const c = document.createElement('span');
  c.className = `chip ${cls}`;
  c.textContent = label;
  return c;
}

function section(label: string, text: string, cls = ''): HTMLElement {
  const box = div(`sw-section ${cls}`);
  box.append(div('sw-label', label), div('sw-text', text));
  return box;
}

function workerCard(s: SessionInfo): HTMLElement {
  const w = s.worker!;
  const live = s.alive && !s.unreachable;
  const status = STATUS[w.status] ?? STATUS.working;
  const card = div(`sw-card s-${status.cls}`);

  const top = div('sw-top');
  const name = div('sw-name', s.name);
  top.append(name, chip(status.cls, status.label));
  card.append(top);

  const facts = [s.machine, s.agentType ?? 'claude', s.model, live ? s.state.toLowerCase() : 'stopped', `started ${ago(w.startedAt)}`].filter(Boolean).join(' · ');
  card.append(div('sw-meta', facts));
  if (w.branch) {
    const size = w.commits === undefined ? '' : ` · ${w.commits} commit${w.commits === 1 ? '' : 's'}, ${w.files ?? 0} file${w.files === 1 ? '' : 's'}`;
    card.append(div('sw-meta sw-branch', `${w.branch}${size}`));
  } else {
    card.append(div('sw-meta', 'in the architect\'s folder: not a git repository'));
  }

  const task = section('INSTRUCTION', [w.task, ...(w.followUps ?? []).map((f) => `then: ${f}`)].join('\n\n'), expanded.has(s.hubId) ? 'open' : '');
  task.onclick = () => {
    if (expanded.has(s.hubId)) expanded.delete(s.hubId);
    else expanded.add(s.hubId);
    drawn = '';
    drawSwarm();
  };
  task.title = 'Click to show all of it, or less';
  card.append(task);

  if (w.question && w.status === 'asking') card.append(section('ASKED THE ARCHITECT', w.question, 'sw-ask'));
  if (w.result) card.append(section(w.status === 'failed' ? 'WHY IT STOPPED' : 'RESULT', w.result, 'sw-result'));

  const tools = Object.entries(s.toolUse ?? {}).sort((a, b) => b[1] - a[1]);
  if (tools.length) {
    const box = div('sw-section');
    box.append(div('sw-label', 'TOOLS'));
    const row = div('sw-tools');
    for (const [tool, count] of tools) row.append(Object.assign(document.createElement('span'), { className: 'sw-tool', textContent: `${tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')} ${count}` }));
    box.append(row);
    card.append(box);
  }
  if (live && s.tool) card.append(div('sw-meta sw-now', `now: ${s.tool.summary}`));

  const open = document.createElement('button');
  open.className = 'ghost-btn';
  open.textContent = 'OPEN TERMINAL';
  open.onclick = () => {
    closeSwarm();
    current?.open(s);
  };
  const foot = div('sw-foot');
  foot.append(open);
  card.append(foot);
  return card;
}

function drawSwarm() {
  if (!current) return;
  const all = current.sessions();
  const lead = all.find((s) => s.claudeSessionId === current!.architect);
  const workers = all
    .filter((s) => s.worker?.architect === current!.architect)
    // the ones still going first, then the latest to finish
    .sort((a, b) => Number(!!b.worker!.reportedAt === false) - Number(!!a.worker!.reportedAt === false) || (b.worker!.reportedAt ?? b.worker!.startedAt) - (a.worker!.reportedAt ?? a.worker!.startedAt));

  // the times in it move on their own: only what actually changed redraws
  const signature = JSON.stringify([lead?.state, lead?.name, workers.map((s) => [s.hubId, s.name, s.state, s.alive, s.worker, s.toolUse, s.tool?.summary])]);
  if (signature === drawn) return;
  drawn = signature;

  const d = dialog();
  const scroll = d.querySelector('.sw-workers')?.scrollTop ?? 0;
  d.replaceChildren();
  const h = document.createElement('h2');
  h.textContent = 'SWARM';
  d.append(h);

  const head = div('sw-architect');
  const top = div('sw-top');
  top.append(div('sw-name', lead?.name ?? workers[0]?.worker?.architectName ?? 'architect'), chip('starting', 'ARCHITECT'));
  if (lead) top.append(chip(lead.alive ? (lead.state === 'WORKING' ? 'working' : 'idle') : 'exited', lead.alive ? lead.state : 'STOPPED'));
  head.append(top);
  if (lead) head.append(div('sw-meta', `${lead.machine ?? ''} · ${lead.cwd}`));
  const going = workers.filter((s) => !s.worker!.reportedAt).length;
  head.append(div('sw-meta', workers.length ? `${going} going, ${workers.length - going} finished` : ''));
  d.append(head);

  if (workers.length) {
    d.append(div('sw-trunk'));
    const list = div('sw-workers');
    for (const s of workers) list.append(workerCard(s));
    d.append(list);
    list.scrollTop = scroll;
  } else {
    d.append(div('empty-note', 'NO WORKERS YET'));
  }

  const actions = div('dialog-actions');
  const close = document.createElement('button');
  close.className = 'ghost-btn';
  close.textContent = 'CLOSE';
  close.onclick = closeSwarm;
  actions.append(close);
  d.append(actions);
}

export function closeSwarm() {
  dialog().close();
}

/** Any member of the swarm opens it: an architect, or one of its workers. */
export function openSwarm(s: SessionInfo, sessions: () => SessionInfo[], open: (s: SessionInfo) => void) {
  const saved = current;
  current = { architect: s.worker?.architect ?? s.claudeSessionId, sessions, open };
  if (saved?.architect !== current.architect) expanded.clear();
  drawn = '';
  drawSwarm();
  if (!dialog().open) dialog().showModal();
}

export function updateSwarm() {
  if (dialog().open) drawSwarm();
}
