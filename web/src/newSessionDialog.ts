import { api, withElsewhereConfirm } from './api';
import type { SessionInfo } from './types';

export async function openNewSessionDialog(onSpawned: (s: SessionInfo) => void) {
  const dialog = document.getElementById('new-session-dialog') as HTMLDialogElement;
  const fleet = await api.fleet().catch(() => []);
  const machines = fleet.filter((m) => m.connected);
  const multiMachine = machines.length > 1;

  dialog.innerHTML = `
    <h2>LAUNCH SESSION</h2>
    ${multiMachine ? `
    <label>MACHINE</label>
    <select id="ns-machine">
      ${machines.map((m) => `<option value="${m.machine}"${m.self ? ' selected' : ''}>${m.machine}${m.self ? ' (this machine)' : ''}</option>`).join('')}
    </select>` : ''}
    <label>PROJECT FOLDER</label>
    <select id="ns-folder"></select>
    <label>SESSION NAME (optional)</label>
    <input id="ns-name" placeholder="defaults to folder name" />
    <label>INITIAL PROMPT (optional)</label>
    <textarea id="ns-prompt" placeholder="sent as the first message"></textarea>
    <label>PERMISSION MODE</label>
    <select id="ns-mode">
      <option value="">default</option>
      <option value="acceptEdits">acceptEdits</option>
      <option value="plan">plan</option>
      <option value="bypassPermissions">bypassPermissions</option>
    </select>
    <label>MODEL</label>
    <select id="ns-model">
      <option value="">default</option>
      <option value="opus">opus</option>
      <option value="sonnet">sonnet</option>
      <option value="haiku">haiku</option>
    </select>
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
