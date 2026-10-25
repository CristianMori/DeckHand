import { api } from './api';

// AUDIT: who reached the fleet and what they did. Left, the outside agents
// (they live in Mimir, RAVEN's broker, with its own gateway); right, every
// machine's provenance log, where any request id opens that request at every
// hop and an agent's name filters to what it did in Deckhand.

/** Mimir's own page: agents, access requests (accept / reject), its trail */
export const MIMIR_ADMIN_URL = 'http://desktop-master:5102/admin/agents';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function fmtWhen(iso?: string | null): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  const ago = Math.round((Date.now() - t) / 1000);
  const rel = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.floor(ago / 60)}m ago` : ago < 86400 ? `${Math.floor(ago / 3600)}h ago` : `${Math.floor(ago / 86400)}d ago`;
  return `${new Date(t).toLocaleString()} (${rel})`;
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString();
// Mimir's times may come without a Z suffix: they are UTC
const utc = (t?: string | null) => (t ? fmtWhen(/Z$|[+-]\d\d:\d\d$/.test(t) ? t : `${t}Z`) : 'never');

/**
 * The outside agents as Mimir sees them: enrolled ones (live, last
 * interaction, open tasks, messages) and pending access requests, which are
 * accepted on Mimir's page. Shared by ADMIN and AUDIT; `onPick` runs when an
 * agent is clicked.
 */
export async function renderGatewayAgents(el: HTMLElement, onPick: (id: string) => void): Promise<void> {
  const mimir = await api.mimirAgents().catch(() => null);
  if (!mimir) {
    el.innerHTML = '<div class="empty-note">Mimir is not reachable</div>';
    return;
  }
  const requests = (mimir.requests ?? []).filter((r) => r.status === 'requested' || r.status === 'accepted');
  if (!mimir.agents.length && !requests.length) {
    el.innerHTML = `<div class="empty-note">no outside agent enrolled · <a href="${MIMIR_ADMIN_URL}" target="_blank" rel="noopener">Mimir</a></div>`;
    return;
  }
  el.innerHTML = '';
  for (const r of requests) {
    // the user decides on Mimir's page; accepting only lets the agent enroll
    const row = document.createElement('div');
    row.className = 'resume-row admin-row';
    row.innerHTML = `
      <div class="resume-row-top"><span class="resume-proj">${esc(r.agent)}</span>${
        r.status === 'requested' ? '<span class="chip waiting">PENDING ACCEPTANCE</span>' : '<span class="chip idle">ACCEPTED</span>'
      }</div>
      <div class="resume-snippet">${esc(r.name ?? '')}${r.note ? ` — “${esc(r.note)}”` : ''}</div>
      <div class="resume-snippet">asked ${esc(fmtWhen(r.at))}${r.ip ? ` from ${esc(r.ip)}` : ''}</div>
      <div class="resume-snippet"><a href="${MIMIR_ADMIN_URL}" target="_blank" rel="noopener">accept or reject on Mimir's page</a></div>`;
    el.appendChild(row);
  }
  for (const a of mimir.agents) {
    const row = document.createElement('div');
    row.className = 'resume-row admin-row';
    const chip = a.live
      ? '<span class="chip working">LIVE</span>'
      : a.status === 'enrolled'
        ? '<span class="chip idle">ENROLLED</span>'
        : `<span class="chip waiting">${esc(String(a.status ?? '').toUpperCase())}</span>`;
    row.innerHTML = `
      <div class="resume-row-top"><span class="resume-proj">${esc(a.id)}</span>${chip}</div>
      <div class="resume-snippet">last interaction: ${esc(utc(a.lastSeen))}</div>
      <div class="resume-snippet">${a.openTasks ? `<b>${esc(a.openTasks)} open task${a.openTasks === 1 ? '' : 's'}</b>` : 'no open tasks'} · last Deckhand call ${esc(utc(a.lastDeckhandCallAtUtc))}</div>
      <div class="resume-snippet">messages in ${esc(utc(a.lastMessageInAtUtc))} · out ${esc(utc(a.lastMessageOutAtUtc))} · ${a.webhook ? 'webhook set' : 'no webhook (inbox only)'}${a.inbox ? ` · <b>${esc(a.inbox)} in inbox</b>` : ''}</div>
      <div class="resume-snippet">${a.enrolledAt ? `enrolled ${esc(fmtTime(a.enrolledAt))}` : ''}</div>`;
    row.title = 'show what this agent did in Deckhand (AUDIT)';
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
        <div class="ad-col-title">OUTSIDE AGENTS (MIMIR)</div>
        <div class="resume-list" id="au-agents"><div class="empty-note">asking Mimir…</div></div>
        <div class="resume-snippet"><a href="${MIMIR_ADMIN_URL}" target="_blank" rel="noopener">Mimir's trail: tasks, messages, every hop</a></div>
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

  let logSeq = 0;
  const wireTraceLinks = () =>
    logEl.querySelectorAll<HTMLAnchorElement>('.ad-trace').forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        void showFleetLog({ id: a.dataset.id });
      };
    });

  async function showFleetLog(o: { id?: string; title?: string } = {}) {
    const seq = ++logSeq;
    logTitle.textContent = o.title ?? (o.id ? `REQUEST ${o.id.slice(0, 8)} — EVERY HOP` : 'CROSS REQUESTS — ALL MACHINES');
    const fleet = await api.fleet().catch(() => []);
    const machines = fleet.filter((m) => m.connected).map((m) => m.machine);
    const q = filterEl.value.trim();
    const results = await Promise.all(machines.map((m) => api.provenance(m, { q: q || undefined, id: o.id, limit: 300 }).catch(() => [])));
    if (seq !== logSeq) return;
    const rows = results.flat().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 500);
    if (!rows.length) {
      logEl.innerHTML = '<div class="empty-note">nothing logged</div>';
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

  /** What an agent did in Deckhand: Mimir's calls on its behalf carry caller gateway:<agent>. */
  const showAgent = (id: string) => {
    filterEl.value = `gateway:${id}`;
    void showFleetLog({ title: `AGENT ${id.toUpperCase()} — WHAT IT DID IN DECKHAND` });
  };

  let filterTimer: number | undefined;
  filterEl.oninput = () => {
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => void showFleetLog(), 300);
  };
  (dialog.querySelector('#au-log-all') as HTMLButtonElement).onclick = () => {
    filterEl.value = '';
    void showFleetLog();
  };

  const refreshAgents = () => renderGatewayAgents(agentsEl, showAgent);
  void refreshAgents();
  if (opts.agent) showAgent(opts.agent);
  else void showFleetLog();
  // keep LIVE and last-interaction current while the window is open
  const agentTimer = window.setInterval(() => {
    if (!dialog.open) return window.clearInterval(agentTimer);
    void refreshAgents();
  }, 15_000);
}
