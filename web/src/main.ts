import './styles.css';
import type { ControlMessage, SessionInfo } from './types';
import { api, withElsewhereConfirm } from './api';
import { renderSessionList } from './sessionList';
import { showTerminal, hideTerminal, dropTerminal, activeTerminal } from './terminalView';
import { buildQuickBar } from './quickAnswers';
import { openNewSessionDialog } from './newSessionDialog';
import { openResumeDialog } from './resumeDialog';
import { openAdminDialog } from './adminDialog';
import { chime, soundEnabled, setSoundEnabled } from './sound';

let sessions: SessionInfo[] = [];
let selected: string | null = null;
let tabs: string[] = []; // hubIds with an open terminal tab, in open order

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
  soundToggle: document.getElementById('sound-toggle') as HTMLButtonElement,
  newBtn: document.getElementById('new-session-btn') as HTMLButtonElement,
};

buildQuickBar(el.quickBar);

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
    (tab.querySelector('.tab-name') as HTMLElement).textContent = s.machine
      ? `${s.name} @ ${s.machine}`
      : s.name;
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

function render() {
  renderSessionList(el.list, sessions, selected, {
    onSelect: select,
    onResume: async (s) => {
      try {
        await withElsewhereConfirm((force) => api.resumeForce(s.hubId, force));
      } catch {
        return; // declined or failed — leave the card as is
      }
      dropTerminal(s.hubId);
      select(s);
    },
    onRemove: async (s) => {
      dropTerminal(s.hubId);
      tabs = tabs.filter((id) => id !== s.hubId);
      if (selected === s.hubId) deselect();
      await api.remove(s.hubId);
    },
  });

  const waiting = waitingCount();
  document.title = waiting > 0 ? `(${waiting}) Deckhand` : 'Deckhand';

  if (selected) {
    const s = sessions.find((x) => x.hubId === selected);
    if (s) el.termTitle.textContent = `${s.name}${s.machine ? ` @ ${s.machine}` : ''} — ${s.cwd} — ${s.unreachable ? 'UNREACHABLE' : s.state}`;
  }
  renderTabs();
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
    } else if (msg.type === 'alert') {
      if (msg.state !== 'IDLE') chime();
      render();
    }
  };
}

connectControl();
api.sessions().then((s) => { sessions = s; render(); }).catch(() => {});
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

el.killBtn.onclick = () => {
  if (selected) api.kill(selected);
};

// mobile back: close the terminal overlay, keep the session and its tab alive
(document.getElementById('term-back') as HTMLButtonElement).onclick = () => {
  selected = null;
  document.body.classList.remove('term-open');
  render();
};
