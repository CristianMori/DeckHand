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
  const fleet = await api.fleet().catch(() => []);
  const machines = fleet.filter((m) => m.connected);
  const multiMachine = machines.length > 1;
  let agents: AgentInfo[] = FALLBACK_AGENTS;

  dialog.innerHTML = `
    <h2>LAUNCH SESSION</h2>
    ${multiMachine ? `
    <label>MACHINE</label>
    <select id="ns-machine">
      ${machines.map((m) => `<option value="${m.machine}"${m.self ? ' selected' : ''}>${m.machine}${m.self ? ' (this machine)' : ''}</option>`).join('')}
    </select>` : ''}
    <label>ENGINE</label>
    <select id="ns-agent"></select>
    <div id="ns-install" class="ns-install" hidden></div>
    <label>PROJECT FOLDER</label>
    <select id="ns-folder"></select>
    <input id="ns-newfolder" placeholder="new folder name — created under the projects root" hidden />
    <label>SESSION NAME (optional)</label>
    <input id="ns-name" placeholder="defaults to folder name" />
    <label id="ns-prompt-label">INITIAL PROMPT (optional)</label>
    <textarea id="ns-prompt" placeholder="sent as the first message"></textarea>
    <label id="ns-mode-label">PERMISSION MODE</label>
    <select id="ns-mode"></select>
    <label id="ns-model-label">MODEL</label>
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
    agents.find((a) => a.id === get<HTMLSelectElement>('ns-agent').value) ?? agents[0];

  // model and permission vocabularies belong to the chosen agent
  function loadAgentOptions() {
    const a = selectedAgent();
    const opt = (o: { value: string; label: string }) => `<option value="${o.value}">${o.label}</option>`;
    get<HTMLSelectElement>('ns-mode').innerHTML = '<option value="">default</option>' + a.permissionModes.map(opt).join('');
    // a terminal lists its shells in the model slot, the machine default first
    get<HTMLSelectElement>('ns-model').innerHTML = (a.terminal ? '' : '<option value="">default</option>') + a.models.map(opt).join('');
    get('ns-model-label').textContent = a.optionLabel ?? 'MODEL';
    const noModes = !a.permissionModes.length;
    get('ns-mode-label').hidden = noModes;
    get('ns-mode').hidden = noModes;
    get('ns-prompt-label').textContent = a.terminal ? 'INITIAL COMMAND (optional)' : 'INITIAL PROMPT (optional)';
    get<HTMLTextAreaElement>('ns-prompt').placeholder = a.terminal ? 'typed into the shell once it starts' : 'sent as the first message';
    syncHomeOption();
  }

  // a terminal can start in the home folder, not only in a project
  function syncHomeOption() {
    const folder = get<HTMLSelectElement>('ns-folder');
    const home = folder.querySelector('option[value="~"]');
    if (selectedAgent().terminal) {
      if (!home && folder.options.length) {
        folder.insertAdjacentHTML('afterbegin', '<option value="~">~ (home folder)</option>');
        folder.value = '~';
      }
    } else if (home) {
      const wasHome = folder.value === '~';
      home.remove();
      if (wasHome) folder.selectedIndex = 0;
    }
  }

  // the agents on offer are the ones installed on the machine that will run the session
  async function loadAgents() {
    const list = await api.agents(selectedMachine()).catch(() => FALLBACK_AGENTS);
    agents = list.filter((a) => a.available !== false);
    renderInstall(list.filter((a) => a.available === false && a.install));
    const sel = get<HTMLSelectElement>('ns-agent');
    const launch = get<HTMLButtonElement>('ns-launch');
    // a viewer-only machine: nothing to run sessions with
    if (!agents.length) {
      agents = FALLBACK_AGENTS;
      sel.innerHTML = '<option value="">no engine installed on this machine</option>';
      launch.disabled = true;
      return;
    }
    launch.disabled = false;
    const prev = sel.value;
    sel.innerHTML = agents.map((a) => `<option value="${a.id}">${a.label}</option>`).join('');
    if (agents.some((a) => a.id === prev)) sel.value = prev;
    loadAgentOptions();
  }

  // engines missing on that machine: one click opens a terminal there running
  // the installer, so the user watches it and signs in in the same card
  function renderInstall(missing: AgentInfo[]) {
    const box = get('ns-install');
    box.hidden = !missing.length;
    box.innerHTML = '';
    for (const a of missing) {
      const btn = document.createElement('button');
      btn.className = 'ghost-btn';
      btn.textContent = `INSTALL ${a.label.toUpperCase()}`;
      btn.title = `Opens a terminal on that machine running:\n${a.install}\nThen type "${a.id}" in it to sign in.`;
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const session = await api.spawn({
            cwd: '~',
            agentType: 'shell',
            name: `install ${a.id}`,
            initialPrompt: a.install,
            machine: selectedMachine(),
          });
          dialog.close();
          onSpawned(session);
        } catch (err) {
          btn.disabled = false;
          alert(`Could not open a terminal there: ${err}`);
        }
      };
      box.appendChild(btn);
    }
  }

  // folder list comes from whichever machine will run the session
  async function loadFolders() {
    const folder = get<HTMLSelectElement>('ns-folder');
    folder.innerHTML = '<option value="">loading…</option>';
    const projects = await api.projects(selectedMachine()).catch(() => []);
    folder.innerHTML =
      projects.map((p) => `<option value="${p.path}">${p.name}</option>`).join('') +
      '<option value="__new__">+ new project folder…</option>';
    syncHomeOption();
    folder.onchange = () => {
      const isNew = folder.value === '__new__';
      get<HTMLInputElement>('ns-newfolder').hidden = !isNew;
      if (isNew) get<HTMLInputElement>('ns-newfolder').focus();
    };
    get<HTMLInputElement>('ns-newfolder').hidden = true;
  }
  if (multiMachine) {
    get<HTMLSelectElement>('ns-machine').onchange = () => {
      void loadFolders();
      void loadAgents();
    };
  }
  get<HTMLSelectElement>('ns-agent').onchange = loadAgentOptions;
  await Promise.all([loadAgents(), loadFolders()]);

  get<HTMLButtonElement>('ns-cancel').onclick = () => dialog.close();
  get<HTMLButtonElement>('ns-launch').onclick = async () => {
    const btn = get<HTMLButtonElement>('ns-launch');
    const isNew = get<HTMLSelectElement>('ns-folder').value === '__new__';
    const newFolder = isNew ? get<HTMLInputElement>('ns-newfolder').value.trim() : '';
    if (isNew && !newFolder) {
      alert('Give the new project folder a name.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'LAUNCHING…';
    try {
      const session = await withElsewhereConfirm((force) =>
        api.spawn({
          cwd: isNew ? undefined : get<HTMLSelectElement>('ns-folder').value,
          newFolder: newFolder || undefined,
          agentType: selectedAgent().id,
          name: get<HTMLInputElement>('ns-name').value.trim() || (newFolder || undefined),
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
