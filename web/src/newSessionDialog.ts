import { api, withElsewhereConfirm } from './api';
import type { AgentInfo, SessionInfo } from './types';

const FALLBACK_AGENTS: AgentInfo[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    models: ['opus', 'sonnet', 'haiku'].map((m) => ({ value: m, label: m })),
    permissionModes: ['acceptEdits', 'plan', 'bypassPermissions'].map((m) => ({ value: m, label: m })),
    canResume: true,
  },
];

export async function openNewSessionDialog(onSpawned: (s: SessionInfo) => void) {
  const dialog = document.getElementById('new-session-dialog') as HTMLDialogElement;
  const [fleet, agentsRaw] = await Promise.all([
    api.fleet().catch(() => []),
    api.agents().catch(() => FALLBACK_AGENTS),
  ]);
  const agents = agentsRaw.length ? agentsRaw : FALLBACK_AGENTS;
  const machines = fleet.filter((m) => m.connected);
  const multiMachine = machines.length > 1;
  const multiAgent = agents.length > 1;

  dialog.innerHTML = `
    <h2>LAUNCH SESSION</h2>
    ${multiMachine ? `
    <label>MACHINE</label>
    <select id="ns-machine">
      ${machines.map((m) => `<option value="${m.machine}"${m.self ? ' selected' : ''}>${m.machine}${m.self ? ' (this machine)' : ''}</option>`).join('')}
    </select>` : ''}
    ${multiAgent ? `
    <label>AGENT</label>
    <select id="ns-agent">
      ${agents.map((a) => `<option value="${a.id}">${a.label}</option>`).join('')}
    </select>` : ''}
    <label>PROJECT FOLDER</label>
    <select id="ns-folder"></select>
    <label>SESSION NAME (optional)</label>
    <input id="ns-name" placeholder="defaults to folder name" />
    <label>INITIAL PROMPT (optional)</label>
    <textarea id="ns-prompt" placeholder="sent as the first message"></textarea>
    <label>PERMISSION MODE</label>
    <select id="ns-mode"></select>
    <label>MODEL</label>
    <select id="ns-model"></select>
    <div class="dialog-actions">
      <button class="ghost-btn" id="ns-cancel">CANCEL</button>
      <button class="primary-btn" id="ns-launch">LAUNCH</button>
    </div>
  `;

  const get = <T extends HTMLElement>(id: string) => dialog.querySelector(`#${id}`) as T;

  const selectedMachine = (): string | undefined => {
    if (!multiMachine) return undefined;
    const m = get<HTMLSelectElement>('ns-machine').value;
    return machines.find((x) => x.machine === m)?.self ? undefined : m;
  };
  const selectedAgent = (): AgentInfo =>
    (multiAgent && agents.find((a) => a.id === get<HTMLSelectElement>('ns-agent').value)) || agents[0];

  // model and permission vocabularies belong to the chosen agent
  function loadAgentOptions() {
    const a = selectedAgent();
    const opt = (o: { value: string; label: string }) => `<option value="${o.value}">${o.label}</option>`;
    get<HTMLSelectElement>('ns-mode').innerHTML = '<option value="">default</option>' + a.permissionModes.map(opt).join('');
    get<HTMLSelectElement>('ns-model').innerHTML = '<option value="">default</option>' + a.models.map(opt).join('');
  }

  // folder list comes from whichever machine will run the session
  async function loadFolders() {
    const folder = get<HTMLSelectElement>('ns-folder');
    folder.innerHTML = '<option value="">loading…</option>';
    const projects = await api.projects(selectedMachine()).catch(() => []);
    folder.innerHTML = projects
      .map((p) => `<option value="${p.path}">${p.name}</option>`)
      .join('') || '<option value="">no folders found</option>';
  }
  if (multiMachine) get<HTMLSelectElement>('ns-machine').onchange = () => void loadFolders();
  if (multiAgent) get<HTMLSelectElement>('ns-agent').onchange = loadAgentOptions;
  loadAgentOptions();
  await loadFolders();

  get<HTMLButtonElement>('ns-cancel').onclick = () => dialog.close();
  get<HTMLButtonElement>('ns-launch').onclick = async () => {
    const btn = get<HTMLButtonElement>('ns-launch');
    btn.disabled = true;
    btn.textContent = 'LAUNCHING…';
    try {
      const session = await withElsewhereConfirm((force) =>
        api.spawn({
          cwd: get<HTMLSelectElement>('ns-folder').value,
          agentType: selectedAgent().id,
          name: get<HTMLInputElement>('ns-name').value.trim() || undefined,
          initialPrompt: get<HTMLTextAreaElement>('ns-prompt').value.trim() || undefined,
          permissionMode: get<HTMLSelectElement>('ns-mode').value || undefined,
          model: get<HTMLSelectElement>('ns-model').value || undefined,
          machine: selectedMachine(),
          force,
        }),
      );
      dialog.close();
      onSpawned(session);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'LAUNCH';
      alert(`Launch failed: ${err}`);
    }
  };

  dialog.showModal();
}
