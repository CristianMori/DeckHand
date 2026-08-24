import { api } from './api';
import type { AdminStatus } from './types';

function fmtUptime(s?: number): string {
  if (s === undefined) return '';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}

export async function openAdminDialog() {
  const dialog = document.getElementById('admin-dialog') as HTMLDialogElement;
  dialog.innerHTML = `
    <h2>FLEET ADMIN</h2>
    <div class="resume-list" id="ad-rows"><div class="empty-note">querying fleet…</div></div>
    <div class="dialog-actions">
      <button class="ghost-btn" id="ad-check">CHECK FOR UPDATES</button>
      <button class="ghost-btn" id="ad-close">CLOSE</button>
    </div>
  `;
  dialog.showModal();
  const rowsEl = dialog.querySelector('#ad-rows') as HTMLElement;
  (dialog.querySelector('#ad-close') as HTMLButtonElement).onclick = () => dialog.close();

  const machines: string[] = [];
  let watching = new Map<string, number>(); // machine -> build we expect to exceed

  async function statusFor(machine: string): Promise<AdminStatus | null> {
    try {
      return await api.adminStatus(machine);
    } catch {
      return null;
    }
  }

  async function refresh() {
    const fleet = await api.fleet().catch(() => []);
    machines.length = 0;
    machines.push(...fleet.filter((m) => m.connected).map((m) => m.machine));
    const statuses = await Promise.all(machines.map((m) => statusFor(m)));

    rowsEl.innerHTML = '';
    machines.forEach((machine, i) => {
      const s = statuses[i];
      const row = document.createElement('div');
      row.className = 'resume-row admin-row';
      if (!s) {
        row.innerHTML = `<div class="resume-row-top"><span class="resume-proj">${machine}</span><span class="chip exited">NO ANSWER</span></div>`;
        rowsEl.appendChild(row);
        return;
      }
      const updating = s.updating || watching.has(machine);
      const badge = updating
        ? '<span class="chip working">UPDATING…</span>'
        : s.updateAvailable
          ? `<span class="chip waiting">BUILD ${s.latestBuild} AVAILABLE</span>`
          : s.build === 0
            ? '<span class="chip starting" title="dev checkout — auto-update disabled">DEV</span>'
            : '<span class="chip idle">UP TO DATE</span>';
      row.innerHTML = `
        <div class="resume-row-top">
          <span class="resume-proj"></span>
          ${badge}
          <span class="resume-age">up ${fmtUptime(s.uptimeS)}</span>
        </div>
        <div class="resume-snippet">v${s.version} · build ${s.build}${s.error ? ` · ⚠ ${s.error}` : ''}</div>
        <div class="card-actions"></div>
      `;
      (row.querySelector('.resume-proj') as HTMLElement).textContent = machine;
      const actions = row.querySelector('.card-actions') as HTMLElement;
      if (s.updateAvailable && !updating) {
        const btn = document.createElement('button');
        btn.className = 'primary-btn';
        btn.textContent = 'UPDATE';
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = 'UPDATING…';
          watching.set(machine, s.build);
          await api.adminUpdate(machine).catch(() => {});
          void watchLoop();
        };
        actions.appendChild(btn);
      }
      const restart = document.createElement('button');
      restart.className = 'ghost-btn danger';
      restart.textContent = 'RESTART';
      restart.onclick = async () => {
        if (!confirm(`Restart the hub on ${machine}? Live sessions there become resumable EXITED cards.`)) return;
        await api.adminRestart(machine).catch(() => {});
        watching.set(machine, -1);
        void watchLoop();
      };
      actions.appendChild(restart);
      rowsEl.appendChild(row);
    });
  }

  let watchTimer: number | undefined;
  async function watchLoop() {
    if (watchTimer) return;
    const started = Date.now();
    const tick = async () => {
      if (!dialog.open || watching.size === 0 || Date.now() - started > 180_000) {
        watchTimer = undefined;
        watching = new Map();
        return;
      }
      for (const [machine, oldBuild] of [...watching]) {
        const s = await statusFor(machine);
        if (s && !s.updating && (oldBuild === -1 || s.build > oldBuild)) watching.delete(machine);
      }
      await refresh();
      watchTimer = window.setTimeout(() => void tick(), 4000);
    };
    watchTimer = window.setTimeout(() => void tick(), 4000);
  }

  (dialog.querySelector('#ad-check') as HTMLButtonElement).onclick = async () => {
    const btn = dialog.querySelector('#ad-check') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'CHECKING…';
    await Promise.all(machines.map((m) => api.adminCheck(m).catch(() => null)));
    await refresh();
    btn.disabled = false;
    btn.textContent = 'CHECK FOR UPDATES';
  };

  await refresh();
}
