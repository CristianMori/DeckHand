import { openCardMenu, refreshCardMenu, type Channel, type MenuActions } from './cardMenu';
import './styles.css';
import type { ControlMessage, SessionInfo } from './types';
import { api, withElsewhereConfirm } from './api';
import { renderSessionList } from './sessionList';
import { showTerminal, hideTerminal, dropTerminal, activeTerminal } from './terminalView';
import { buildQuickBar } from './quickAnswers';
import { openNewSessionDialog } from './newSessionDialog';
import { openResumeDialog } from './resumeDialog';
import { openHandoffDialog } from './handoffDialog';
import { openAdminDialog } from './adminDialog';
import { openAuditDialog } from './auditDialog';
import { openFilesDialog } from './filesDialog';
import { openManageDialog, updateManageDialog } from './manageDialog';
import { chime, soundEnabled, setSoundEnabled } from './sound';

let sessions: SessionInfo[] = [];
let selected: string | null = null;
let tabs: string[] = []; // hubIds with an open terminal tab, in open order
const restart = { running: new Set<string>(), failed: new Map<string, string>() };

const el = {
  list: document.getElementById('session-list')!,
  connStatus: document.getElementById('conn-status')!,
  tabBar: document.getElementById('term-tabs')!,
  placeholder: document.getElementById('terminal-placeholder')!,
  termHeader: document.getElementById('terminal-header')!,
  termTitle: document.getElementById('terminal-title')!,
  termHost: document.getElementById('terminal-host')!,
  quickBar: document.getElementById('quick-bar')!,
  killBtn: document.getElementById('kill-btn') as HTMLButtonElement,
  autoYesBtn: document.getElementById('autoyes-btn') as HTMLButtonElement,
  discordBtn: document.getElementById('discord-btn') as HTMLButtonElement,
  textBtn: document.getElementById('text-btn') as HTMLButtonElement,
  frozenBtn: document.getElementById('frozen-btn') as HTMLButtonElement,
  soundToggle: document.getElementById('sound-toggle') as HTMLButtonElement,
  newBtn: document.getElementById('new-session-btn') as HTMLButtonElement,
};

buildQuickBar(el.quickBar, () => sessions.find((x) => x.hubId === selected) ?? null);

// ---------------------------------------------------------------- render

function waitingCount(): number {
  return sessions.filter((s) => s.state === 'WAITING_QUESTION' || s.state === 'WAITING_PERMISSION').length;
}

const TAB_DOT: Record<string, string> = {
  WORKING: 'working',
  STARTING: 'working',
  WAITING_QUESTION: 'waiting',
  WAITING_PERMISSION: 'waiting',
  IDLE: 'idle',
  EXITED: 'exited',
};

/** "local/qwen3-30b-a3b" -> "qwen3-30b-a3b" (shortened); undefined for hosted models */
export function localModelLabel(model?: string): string | undefined {
  if (!model || !model.startsWith('local/')) return undefined;
  const id = model.slice('local/'.length);
  return id.length > 18 ? id.slice(0, 17) + '…' : id;
}

function renderTabs() {
  // drop tabs whose sessions vanished (removed on another dashboard, etc.)
  tabs = tabs.filter((id) => sessions.some((s) => s.hubId === id));
  el.tabBar.hidden = tabs.length === 0;
  el.tabBar.innerHTML = '';
  for (const id of tabs) {
    const s = sessions.find((x) => x.hubId === id)!;
    const tab = document.createElement('div');
    tab.className = `term-tab${id === selected ? ' active' : ''}`;
    tab.innerHTML = `
      <span class="dot ${s.unreachable ? 'exited' : TAB_DOT[s.state] ?? 'idle'}"></span>
      <span class="tab-name"></span>
      <span class="tab-min" title="Close tab — session keeps running">–</span>
      <span class="tab-x" title="End session and close tab">×</span>
    `;
    const agentSuffix = ` · ${s.agentType === 'shell' ? 'terminal' : s.agentType || 'claude'}`;
    (tab.querySelector('.tab-name') as HTMLElement).textContent =
      (s.machine ? `${s.name} @ ${s.machine}` : s.name) + agentSuffix;
    // sessions on a locally served model wear LOCAL plus the model name
    const local = localModelLabel(s.model);
    if (local) {
      const t1 = document.createElement('span');
      t1.className = 'tag local';
      t1.textContent = 'LOCAL';
      t1.title = `local model: ${local}`;
      (tab.querySelector('.tab-name') as HTMLElement).after(t1);
    }
    tab.onclick = () => select(s);
    tab.onauxclick = (e) => {
      if (e.button === 1) {
        e.stopPropagation();
        removeTabView(id); // middle-click = soft close, browser-style
      }
    };
    (tab.querySelector('.tab-min') as HTMLElement).onclick = (e) => {
      e.stopPropagation();
      removeTabView(id);
    };
    (tab.querySelector('.tab-x') as HTMLElement).onclick = (e) => {
      e.stopPropagation();
      void closeTab(id);
    };
    el.tabBar.appendChild(tab);
  }
}

/** Close the tab view only — the session (if any) keeps running. */
function removeTabView(hubId: string) {
  dropTerminal(hubId);
  tabs = tabs.filter((id) => id !== hubId);
  if (selected === hubId) {
    const next = tabs[tabs.length - 1];
    if (next) {
      const ns = sessions.find((x) => x.hubId === next);
      if (ns) {
        select(ns);
        return;
      }
    }
    deselect();
  }
  renderTabs();
}

async function closeTab(hubId: string) {
  const s = sessions.find((x) => x.hubId === hubId);
  if (s && s.alive && !s.unreachable && s.state !== 'EXITED') {
    if (!confirm(`End session "${s.name}"? (it stays resumable from its card)`)) return;
    await api.kill(hubId);
  }
  removeTabView(hubId);
}

/** Kill and respawn one session; a failure stays on its card in red. */
async function restartSession(s: SessionInfo, onlyIdle = false): Promise<boolean> {
  restart.running.add(s.hubId);
  restart.failed.delete(s.hubId);
  render();
  try {
    await api.restart(s.hubId, onlyIdle);
    dropTerminal(s.hubId); // the old screen is gone: reattach to the new process
    if (selected === s.hubId) showTerminal(s.hubId);
    return true;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    restart.failed.set(s.hubId, text.match(/"error":"((?:[^"\\]|\\.)*)"/)?.[1] ?? text);
    return false;
  } finally {
    restart.running.delete(s.hubId);
    render();
  }
}

const RESTART_ALL_AT_ONCE = 3;

/** Every idle agent session on the machine this dashboard is served from. */
async function restartAllIdle(btn: HTMLButtonElement) {
  const { machine } = await api.hubInfo();
  // terminals stay out: a quiet shell reads as idle but may be running something
  const targets = sessions.filter((s) => s.machine === machine && s.state === 'IDLE' && !s.unreachable && s.agentType !== 'shell');
  if (!targets.length) {
    alert(`No idle sessions on ${machine}.`);
    return;
  }
  if (!confirm(`Restart ${targets.length} idle session${targets.length > 1 ? 's' : ''} on ${machine}?\n\n${targets.map((s) => s.name).join('\n')}`)) return;
  btn.disabled = true;
  let done = 0;
  let failed = 0;
  const progress = () => (btn.textContent = `RESTARTING ${done}/${targets.length}`);
  progress();
  const queue = [...targets];
  await Promise.all(
    Array.from({ length: RESTART_ALL_AT_ONCE }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        if (!(await restartSession(s, true))) failed++;
        done++;
        progress();
      }
    }),
  );
  btn.disabled = false;
  btn.textContent = failed ? `RESTART ALL · ${failed} FAILED` : 'RESTART ALL';
}

const cardHandlers = {
  onSelect: (s: SessionInfo, e: MouseEvent) => {
    select(s);
    // a phone's tap opens the terminal full screen; its header has the same controls
    if (!matchMedia('(max-width: 760px)').matches) openCardMenu(s.hubId, { x: e.clientX, y: e.clientY }, menuActions);
  },
  onResume: async (s: SessionInfo) => {
    try {
      await withElsewhereConfirm((force) => api.resumeForce(s.hubId, force));
    } catch {
      return; // declined or failed — leave the card as is
    }
    restart.failed.delete(s.hubId);
    dropTerminal(s.hubId);
    select(s);
  },
  onRemove: async (s: SessionInfo) => {
    restart.failed.delete(s.hubId);
    dropTerminal(s.hubId);
    tabs = tabs.filter((id) => id !== s.hubId);
    if (selected === s.hubId) deselect();
    await api.remove(s.hubId);
  },
  onRename: async (s: SessionInfo) => {
    const terminal = s.agentType === 'shell';
    const name = prompt(
      terminal
        ? `Rename ${s.name} to:`
        : `Rename ${s.name} to:\n\nThe folder is renamed too, on every machine that has it, with its conversations and memory.`,
      s.name,
    )?.trim();
    if (!name || name === s.name) return;
    try {
      const r = await api.rename(s.hubId, name);
      // offline machines are not a problem: they catch up when they reconnect
      const problems = r.machines.filter((m) => m.error).map((m) => `${m.machine}: ${m.error}`);
      if (problems.length) alert(`Renamed to ${name}, but:\n\n${problems.join('\n')}`);
    } catch (err) {
      alert(`Rename failed: ${String(err).replace(/^Error: \d+: /, '')}`);
    }
  },
  onHandoff: (s: SessionInfo) => void openHandoffDialog(s, (ns) => select(ns)),
  onFiles: (s: SessionInfo) => void openFilesDialog({ machine: s.machine, path: s.cwd }),
  onRestart: (s: SessionInfo) => {
    const warning =
      s.agentType === 'shell'
        ? `Restart terminal "${s.name}"?\n\nIt comes back as a fresh shell; whatever is running in it stops.`
        : s.state !== 'IDLE'
          ? `"${s.name}" is ${s.state}. Restart it anyway?\n\nThe conversation comes back, but what it is doing right now stops.`
          : '';
    if (warning && !confirm(warning)) return;
    void restartSession(s);
  },
  onDismissRestartError: (s: SessionInfo) => {
    restart.failed.delete(s.hubId);
    render();
  },
};

const menuActions: MenuActions = {
  session: (hubId) => sessions.find((x) => x.hubId === hubId),
  restart: cardHandlers.onRestart,
  resume: cardHandlers.onResume,
  freeze: (s) => void toggleFrozen(s),
  autoYes: toggleAutoYes,
  handoff: cardHandlers.onHandoff,
  rename: cardHandlers.onRename,
  files: cardHandlers.onFiles,
  kill: (s) => void api.kill(s.hubId),
  remove: cardHandlers.onRemove,
  setAlert: (s, channel, people) => {
    if (!s.alerts) return;
    const before = s.alerts;
    s.alerts = { ...before, [channel]: people }; // optimistic; broadcast will confirm
    render();
    api.alerts(s.hubId, { [channel]: people }).catch(() => {
      s.alerts = before;
      render();
    });
  },
};

function render() {
  renderSessionList(el.list, sessions, selected, cardHandlers, restart);

  const waiting = waitingCount();
  document.title = waiting > 0 ? `(${waiting}) Deckhand` : 'Deckhand';

  if (selected) {
    const s = sessions.find((x) => x.hubId === selected);
    if (s) {
      el.termTitle.textContent = `${s.name}${s.machine ? ` @ ${s.machine}` : ''} — ${s.cwd} — ${s.unreachable ? 'UNREACHABLE' : s.state}`;
      el.autoYesBtn.textContent = s.autoYes ? 'AUTO-YES ON' : 'AUTO-YES OFF';
      el.autoYesBtn.classList.toggle('active', !!s.autoYes);
      el.frozenBtn.textContent = s.frozen ? '❄ FROZEN' : 'FREEZE';
      el.frozenBtn.classList.toggle('active', !!s.frozen);
      // a terminal has no prompts to auto-answer and no project folder to pin
      const terminal = s.agentType === 'shell';
      el.frozenBtn.hidden = !!s.unreachable || terminal;
      el.autoYesBtn.hidden = terminal;
      // the owning hub holds the choice: no control when it can't be reached or is too old
      const alerts = terminal || s.unreachable ? undefined : s.alerts;
      for (const [btn, label, people] of [
        [el.discordBtn, 'DISCORD', alerts?.discord],
        [el.textBtn, 'SMS', alerts?.text],
      ] as const) {
        btn.hidden = !alerts;
        btn.textContent = `${label} ${people?.length ? 'ON' : 'OFF'}`;
        btn.classList.toggle('active', !!people?.length);
        btn.title = people?.length ? `Alerts ${people.join(', ')}. Click to change.` : `Choose who is alerted by ${label === 'SMS' ? 'SMS' : 'Discord'}`;
      }
    }
  }
  renderTabs();
  updateManageDialog();
  refreshCardMenu();
}

el.frozenBtn.onclick = () => {
  const s = sessions.find((x) => x.hubId === selected);
  if (s) void toggleFrozen(s);
};

async function toggleFrozen(s: SessionInfo) {
  const folder = s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const next = !s.frozen;
  if (
    next &&
    !confirm(
      `Freeze "${folder}" to ${s.machine ?? 'this machine'}?\n\nIt will never sync to the VPS or other machines, and its conversations can only be resumed here. Existing replication of this folder stops.`,
    )
  ) {
    return;
  }
  try {
    await api.setFrozen(folder, next, s.machine);
  } catch (err) {
    alert(`Could not change freeze state: ${err}`);
  }
}

function select(s: SessionInfo) {
  selected = s.hubId;
  if (!tabs.includes(s.hubId)) tabs.push(s.hubId);
  el.placeholder.hidden = true;
  el.termHeader.hidden = false;
  el.termHost.hidden = false;
  el.quickBar.hidden = false;
  document.body.classList.add('term-open'); // mobile: terminal becomes an overlay
  showTerminal(s.hubId);
  render();
}

function deselect() {
  selected = null;
  hideTerminal();
  el.placeholder.hidden = false;
  el.termHeader.hidden = true;
  el.termHost.hidden = true;
  el.quickBar.hidden = true;
  document.body.classList.remove('term-open');
  renderTabs();
}

// ---------------------------------------------------------------- shared files

// A session handed the user a file (dh_send_file): the dashboard the user is
// looking at starts the download by itself. One in the background holds it
// and downloads when brought forward, if that happens within two minutes.
// Files already on the cards when the page loads are not downloaded again.
const PENDING_FILE_MS = 120_000;
let seenFiles: Set<string> | null = null;
let pendingFiles: { url: string; name: string; at: number }[] = [];

function startDownload(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function flushPendingFiles() {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
  const fresh = pendingFiles.filter((f) => Date.now() - f.at < PENDING_FILE_MS);
  pendingFiles = [];
  for (const f of fresh) startDownload(f.url, f.name);
}

function downloadNewFiles() {
  const files = sessions.flatMap((s) => s.files ?? []);
  if (!seenFiles) {
    seenFiles = new Set(files.map((f) => f.id));
    return;
  }
  for (const f of files) {
    if (seenFiles.has(f.id)) continue;
    seenFiles.add(f.id);
    pendingFiles.push({ url: f.url, name: f.name, at: Date.now() });
  }
  flushPendingFiles();
}
window.addEventListener('focus', flushPendingFiles);
document.addEventListener('visibilitychange', flushPendingFiles);

// ---------------------------------------------------------------- control WS

function connectControl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/control`);

  ws.onopen = () => {
    el.connStatus.textContent = 'LINK UP';
    el.connStatus.className = 'conn online';
  };
  ws.onclose = () => {
    el.connStatus.textContent = 'LINK DOWN';
    el.connStatus.className = 'conn offline';
    setTimeout(connectControl, 1500);
  };
  ws.onmessage = (ev) => {
    const msg: ControlMessage = JSON.parse(ev.data);
    if (msg.type === 'sessions' && msg.sessions) {
      sessions = msg.sessions;
      render();
      downloadNewFiles();
    } else if (msg.type === 'alert') {
      if (msg.state !== 'IDLE') chime();
      render();
    }
  };
}

connectControl();
api.sessions().then((s) => { sessions = s; render(); downloadNewFiles(); }).catch(() => {});
setInterval(render, 5000); // keep elapsed timers fresh

// ---------------------------------------------------------------- top bar

function refreshSoundBtn() {
  el.soundToggle.textContent = soundEnabled() ? 'SND ON' : 'SND OFF';
}
el.soundToggle.onclick = () => {
  setSoundEnabled(!soundEnabled());
  refreshSoundBtn();
};
refreshSoundBtn();

el.newBtn.onclick = () => openNewSessionDialog((s) => select(s));
(document.getElementById('resume-btn') as HTMLButtonElement).onclick = () =>
  openResumeDialog((s) => select(s));
(document.getElementById('admin-btn') as HTMLButtonElement).onclick = () => void openAdminDialog();
(document.getElementById('audit-btn') as HTMLButtonElement).onclick = () => void openAuditDialog();
(document.getElementById('files-btn') as HTMLButtonElement).onclick = () => void openFilesDialog();
(document.getElementById('manage-btn') as HTMLButtonElement).onclick = () =>
  openManageDialog(() => sessions, (hubId) => {
    dropTerminal(hubId);
    tabs = tabs.filter((id) => id !== hubId);
    if (selected === hubId) deselect();
  });
const restartAllBtn = document.getElementById('restart-all-btn') as HTMLButtonElement;
restartAllBtn.onclick = () => void restartAllIdle(restartAllBtn);

el.killBtn.onclick = () => {
  if (selected) api.kill(selected);
};

function toggleAutoYes(s: SessionInfo) {
  const before = !!s.autoYes;
  s.autoYes = !before; // optimistic; broadcast will confirm
  render();
  api.autoYes(s.hubId, !before).catch(() => {
    s.autoYes = before;
    render();
  });
}
el.autoYesBtn.onclick = () => {
  const s = sessions.find((x) => x.hubId === selected);
  if (s) toggleAutoYes(s);
};

function openAlertMenu(btn: HTMLButtonElement, channel: Channel) {
  if (!selected) return;
  const r = btn.getBoundingClientRect();
  openCardMenu(selected, { x: r.left, y: r.bottom + 4 }, menuActions, channel);
}
el.discordBtn.onclick = () => openAlertMenu(el.discordBtn, 'discord');
el.textBtn.onclick = () => openAlertMenu(el.textBtn, 'text');

// iOS: fixed overlays don't shrink when the on-screen keyboard opens — track
// the visual viewport so the terminal panel always ends above the keyboard
// (the resize also re-fits the PTY, so the TUI's composer reflows into view)
const vv = window.visualViewport;
if (vv) {
  const applyViewport = () => {
    document.documentElement.style.setProperty('--vv-height', `${vv.height}px`);
    document.documentElement.style.setProperty('--vv-top', `${vv.offsetTop}px`);
  };
  vv.addEventListener('resize', applyViewport);
  vv.addEventListener('scroll', applyViewport);
  applyViewport();
}

// mobile back: close the terminal overlay, keep the session and its tab alive
(document.getElementById('term-back') as HTMLButtonElement).onclick = () => {
  selected = null;
  document.body.classList.remove('term-open');
  render();
};
