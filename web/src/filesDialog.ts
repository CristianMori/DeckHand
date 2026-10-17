import { api } from './api';
import type { FileEntry, FleetMachine } from './types';

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtAge(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * Fleet file browser: walk any connected machine's projects root, download a
 * file to this browser, or copy it to another machine (the target hub pulls
 * it from the source hub directly).
 */
export async function openFilesDialog(start?: { machine?: string; path?: string }) {
  const dialog = document.getElementById('files-dialog') as HTMLDialogElement;
  dialog.innerHTML = `
    <h2>FILES</h2>
    <div class="rs-machine-row">
      <div>
        <label>MACHINE</label>
        <select id="fb-machine"></select>
      </div>
      <div>
        <label>PATH</label>
        <div class="fb-crumbs" id="fb-crumbs"></div>
      </div>
    </div>
    <div class="resume-list fb-list" id="fb-list"><div class="empty-note">loading…</div></div>
    <div id="fb-copy" class="fb-copy" hidden>
      <span class="fb-copy-name" id="fb-copy-name"></span>
      <label>TO MACHINE</label>
      <select id="fb-copy-machine"></select>
      <label>INTO FOLDER</label>
      <input id="fb-copy-dir" placeholder="relative to that machine's projects root" />
      <label class="fb-check"><input type="checkbox" id="fb-copy-over" /> overwrite if it exists</label>
      <div class="dialog-actions">
        <button class="ghost-btn" id="fb-copy-cancel">CANCEL</button>
        <button class="primary-btn" id="fb-copy-go">COPY</button>
      </div>
      <div class="fb-status" id="fb-copy-status"></div>
    </div>
    <div class="dialog-actions"><button class="ghost-btn" id="fb-close">CLOSE</button></div>
  `;
  dialog.showModal();
  const get = <T extends HTMLElement>(id: string) => dialog.querySelector(`#${id}`) as T;
  get<HTMLButtonElement>('fb-close').onclick = () => dialog.close();

  const fleet: FleetMachine[] = (await api.fleet().catch(() => [])).filter((m) => m.connected);
  const machineSel = get<HTMLSelectElement>('fb-machine');
  machineSel.innerHTML = fleet
    .map((m) => `<option value="${m.machine}"${m.self ? ' selected' : ''}>${m.machine}${m.self ? ' (this machine)' : ''}</option>`)
    .join('');
  if (start?.machine && fleet.some((m) => m.machine === start.machine)) machineSel.value = start.machine;
  const selfName = fleet.find((m) => m.self)?.machine ?? '';
  const baseFor = (machine: string) => (fleet.find((m) => m.machine === machine)?.self ? '' : fleet.find((m) => m.machine === machine)?.url ?? '');

  let path = '';
  const listEl = get<HTMLDivElement>('fb-list');
  const crumbsEl = get<HTMLDivElement>('fb-crumbs');
  const copyBox = get<HTMLDivElement>('fb-copy');

  function renderCrumbs() {
    crumbsEl.innerHTML = '';
    const parts = path ? path.split('/') : [];
    const mk = (label: string, target: string) => {
      const b = document.createElement('button');
      b.className = 'fb-crumb';
      b.textContent = label;
      b.onclick = () => void load(target);
      return b;
    };
    crumbsEl.appendChild(mk('root', ''));
    parts.forEach((p, i) => {
      crumbsEl.appendChild(document.createTextNode(' / '));
      crumbsEl.appendChild(mk(p, parts.slice(0, i + 1).join('/')));
    });
  }

  async function load(rel: string) {
    copyBox.hidden = true;
    listEl.innerHTML = '<div class="empty-note">loading…</div>';
    const machine = machineSel.value;
    try {
      const res = await api.files(rel, fleet.find((m) => m.machine === machine)?.self ? undefined : machine);
      path = res.path;
      renderCrumbs();
      listEl.innerHTML = '';
      if (path) {
        const up = document.createElement('div');
        up.className = 'resume-row fb-row';
        up.innerHTML = '<span class="fb-name">‹ ..</span><span class="fb-actions"><button class="ghost-btn fb-zip" title="Download this whole folder as a zip (node_modules and .git left out)">ZIP THIS FOLDER</button></span>';
        up.onclick = () => void load(path.split('/').slice(0, -1).join('/'));
        (up.querySelector('.fb-zip') as HTMLButtonElement).onclick = (ev) => {
          ev.stopPropagation();
          window.open(`${baseFor(machine)}/api/files/zip?path=${encodeURIComponent(path)}`, '_blank');
        };
        listEl.appendChild(up);
      }
      if (res.entries.length === 0) listEl.innerHTML += '<div class="empty-note">empty folder</div>';
      for (const e of res.entries) {
        const row = document.createElement('div');
        row.className = `resume-row fb-row${e.dir ? ' dir' : ''}`;
        row.innerHTML = `
          <span class="fb-name"></span>
          <span class="fb-meta">${e.dir ? 'folder' : fmtSize(e.size)} · ${fmtAge(e.mtime)}</span>
          ${e.dir
            ? '<span class="fb-actions"><button class="ghost-btn fb-zip" title="Download this folder as a zip (node_modules and .git left out)">ZIP</button></span>'
            : '<span class="fb-actions"><button class="ghost-btn fb-dl">DOWNLOAD</button><button class="ghost-btn fb-cp">COPY TO…</button></span>'}
        `;
        (row.querySelector('.fb-name') as HTMLElement).textContent = e.dir ? `▸ ${e.name}` : e.name;
        const relFile = path ? `${path}/${e.name}` : e.name;
        if (e.dir) {
          row.onclick = () => void load(relFile);
          (row.querySelector('.fb-zip') as HTMLButtonElement).onclick = (ev) => {
            ev.stopPropagation();
            window.open(`${baseFor(machine)}/api/files/zip?path=${encodeURIComponent(relFile)}`, '_blank');
          };
        } else {
          (row.querySelector('.fb-dl') as HTMLButtonElement).onclick = (ev) => {
            ev.stopPropagation();
            window.open(`${baseFor(machine)}/api/files/raw?path=${encodeURIComponent(relFile)}`, '_blank');
          };
          (row.querySelector('.fb-cp') as HTMLButtonElement).onclick = (ev) => {
            ev.stopPropagation();
            openCopy(machine, relFile, e.name);
          };
        }
        listEl.appendChild(row);
      }
    } catch (err) {
      listEl.innerHTML = `<div class="empty-note">cannot list: ${err}</div>`;
    }
  }

  function openCopy(fromMachine: string, fromPath: string, name: string) {
    copyBox.hidden = false;
    get<HTMLSpanElement>('fb-copy-name').textContent = `${name}  (from ${fromMachine})`;
    const target = get<HTMLSelectElement>('fb-copy-machine');
    target.innerHTML = fleet
      .map((m) => `<option value="${m.machine}"${m.machine !== fromMachine && m.self ? ' selected' : ''}>${m.machine}${m.self ? ' (this machine)' : ''}</option>`)
      .join('');
    if (target.value === fromMachine) {
      const other = fleet.find((m) => m.machine !== fromMachine);
      if (other) target.value = other.machine;
    }
    get<HTMLInputElement>('fb-copy-dir').value = fromPath.split('/').slice(0, -1).join('/');
    const status = get<HTMLDivElement>('fb-copy-status');
    status.textContent = '';
    get<HTMLButtonElement>('fb-copy-cancel').onclick = () => (copyBox.hidden = true);
    get<HTMLButtonElement>('fb-copy-go').onclick = async () => {
      const btn = get<HTMLButtonElement>('fb-copy-go');
      btn.disabled = true;
      status.textContent = 'copying…';
      try {
        const out = await api.filesCopy({
          fromMachine,
          fromPath,
          toMachine: target.value,
          toDir: get<HTMLInputElement>('fb-copy-dir').value.trim(),
          overwrite: get<HTMLInputElement>('fb-copy-over').checked,
        });
        status.textContent = `copied ${fmtSize(out.bytes)} to ${out.machine}:${out.path}`;
      } catch (err) {
        status.textContent = `failed: ${err}`;
      } finally {
        btn.disabled = false;
      }
    };
  }

  machineSel.onchange = () => void load('');
  void selfName;
  // an absolute session folder is accepted by the hub and reported back root-relative
  await load(start?.path ?? '');
}
