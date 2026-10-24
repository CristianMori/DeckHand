import { api } from './api';
import type { AdminStatus } from './types';

function fmtUptime(s?: number): string {
  if (s === undefined) return '';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function fmtWhen(iso?: string): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  const ago = Math.round((Date.now() - t) / 1000);
  const rel = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.floor(ago / 60)}m ago` : ago < 86400 ? `${Math.floor(ago / 3600)}h ago` : `${Math.floor(ago / 86400)}d ago`;
  return `${new Date(t).toLocaleString()} (${rel})`;
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString();

export async function openAdminDialog() {
  const dialog = document.getElementById('admin-dialog') as HTMLDialogElement;
  dialog.innerHTML = `
    <h2>FLEET ADMIN</h2>
    <div class="ad-target" id="ad-target"></div>
    <div class="ad-columns">
      <section>
        <div class="ad-col-title">MACHINES</div>
        <div class="resume-list" id="ad-rows"><div class="empty-note">querying fleet…</div></div>
      </section>
      <section>
        <div class="ad-col-title">GATEWAY AGENTS</div>
        <div class="resume-list" id="ad-agents"><div class="empty-note">querying gateway…</div></div>
      </section>
    </div>
    <div class="ad-log-head">
      <span class="ad-col-title" id="ad-log-title">CROSS REQUESTS — ALL MACHINES</span>
      <input id="ad-log-filter" placeholder="filter: session, caller, path, text, request id…" />
      <button class="ghost-btn" id="ad-log-all">CROSS REQUESTS</button>
    </div>
    <div class="ad-log" id="ad-log"><div class="empty-note">loading…</div></div>
    <div class="dialog-actions">
      <button class="primary-btn" id="ad-update-all">UPDATE ALL</button>
      <button class="ghost-btn" id="ad-check">CHECK FOR UPDATES</button>
      <button class="ghost-btn" id="ad-close">CLOSE</button>
    </div>
  `;
  dialog.showModal();
  const rowsEl = dialog.querySelector('#ad-rows') as HTMLElement;
  const targetEl = dialog.querySelector('#ad-target') as HTMLElement;
  const agentsEl = dialog.querySelector('#ad-agents') as HTMLElement;
  const logEl = dialog.querySelector('#ad-log') as HTMLElement;
  const logTitle = dialog.querySelector('#ad-log-title') as HTMLElement;
  const filterEl = dialog.querySelector('#ad-log-filter') as HTMLInputElement;
  (dialog.querySelector('#ad-close') as HTMLButtonElement).onclick = () => dialog.close();

  // ── log pane: one gateway agent's requests, or every machine's provenance log
  let logMode: { kind: 'fleet' } | { kind: 'agent'; id: string } = { kind: 'fleet' };
  let logSeq = 0;

  async function showFleetLog(opts: { id?: string } = {}) {
    logMode = { kind: 'fleet' };
    const seq = ++logSeq;
    logTitle.textContent = opts.id ? `REQUEST ${opts.id.slice(0, 8)} — EVERY HOP` : 'CROSS REQUESTS — ALL MACHINES';
    const fleet = await api.fleet().catch(() => []);
    const machines = fleet.filter((m) => m.connected).map((m) => m.machine);
    const q = filterEl.value.trim();
    const results = await Promise.all(machines.map((m) => api.provenance(m, { q: q || undefined, id: opts.id, limit: 300 }).catch(() => [])));
    if (seq !== logSeq) return;
    const rows = results.flat().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 500);
    if (!rows.length) {
      logEl.innerHTML = '<div class="empty-note">nothing logged yet</div>';
      return;
    }
    logEl.innerHTML = `<table class="ad-table"><thead><tr>
      <th>WHEN</th><th>MACHINE</th><th>CALLER</th><th>VIA</th><th>REQUEST</th><th>SESSION</th><th>STATUS</th><th>WHAT</th><th>ID</th>
    </tr></thead><tbody>${rows
      .map(
        (e) => `<tr class="${e.status >= 400 ? 'bad' : ''}">
        <td>${esc(fmtTime(e.at))}</td><td>${esc(e.machine)}</td><td>${esc(e.caller)}</td><td>${esc(e.via.join(' → '))}</td>
        <td>${esc(`${e.method} ${e.path}`)}</td>
        <td title="${esc(e.target?.conversationId ?? '')}">${esc(e.target ? (e.target.name ?? e.target.id) : '')}</td>
        <td>${esc(e.status)} · ${esc(e.ms)}ms</td><td>${esc(e.detail ?? '')}</td>
        <td><a href="#" class="ad-trace" data-id="${esc(e.id)}">${esc(e.id.slice(0, 8))}</a></td></tr>`,
      )
      .join('')}</tbody></table>`;
    logEl.querySelectorAll<HTMLAnchorElement>('.ad-trace').forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        void showFleetLog({ id: a.dataset.id });
      };
    });
  }

  async function showAgentLog(id: string) {
    logMode = { kind: 'agent', id };
    const seq = ++logSeq;
    logTitle.textContent = `GATEWAY AGENT ${id.toUpperCase()} — REQUESTS`;
    const lines = await api.gatewayAgentLog(id, 500).catch(() => []);
    if (seq !== logSeq) return;
    const q = filterEl.value.trim().toLowerCase();
    const rows = q ? lines.filter((l) => JSON.stringify(l).toLowerCase().includes(q)) : lines;
    if (!rows.length) {
      logEl.innerHTML = '<div class="empty-note">no requests logged for this agent</div>';
      return;
    }
    logEl.innerHTML = `<table class="ad-table"><thead><tr>
      <th>WHEN</th><th>FROM</th><th>REQUEST</th><th>STATUS</th><th>WHAT</th><th>ID</th>
    </tr></thead><tbody>${rows
      .map((l) => {
        const what = l.event ? `${l.event}${l.authError ? `: ${l.authError}` : ''}` : (l.authError ?? l.text ?? '');
        const req = l.method ? `${l.method} ${l.path}` : '';
        return `<tr class="${(l.status ?? 200) >= 400 ? 'bad' : ''}"><td>${esc(fmtTime(l.at))}</td><td>${esc(l.ip ?? '')}</td>
          <td>${esc(req)}</td><td>${esc(l.status ?? '')}${l.ms !== undefined ? ` · ${esc(l.ms)}ms` : ''}</td><td>${esc(what)}</td>
          <td>${l.req ? `<a href="#" class="ad-trace" data-id="${esc(l.req)}">${esc(l.req.slice(0, 8))}</a>` : ''}</td></tr>`;
      })
      .join('')}</tbody></table>`;
    // a gateway request's id is the id it carries through the hubs
    logEl.querySelectorAll<HTMLAnchorElement>('.ad-trace').forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        void showFleetLog({ id: a.dataset.id });
      };
    });
  }

  let filterTimer: number | undefined;
  filterEl.oninput = () => {
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => void (logMode.kind === 'agent' ? showAgentLog(logMode.id) : showFleetLog()), 300);
  };
  (dialog.querySelector('#ad-log-all') as HTMLButtonElement).onclick = () => void showFleetLog();

  // ── gateway agents column
  async function refreshAgents() {
    const info = await api.gatewayAgents().catch(() => null);
    if (!info) {
      agentsEl.innerHTML = '<div class="empty-note">gateway machine not reachable</div>';
      return;
    }
    if (!info.present) {
      agentsEl.innerHTML = `<div class="empty-note">no gateway installed on ${esc(info.machine)}</div>`;
      return;
    }
    if (!info.agents.length) {
      agentsEl.innerHTML = '<div class="empty-note">no agent has been given a token yet</div>';
      return;
    }
    agentsEl.innerHTML = '';
    for (const a of info.agents) {
      const row = document.createElement('div');
      row.className = 'resume-row admin-row';
      const chip = a.live
        ? '<span class="chip working">LIVE</span>'
        : a.status === 'enrolled'
          ? '<span class="chip idle">ENROLLED</span>'
          : '<span class="chip waiting">TOKEN PENDING</span>';
      row.innerHTML = `
        <div class="resume-row-top"><span class="resume-proj">${esc(a.id)}</span>${chip}</div>
        <div class="resume-snippet">last interaction: ${esc(fmtWhen(a.lastSeen))}</div>
        <div class="resume-snippet">${esc(a.requests)} requests${a.denied ? ` · ${esc(a.denied)} refused` : ''}${a.lastRequest ? ` · last ${esc(a.lastRequest)}` : ''}</div>
        <div class="resume-snippet">${a.enrolledAt ? `enrolled ${esc(fmtTime(a.enrolledAt))}` : a.tokenExpiresAt ? `token expires ${esc(fmtTime(a.tokenExpiresAt))}` : ''}</div>`;
      row.onclick = () => void showAgentLog(a.id);
      agentsEl.appendChild(row);
    }
  }
  void refreshAgents();
  void showFleetLog();
  // keep LIVE and last-interaction current while the dialog is open
  const agentTimer = window.setInterval(() => {
    if (!dialog.open) return window.clearInterval(agentTimer);
    void refreshAgents();
  }, 15_000);

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
    const target = statuses.find((s) => s?.fleetTarget)?.fleetTarget;
    targetEl.textContent = target
      ? `fleet target: build ${target.build} — UPDATE ALL by ${target.requestedBy}, ${new Date(target.requestedAt).toLocaleString()}. Machines that come back behind it update themselves.`
      : '';

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

  (dialog.querySelector('#ad-update-all') as HTMLButtonElement).onclick = async () => {
    const btn = dialog.querySelector('#ad-update-all') as HTMLButtonElement;
    if (!confirm('Update every hub to the newest published build? Each hub restarts; live sessions come back as they were. Machines that are off update themselves when they return.')) return;
    btn.disabled = true;
    btn.textContent = 'UPDATING ALL…';
    try {
      const r = await api.adminUpdateAll();
      const builds = new Map(await Promise.all(machines.map(async (m) => [m, (await statusFor(m))?.build ?? 0] as const)));
      for (const m of r.machines) if (m.told) watching.set(m.machine, builds.get(m.machine) ?? 0);
      targetEl.textContent =
        `fleet target: build ${r.target.build}. Told: ${r.machines.filter((m) => m.told).map((m) => m.machine).join(', ') || 'nobody (all up to date)'}` +
        (r.offline.length ? `. Offline, will update on return: ${r.offline.join(', ')}` : '') +
        (r.machines.some((m) => m.error) ? `. Problems: ${r.machines.filter((m) => m.error).map((m) => `${m.machine} (${m.error})`).join(', ')}` : '');
      void watchLoop();
    } catch (err) {
      targetEl.textContent = `UPDATE ALL failed: ${err instanceof Error ? err.message : err}`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'UPDATE ALL';
    }
  };

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
