import { api, withElsewhereConfirm } from './api';
import { sortSessions } from './sessionList';
import type { SessionInfo } from './types';

// Bulk maintenance: one compact row per session, tick some, then kill,
// resume or remove them together. The list follows the live session
// broadcast while the dialog is open, ticks survive the refresh.

let getSessions: () => SessionInfo[] = () => [];
let onRemoved: (hubId: string) => void = () => {};
const checked = new Set<string>();
let busy = false;

const dialog = () => document.getElementById('manage-dialog') as HTMLDialogElement;

const live = (s: SessionInfo) => s.alive && s.state !== 'EXITED';
const engineOf = (s: SessionInfo) => (s.agentType === 'shell' ? 'terminal' : s.agentType || 'claude');

export function openManageDialog(sessions: () => SessionInfo[], removed: (hubId: string) => void) {
  getSessions = sessions;
  onRemoved = removed;
  checked.clear();
  const d = dialog();
  d.innerHTML = `
    <h2>MANAGE SESSIONS</h2>
    <div class="mg-select">
      <label class="mg-all"><input type="checkbox" id="mg-all" /> ALL</label>
      <button class="ghost-btn" id="mg-exited">EXITED</button>
      <button class="ghost-btn" id="mg-live">LIVE</button>
      <button class="ghost-btn" id="mg-none">NONE</button>
      <span class="mg-count" id="mg-count"></span>
    </div>
    <div class="mg-list" id="mg-rows"></div>
    <div class="mg-status" id="mg-status"></div>
    <div class="dialog-actions">
      <button class="ghost-btn danger" id="mg-kill">KILL</button>
      <button class="ghost-btn" id="mg-resume">RESUME</button>
      <button class="ghost-btn danger" id="mg-remove">REMOVE</button>
      <button class="ghost-btn" id="mg-close">CLOSE</button>
    </div>
  `;
  const get = <T extends HTMLElement>(id: string) => d.querySelector(`#${id}`) as T;
  const pick = (test: (s: SessionInfo) => boolean) => {
    checked.clear();
    for (const s of getSessions()) if (!s.unreachable && test(s)) checked.add(s.hubId);
    updateManageDialog();
  };
  get<HTMLInputElement>('mg-all').onchange = (e) => {
    const on = (e.target as HTMLInputElement).checked;
    pick(() => on);
  };
  get<HTMLButtonElement>('mg-exited').onclick = () => pick((s) => !live(s));
  get<HTMLButtonElement>('mg-live').onclick = () => pick(live);
  get<HTMLButtonElement>('mg-none').onclick = () => pick(() => false);
  get<HTMLButtonElement>('mg-close').onclick = () => d.close();
  get<HTMLButtonElement>('mg-kill').onclick = () => void bulk('kill');
  get<HTMLButtonElement>('mg-resume').onclick = () => void bulk('resume');
  get<HTMLButtonElement>('mg-remove').onclick = () => void bulk('remove');
  updateManageDialog();
  d.showModal();
}

/** Called on every session broadcast; a no-op while the dialog is closed. */
export function updateManageDialog() {
  const d = dialog();
  if (!d.open || !d.querySelector('#mg-rows')) return;
  const sessions = sortSessions(getSessions());
  // drop ticks of sessions that vanished or went unreachable
  for (const id of [...checked]) {
    if (!sessions.some((s) => s.hubId === id && !s.unreachable)) checked.delete(id);
  }

  const rows = d.querySelector('#mg-rows') as HTMLElement;
  rows.innerHTML = sessions.length ? '' : '<div class="empty-note">NO SESSIONS</div>';
  for (const s of sessions) {
    const row = document.createElement('label');
    row.className = `mg-row${s.unreachable ? ' unreachable' : ''}`;
    const state = s.unreachable ? 'UNREACHABLE' : s.state.replace('WAITING_', '');
    const cls = s.unreachable || s.state === 'EXITED' ? 'exited'
      : s.state.startsWith('WAITING') ? 'waiting'
      : s.state === 'IDLE' ? 'idle' : 'working';
    row.innerHTML = `
      <input type="checkbox" />
      <span class="mg-name"></span>
      <span class="mg-meta"></span>
      <span class="chip ${cls}">${state}</span>
    `;
    const box = row.querySelector('input') as HTMLInputElement;
    box.checked = checked.has(s.hubId);
    box.disabled = !!s.unreachable; // its hub is down, nothing can act on it
    box.onchange = () => {
      if (box.checked) checked.add(s.hubId);
      else checked.delete(s.hubId);
      syncButtons();
    };
    (row.querySelector('.mg-name') as HTMLElement).textContent = s.name;
    (row.querySelector('.mg-meta') as HTMLElement).textContent =
      [engineOf(s), s.machine].filter(Boolean).join(' · ');
    row.title = s.cwd;
    rows.appendChild(row);
  }
  syncButtons();
}

function selection() {
  return getSessions().filter((s) => checked.has(s.hubId) && !s.unreachable);
}

// each button names how many of the ticked sessions it would act on
function syncButtons() {
  const d = dialog();
  const sel = selection();
  const total = getSessions().filter((s) => !s.unreachable).length;
  const nLive = sel.filter(live).length;
  const nExited = sel.length - nLive;
  const set = (id: string, label: string, n: number) => {
    const b = d.querySelector(`#${id}`) as HTMLButtonElement;
    b.textContent = n ? `${label} (${n})` : label;
    b.disabled = busy || n === 0;
  };
  set('mg-kill', 'KILL', nLive);
  set('mg-resume', 'RESUME', nExited);
  set('mg-remove', 'REMOVE', sel.length);
  const all = d.querySelector('#mg-all') as HTMLInputElement;
  all.checked = total > 0 && sel.length === total;
  all.indeterminate = sel.length > 0 && sel.length < total;
  (d.querySelector('#mg-count') as HTMLElement).textContent = `${sel.length} of ${total} selected`;
}

async function bulk(action: 'kill' | 'resume' | 'remove') {
  const sel = selection();
  const targets = action === 'kill' ? sel.filter(live) : action === 'resume' ? sel.filter((s) => !live(s)) : sel;
  if (!targets.length) return;
  const liveCount = targets.filter(live).length;
  if (action === 'kill' && !confirm(`Kill ${targets.length} session(s)? They stay resumable from their cards.`)) return;
  if (action === 'remove' && !confirm(
    `Remove ${targets.length} session card(s)?` +
      (liveCount ? `\n\n${liveCount} of them are still running and will be killed first.` : '') +
      '\n\nThe conversations stay on disk and can be found again with RESUME ⟳.',
  )) return;

  busy = true;
  syncButtons();
  const status = dialog().querySelector('#mg-status') as HTMLElement;
  const failed: string[] = [];
  let done = 0;
  for (const s of targets) {
    status.textContent = `${action} ${++done}/${targets.length}: ${s.name}…`;
    try {
      if (action === 'kill') await ok(api.kill(s.hubId));
      else if (action === 'remove') {
        await ok(api.remove(s.hubId));
        onRemoved(s.hubId);
        checked.delete(s.hubId);
      } else await withElsewhereConfirm((force) => api.resumeForce(s.hubId, force));
    } catch (err) {
      failed.push(`${s.name}: ${String(err).replace(/^Error: /, '')}`);
    }
  }
  busy = false;
  status.textContent = failed.length
    ? `${failed.length} failed — ${failed.join('; ')}`
    : `${action} done for ${targets.length} session(s)`;
  updateManageDialog();
}

async function ok(res: Promise<Response>) {
  const r = await res;
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
}
