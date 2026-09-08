import { api, withElsewhereConfirm } from './api';
import type { FleetFolderGroup, FolderConversation, SessionInfo } from './types';

function age(ms: number): string {
  if (!ms) return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const PHASE_LABEL: Record<string, string> = {
  checking: 'checking folder…',
  'push-source': 'source machine pushing to VPS',
  pulling: 'pulling folder to target',
  transcript: 'transferring conversation',
  spawning: 'starting session…',
};

/**
 * Fleet resume: pick the machine that will run the session, pick a folder
 * (from anywhere in the fleet), pick one of its conversations, go. The hub
 * materializes the folder on the target via the VPS if it isn't there.
 */
export async function openResumeDialog(onAdopted: (s: SessionInfo) => void) {
  const dialog = document.getElementById('resume-dialog') as HTMLDialogElement;
  dialog.innerHTML = `
    <h2>RESUME CONVERSATION</h2>
    <div class="rs-machine-row">
      <div>
        <label>RUN ON MACHINE</label>
        <select id="rs-machine"></select>
      </div>
      <div>
        <label>SOURCE MACHINE</label>
        <select id="rs-source"></select>
      </div>
    </div>
    <label>FOLDER</label>
    <div class="resume-list" id="rs-folders"><div class="empty-note">loading fleet folders…</div></div>
    <div id="rs-convs-wrap" hidden>
      <label>CONVERSATION</label>
      <div class="resume-list" id="rs-convs"></div>
    </div>
    <div id="rs-progress" hidden>
      <div class="sync-phase" id="rs-phase"></div>
      <div class="sync-bar"><div class="sync-bar-fill" id="rs-bar"></div></div>
    </div>
    <div class="dialog-actions"><button class="ghost-btn" id="rs-cancel">CANCEL</button></div>
  `;
  dialog.showModal();
  const get = <T extends HTMLElement>(id: string) => dialog.querySelector(`#${id}`) as T;
  get<HTMLButtonElement>('rs-cancel').onclick = () => dialog.close();

  const [fleet, groups] = await Promise.all([
    api.fleet().catch(() => []),
    api.fleetFolders().catch(() => [] as FleetFolderGroup[]),
  ]);
  const machines = fleet.filter((m) => m.connected);
  const machineSel = get<HTMLSelectElement>('rs-machine');
  machineSel.innerHTML = machines
    .map((m) => `<option value="${m.machine}"${m.self ? ' selected' : ''}>${m.machine}${m.self ? ' (this machine)' : ''}</option>`)
    .join('');

  // source filter: which machine's folders/conversations to show
  const sourceSel = get<HTMLSelectElement>('rs-source');
  const sourceMachines = [...new Set(groups.flatMap((g) => g.locations.map((l) => l.machine ?? '')))].filter(Boolean);
  sourceSel.innerHTML =
    '<option value="">all machines</option>' +
    sourceMachines.map((m) => `<option value="${m}">${m}</option>`).join('') +
    (groups.some((g) => g.onVps) ? '<option value="__vps__">vps only</option>' : '');

  const foldersEl = get<HTMLDivElement>('rs-folders');
  const convsWrap = get<HTMLDivElement>('rs-convs-wrap');
  const convsEl = get<HTMLDivElement>('rs-convs');
  let selectedFolder: FleetFolderGroup | null = null;

  function visibleGroups(): FleetFolderGroup[] {
    const src = sourceSel.value;
    if (!src) return groups;
    if (src === '__vps__') return groups.filter((g) => g.onVps);
    return groups.filter((g) => g.locations.some((l) => l.machine === src));
  }

  function renderFolders() {
    const target = machineSel.value;
    foldersEl.innerHTML = '';
    const shown = visibleGroups();
    if (shown.length === 0) {
      foldersEl.innerHTML = '<div class="empty-note">no folders match this source</div>';
      return;
    }
    for (const g of shown) {
      const conversationCount = g.locations.reduce((n, l) => n + l.conversations.length, 0);
      const onTarget = g.locations.some((l) => l.machine === target);
      const activeOn = g.locations.filter((l) => l.activeHubSessions > 0).map((l) => l.machine);
      const where = onTarget
        ? 'local'
        : g.onVps
          ? 'on vps'
          : `on ${g.locations.map((l) => l.machine).join(', ') || '?'}`;
      const row = document.createElement('div');
      row.className = `resume-row${selectedFolder === g ? ' selected' : ''}`;
      row.innerHTML = `
        <div class="resume-row-top">
          <span class="resume-proj"></span>
          <span class="folder-where ${onTarget ? 'local' : 'remote'}">${where.toUpperCase()}</span>
          ${activeOn.length ? `<span class="chip working" title="live hub sessions in this folder">ACTIVE: ${activeOn.join(',')}</span>` : ''}
          <span class="resume-age">${age(Math.max(0, ...g.locations.map((l) => l.updatedAt)))}</span>
        </div>
        <div class="resume-snippet">${conversationCount} conversation${conversationCount === 1 ? '' : 's'}</div>
      `;
      (row.querySelector('.resume-proj') as HTMLElement).textContent = g.folder;
      row.onclick = () => {
        selectedFolder = g;
        renderFolders();
        renderConversations();
      };
      foldersEl.appendChild(row);
    }
  }

  function renderConversations() {
    if (!selectedFolder) return;
    convsWrap.hidden = false;
    convsEl.innerHTML = '';
    const src = sourceSel.value;
    const convs: (FolderConversation & { machine?: string })[] = selectedFolder.locations
      .filter((l) => !src || src === '__vps__' || l.machine === src)
      .flatMap((l) => l.conversations.map((c) => ({ ...c, machine: l.machine })))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (convs.length === 0) {
      convsEl.innerHTML =
        '<div class="empty-note">no resumable conversations in this folder' +
        (selectedFolder.locations.length === 0
          ? ' — folder exists only on the VPS; its conversations live on an offline machine'
          : '') +
        '</div>';
      return;
    }
    for (const c of convs) {
      const row = document.createElement('div');
      row.className = 'resume-row';
      row.innerHTML = `
        <div class="resume-row-top">
          <span class="resume-proj"></span>
          <span class="agent-tag">${c.agentType || 'claude'}</span>
          <span class="machine-tag">${c.machine ?? ''}</span>
          ${c.activeElsewhere ? '<span class="chip waiting" title="Open in an agent window outside the hub — resuming may fork it">LIVE ELSEWHERE</span>' : ''}
          <span class="resume-age">${age(c.updatedAt)}</span>
        </div>
        <div class="resume-snippet"></div>
      `;
      (row.querySelector('.resume-proj') as HTMLElement).textContent =
        c.title || c.claudeSessionId.slice(0, 8);
      (row.querySelector('.resume-snippet') as HTMLElement).textContent =
        c.lastText ?? '(no assistant reply yet)';
      row.onclick = () => void resume(c);
      convsEl.appendChild(row);
    }
  }

  async function resume(c: FolderConversation & { machine?: string }) {
    if (
      c.activeElsewhere &&
      !confirm('This conversation is open in another agent window. Resuming it may fork the conversation. Continue?')
    ) {
      return;
    }
    const target = machineSel.value;
    const progress = get<HTMLDivElement>('rs-progress');
    const phaseEl = get<HTMLDivElement>('rs-phase');
    const barEl = get<HTMLDivElement>('rs-bar');
    progress.hidden = false;
    convsWrap.hidden = true;
    foldersEl.parentElement?.querySelectorAll('.resume-row').forEach((r) => ((r as HTMLElement).style.pointerEvents = 'none'));

    try {
      const { jobId, machine } = await withElsewhereConfirm((force) =>
        api.fleetResume({
          folder: selectedFolder!.folder,
          agentType: c.agentType,
          claudeSessionId: c.claudeSessionId,
          sourceMachine: c.machine,
          machine: target,
          force,
        }),
      );
      for (;;) {
        const job = await api.fleetResumeStatus(jobId, machine);
        phaseEl.textContent = PHASE_LABEL[job.phase] ?? job.phase;
        barEl.style.width = `${job.pct}%`;
        if (job.phase === 'done' && job.session) {
          dialog.close();
          onAdopted(job.session);
          return;
        }
        if (job.phase === 'error') throw new Error(job.error ?? 'resume failed');
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err) {
      progress.hidden = true;
      convsWrap.hidden = false;
      foldersEl.parentElement?.querySelectorAll('.resume-row').forEach((r) => ((r as HTMLElement).style.pointerEvents = ''));
      alert(`Resume failed: ${err}`);
    }
  }

  machineSel.onchange = () => renderFolders();
  sourceSel.onchange = () => {
    selectedFolder = null;
    convsWrap.hidden = true;
    renderFolders();
  };
  renderFolders();
}
