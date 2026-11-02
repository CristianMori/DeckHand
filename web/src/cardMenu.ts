import { api, type AlertRecipients } from './api';
import type { SessionInfo } from './types';

/**
 * The popup a left click on a card opens, and the DISCORD and TEXT header
 * buttons open at their channel. Built from the session's latest card each
 * time something changes, so it stays right while the list re-renders.
 */

export interface MenuActions {
  session: (hubId: string) => SessionInfo | undefined;
  restart: (s: SessionInfo) => void;
  resume: (s: SessionInfo) => void;
  freeze: (s: SessionInfo) => void;
  autoYes: (s: SessionInfo) => void;
  handoff: (s: SessionInfo) => void;
  rename: (s: SessionInfo) => void;
  files: (s: SessionInfo) => void;
  kill: (s: SessionInfo) => void;
  remove: (s: SessionInfo) => void;
  setAlert: (s: SessionInfo, channel: Channel, people: string[]) => void;
  swarm: (s: SessionInfo) => void;
  setArchitect: (s: SessionInfo, on: boolean) => void;
}

export type Channel = 'discord' | 'text';

const CHANNEL_LABEL: Record<Channel, string> = { discord: 'DISCORD', text: 'SMS' };

let root: HTMLElement | null = null;
let current: { hubId: string; open?: Channel; at: { x: number; y: number }; actions: MenuActions } | null = null;
let recipients: AlertRecipients | null = null;

export function closeCardMenu() {
  root?.remove();
  root = null;
  current = null;
}

function item(label: string, run: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `menu-item ${cls}`;
  b.textContent = label;
  b.onclick = run;
  return b;
}

function draw() {
  if (!current) return;
  const s = current.actions.session(current.hubId);
  if (!s) return closeCardMenu();
  const a = current.actions;
  const act = (run: (s: SessionInfo) => void) => () => {
    closeCardMenu();
    run(s);
  };
  const terminal = s.agentType === 'shell';
  const exited = s.state === 'EXITED';

  root ??= Object.assign(document.createElement('div'), { id: 'card-menu', role: 'menu' });
  root.replaceChildren();
  const title = document.createElement('div');
  title.className = 'menu-title';
  title.textContent = s.name;
  root.append(title);

  // the swarm can be looked at whatever state its hub is in
  if (s.role) root.append(item('VIEW SWARM', act(a.swarm)));

  if (s.unreachable) {
    const note = document.createElement('div');
    note.className = 'menu-note';
    note.textContent = `${s.machine ?? 'Its hub'} is unreachable`;
    root.append(note);
  } else {
    if (exited) root.append(item(terminal ? 'RESTART' : 'RESUME', act(a.resume)));
    else root.append(item('RESTART', act(a.restart)));
    if (!terminal) {
      root.append(item(s.frozen ? 'UNFREEZE' : 'FREEZE', act(a.freeze)));
      root.append(item(`AUTO-YES ${s.autoYes ? 'ON' : 'OFF'}`, () => a.autoYes(s), s.autoYes ? 'on' : ''));
      if (s.alerts) for (const channel of ['discord', 'text'] as const) appendAlert(root, s, channel);
      if (!s.worker) {
        root.append(item(s.role === 'architect' ? 'STOP BEING ARCHITECT' : 'MAKE ARCHITECT', act((x) => a.setArchitect(x, s.role !== 'architect'))));
      }
      root.append(item('HAND OFF', act(a.handoff)));
    }
    if (exited) root.append(item('RENAME', act(a.rename)));
    root.append(item('FILES', act(a.files)));
    if (exited) root.append(item('REMOVE', act(a.remove), 'danger'));
    else root.append(item('KILL', act(a.kill), 'danger'));
  }

  if (!root.isConnected) document.body.append(root);
  // stays on screen whatever the click position and however long the list gets
  const { width, height } = root.getBoundingClientRect();
  root.style.left = `${Math.max(8, Math.min(current.at.x, innerWidth - width - 8))}px`;
  root.style.top = `${Math.max(8, Math.min(current.at.y, innerHeight - height - 8))}px`;
}

function appendAlert(menu: HTMLElement, s: SessionInfo, channel: Channel) {
  const chosen = s.alerts?.[channel] ?? [];
  const open = current?.open === channel;
  menu.append(
    item(`ALERT → ${CHANNEL_LABEL[channel]}: ${chosen.length ? chosen.join(', ') : 'OFF'} ${open ? '▾' : '▸'}`, () => {
      if (current) current.open = open ? undefined : channel;
      draw();
    }, chosen.length ? 'on' : ''),
  );
  if (!open) return;
  if (!recipients) {
    menu.append(Object.assign(document.createElement('div'), { className: 'menu-note', textContent: 'loading people…' }));
    return;
  }
  // someone already chosen stays listed, so they can be removed while a sender is unreachable
  const people = [...new Set([...recipients[channel], ...chosen])].sort();
  if (!people.length) {
    menu.append(Object.assign(document.createElement('div'), { className: 'menu-note', textContent: 'no people available: is the sending hub connected?' }));
  }
  for (const person of people) {
    const on = chosen.includes(person);
    const row = item(`${on ? '☑' : '☐'} ${person}`, () => {
      current?.actions.setAlert(s, channel, on ? chosen.filter((p) => p !== person) : [...chosen, person]);
    }, `menu-person${on ? ' on' : ''}`);
    row.setAttribute('role', 'menuitemcheckbox');
    row.setAttribute('aria-checked', String(on));
    menu.append(row);
  }
}

export function openCardMenu(hubId: string, at: { x: number; y: number }, actions: MenuActions, open?: Channel) {
  current = { hubId, at, actions, open };
  draw();
  recipients = null;
  void api.alertRecipients().then((r) => {
    recipients = r;
    draw();
  }).catch(() => {
    recipients = { discord: [], text: [] };
    draw();
  });
}

/** The session changed: show its new state in an open menu. */
export function refreshCardMenu() {
  if (root) draw();
}

document.addEventListener('pointerdown', (e) => {
  if (root && !root.contains(e.target as Node)) closeCardMenu();
}, true);
// taken before the terminal sees it: an Escape reaching the agent would interrupt its turn
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !root) return;
  e.preventDefault();
  e.stopPropagation();
  closeCardMenu();
}, true);
