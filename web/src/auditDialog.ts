import { api } from './api';

// AUDIT: who reached the fleet and what they did. Left, the public-gateway
// agents holding a token (live, last interaction); right, a log — one agent's
// requests, or every machine's provenance log — where any request id opens
// that request at every hop.

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

/**
 * The public-gateway agents holding a valid token (enrolled, or a token
 * minted and not expired), live or not, with their last interaction. Shared
 * by ADMIN and AUDIT; `onPick` runs when one is clicked.
 */
export async function renderGatewayAgents(el: HTMLElement, onPick: (id: string) => void): Promise<void> {
  const info = await api.gatewayAgents().catch(() => null);
  if (!info) {
    el.innerHTML = '<div class="empty-note">gateway machine not reachable</div>';
    return;
  }
  if (!info.present) {
    el.innerHTML = `<div class="empty-note">no gateway installed on ${esc(info.machine)}</div>`;
    return;
  }
  if (!info.agents.length) {
    el.innerHTML = '<div class="empty-note">no agent holds a valid token</div>';
    return;
  }
  el.innerHTML = '';
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
      <div class="resume-snippet">${esc(a.requests)} request${a.requests === 1 ? "" : "s"}${a.denied ? ` · ${esc(a.denied)} refused` : ''}${a.lastRequest ? ` · last ${esc(a.lastRequest)}` : ''}</div>
      <div class="resume-snippet">${a.enrolledAt ? `enrolled ${esc(fmtTime(a.enrolledAt))}` : a.tokenExpiresAt ? `token expires ${esc(fmtTime(a.tokenExpiresAt))}` : ''}</div>`;
    row.title = "show this agent's requests in AUDIT";
    row.onclick = () => onPick(a.id);
    el.appendChild(row);
  }
}

export async function openAuditDialog(opts: { agent?: string } = {}) {
  const dialog = document.getElementById('audit-dialog') as HTMLDialogElement;
  dialog.innerHTML = `
    <h2>AUDIT</h2>
    <div class="au-layout">
      <section>
        <div class="ad-col-title">GATEWAY AGENTS</div>
        <div class="resume-list" id="au-agents"><div class="empty-note">querying gateway…</div></div>
      </section>
      <section class="au-main">
        <div class="ad-log-head">
          <span class="ad-col-title" id="au-log-title">CROSS REQUESTS — ALL MACHINES</span>
          <input id="au-log-filter" placeholder="filter: session, caller, path, text, request id…" />
          <button class="ghost-btn" id="au-log-all">ALL REQUESTS</button>
        </div>
        <div class="ad-log" id="au-log"><div class="empty-note">loading…</div></div>
      </section>
    </div>
    <div class="dialog-actions">
      <button class="ghost-btn" id="au-close">CLOSE</button>
    </div>
  `;
  dialog.showModal();
  const agentsEl = dialog.querySelector('#au-agents') as HTMLElement;
  const logEl = dialog.querySelector('#au-log') as HTMLElement;
  const logTitle = dialog.querySelector('#au-log-title') as HTMLElement;
  const filterEl = dialog.querySelector('#au-log-filter') as HTMLInputElement;
  (dialog.querySelector('#au-close') as HTMLButtonElement).onclick = () => dialog.close();

  // ── log pane: one gateway agent's requests, or every machine's provenance log
  let logMode: { kind: 'fleet' } | { kind: 'agent'; id: string } = { kind: 'fleet' };
  let logSeq = 0;

  const wireTraceLinks = () =>
    logEl.querySelectorAll<HTMLAnchorElement>('.ad-trace').forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        void showFleetLog({ id: a.dataset.id });
      };
    });

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
    wireTraceLinks();
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
    wireTraceLinks();
  }

  let filterTimer: number | undefined;
  filterEl.oninput = () => {
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => void (logMode.kind === 'agent' ? showAgentLog(logMode.id) : showFleetLog()), 300);
  };
  (dialog.querySelector('#au-log-all') as HTMLButtonElement).onclick = () => void showFleetLog();

  // ── gateway agents column
  const refreshAgents = () => renderGatewayAgents(agentsEl, (id) => void showAgentLog(id));

  void refreshAgents();
  void (opts.agent ? showAgentLog(opts.agent) : showFleetLog());
  // keep LIVE and last-interaction current while the window is open
  const agentTimer = window.setInterval(() => {
    if (!dialog.open) return window.clearInterval(agentTimer);
    void refreshAgents();
  }, 15_000);
}
