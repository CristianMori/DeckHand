import { api } from './api';
import type { AgentInfo, SessionInfo } from './types';

const PHASE_LABEL: Record<string, string> = {
  briefing: 'previous agent is writing its brief…',
  composing: 'composing the handoff document…',
  sending: 'starting the new engine…',
};

/**
 * Hand a session to another engine, machine and/or folder. The departing agent
 * writes a brief (if live), the hub adds the conversation, drops both into the
 * target folder as .deckhand/handoff.md and starts the target with "read it".
 */
export async function openHandoffDialog(source: SessionInfo, onStarted: (s: SessionInfo) => void) {
  const dialog = document.getElementById('handoff-dialog') as HTMLDialogElement;
  const sourceFolder = source.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const engine = source.agentType || 'claude';

  dialog.innerHTML = `
    <h2>HAND OFF SESSION</h2>
    <div class="hd-from"><span class="agent-tag">${engine}</span> <span class="hd-name"></span>${source.machine ? ` @ ${source.machine}` : ''}</div>
    <div class="rs-machine-row">
      <div>
        <label>TO MACHINE</label>
        <select id="hd-machine"></select>
      </div>
      <div>
        <label>TO ENGINE</label>
        <select id="hd-agent"></select>
      </div>
    </div>
    <label>FOLDER ON TARGET</label>
    <select id="hd-folder-mode">
      <option value="same">same folder (${sourceFolder})</option>
      <option value="existing">another existing folder…</option>
      <option value="new">a new folder…</option>
    </select>
    <select id="hd-folder" hidden></select>
    <input id="hd-newfolder" placeholder="folder name — created under the target's projects root" hidden />
    <div class="rs-machine-row">
      <div>
        <label>PERMISSION MODE</label>
        <select id="hd-mode"></select>
      </div>
      <div>
        <label>MODEL</label>
        <select id="hd-model"></select>
      </div>
    </div>
    <label class="hd-check"><input type="checkbox" id="hd-brief" ${source.alive ? 'checked' : 'disabled'} /> ask the current agent to write a brief first${source.alive ? '' : ' (session not running)'}</label>
    <label class="hd-check"><input type="checkbox" id="hd-dialogue" checked /> include the full conversation</label>
    <div id="hd-progress" hidden>
      <div class="sync-phase" id="hd-phase"></div>
      <div class="sync-bar"><div class="sync-bar-fill" id="hd-bar"></div></div>
    </div>
    <div class="dialog-actions">
      <button class="ghost-btn" id="hd-cancel">CANCEL</button>
      <button class="primary-btn" id="hd-go">HAND OFF</button>
    </div>
  `;
  (dialog.querySelector('.hd-name') as HTMLElement).textContent = source.name;
  dialog.showModal();
  const get = <T extends HTMLElement>(id: string) => dialog.querySelector(`#${id}`) as T;
  get<HTMLButtonElement>('hd-cancel').onclick = () => dialog.close();

  const fleet = await api.fleet().catch(() => []);
  const machines = fleet.filter((m) => m.connected);
  const machineSel = get<HTMLSelectElement>('hd-machine');
  machineSel.innerHTML = machines
    .map((m) => `<option value="${m.machine}"${m.self ? ' selected' : ''}>${m.machine}${m.self ? ' (this machine)' : ''}</option>`)
    .join('');
  const selectedMachine = (): string | undefined =>
    machines.find((x) => x.machine === machineSel.value)?.self ? undefined : machineSel.value;

  let agents: AgentInfo[] = [];
  const agentSel = get<HTMLSelectElement>('hd-agent');
  const selectedAgent = (): AgentInfo | undefined => agents.find((a) => a.id === agentSel.value) ?? agents[0];

  function loadAgentOptions() {
    const a = selectedAgent();
    const opt = (o: { value: string; label: string }) => `<option value="${o.value}">${o.label}</option>`;
    get<HTMLSelectElement>('hd-mode').innerHTML = '<option value="">default</option>' + (a?.permissionModes ?? []).map(opt).join('');
    get<HTMLSelectElement>('hd-model').innerHTML = '<option value="">default</option>' + (a?.models ?? []).map(opt).join('');
  }
  async function loadAgents() {
    agents = (await api.agents(selectedMachine()).catch(() => [])).filter((a) => a.available !== false);
    // default to the *other* engine — that is what a handoff is usually for
    const other = agents.find((a) => a.id !== engine) ?? agents[0];
    agentSel.innerHTML = agents.map((a) => `<option value="${a.id}"${a === other ? ' selected' : ''}>${a.label}</option>`).join('');
    loadAgentOptions();
  }
  async function loadFolders() {
    const sel = get<HTMLSelectElement>('hd-folder');
    sel.innerHTML = '<option value="">loading…</option>';
    const projects = await api.projects(selectedMachine()).catch(() => []);
    sel.innerHTML = projects.map((p) => `<option value="${p.name}">${p.name}</option>`).join('') || '<option value="">no folders found</option>';
  }
  const modeSel = get<HTMLSelectElement>('hd-folder-mode');
  modeSel.onchange = () => {
    get<HTMLSelectElement>('hd-folder').hidden = modeSel.value !== 'existing';
    get<HTMLInputElement>('hd-newfolder').hidden = modeSel.value !== 'new';
  };
  machineSel.onchange = () => {
    void loadAgents();
    void loadFolders();
  };
  agentSel.onchange = loadAgentOptions;
  await Promise.all([loadAgents(), loadFolders()]);

  get<HTMLButtonElement>('hd-go').onclick = async () => {
    const a = selectedAgent();
    if (!a) return;
    const mode = modeSel.value;
    const newFolder = mode === 'new' ? get<HTMLInputElement>('hd-newfolder').value.trim() : '';
    if (mode === 'new' && !newFolder) {
      alert('Give the new folder a name.');
      return;
    }
    const go = get<HTMLButtonElement>('hd-go');
    go.disabled = true;
    const progress = get<HTMLDivElement>('hd-progress');
    const phaseEl = get<HTMLDivElement>('hd-phase');
    const barEl = get<HTMLDivElement>('hd-bar');
    progress.hidden = false;
    try {
      const { jobId, machine } = await api.handoff(source.hubId, {
        targetAgent: a.id,
        targetMachine: machineSel.value,
        targetFolder: mode === 'existing' ? get<HTMLSelectElement>('hd-folder').value : undefined,
        newFolder: newFolder || undefined,
        askBrief: get<HTMLInputElement>('hd-brief').checked,
        includeDialogue: get<HTMLInputElement>('hd-dialogue').checked,
        model: get<HTMLSelectElement>('hd-model').value || undefined,
        permissionMode: get<HTMLSelectElement>('hd-mode').value || undefined,
      });
      for (;;) {
        const job = await api.handoffStatus(jobId, machine);
        phaseEl.textContent = PHASE_LABEL[job.phase] ?? job.phase;
        barEl.style.width = `${job.pct}%`;
        if (job.phase === 'done' && job.session) {
          dialog.close();
          onStarted(job.session);
          return;
        }
        if (job.phase === 'error') throw new Error(job.error ?? 'handoff failed');
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err) {
      progress.hidden = true;
      go.disabled = false;
      alert(`Handoff failed: ${err}`);
    }
  };
}
