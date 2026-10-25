import { api } from './api';
import type { AccessGrant } from './types';

// TRUST: what each outside agent may reach in Deckhand. Grants are enforced
// by the hub (server/agentAccess.ts); enrolling an agent in Mimir grants
// nothing. Only this panel writes them.

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const tagValue = (tags: string, key: string) =>
  tags.split(/\s+/).find((t) => t.replace(/^#/, '').toLowerCase().startsWith(`${key}:`))?.replace(/^#/, '').slice(key.length + 1);

function whereOf(g: AccessGrant, names: Map<string, string>): string {
  const parts: string[] = [];
  if (g.folders === '*') parts.push('every folder');
  else if (g.folders.length) parts.push(g.folders.join(', '));
  if (g.sessions.length) parts.push(`session ${g.sessions.map((s) => names.get(s) ?? s.slice(0, 8)).join(', ')}`);
  return parts.join(' + ');
}

export async function renderTrustPanel(el: HTMLElement): Promise<void> {
  const [trust, mimir, folders, sessions] = await Promise.all([
    api.trust().catch(() => null),
    api.mimirAgents().catch(() => null),
    api.fleetFolders().catch(() => []),
    api.sessions().catch(() => []),
  ]);
  if (!trust) {
    el.innerHTML = '<div class="empty-note">grants unavailable on this hub</div>';
    return;
  }
  const agentSessions = sessions.filter((s) => s.agentType === 'claude' || s.agentType === 'codex');
  const names = new Map(sessions.map((s) => [s.claudeSessionId, s.name]));
  const agents = [...new Set([...(mimir?.agents ?? []).map((a) => a.id.toLowerCase()), ...trust.grants.map((g) => g.agent)])].sort();

  el.innerHTML = `
    <div class="tr-note">Enrolling in Mimir grants nothing. An agent sees, reads or prompts only what is granted here — checked by the hub, before any session sees the request.</div>
    <div class="tr-list" id="tr-list"></div>
    <div class="tr-legacy" id="tr-legacy"></div>
    <div class="tr-form">
      <input id="tr-agent" list="tr-agents" placeholder="agent" />
      <datalist id="tr-agents">${agents.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
      <select id="tr-access">
        <option value="interact">interact (read + prompt)</option>
        <option value="observe">observe (read only)</option>
        <option value="discover">discover (listed only)</option>
      </select>
      <select id="tr-where">
        <option value="*">every folder</option>
        <optgroup label="folder">${folders.map((f) => `<option value="f:${esc(f.folder)}">${esc(f.folder)}</option>`).join('')}</optgroup>
        <optgroup label="one session">${agentSessions
          .map((s) => `<option value="s:${esc(s.claudeSessionId)}">${esc(s.name)} · ${esc(s.machine ?? '')}</option>`)
          .join('')}</optgroup>
      </select>
      <button class="primary-btn" id="tr-grant">GRANT</button>
    </div>
    <div class="tr-error" id="tr-error"></div>`;

  const errEl = el.querySelector('#tr-error') as HTMLElement;
  const fail = (err: unknown) => (errEl.textContent = String(err instanceof Error ? err.message : err));
  const rerender = () => void renderTrustPanel(el);

  const list = el.querySelector('#tr-list') as HTMLElement;
  if (!trust.grants.length) list.innerHTML = '<div class="empty-note">no grants: no outside agent can reach any session</div>';
  for (const g of trust.grants) {
    const row = document.createElement('div');
    row.className = 'tr-row';
    row.innerHTML = `<span class="resume-proj">${esc(g.agent)}</span><span class="chip ${g.access === 'interact' ? 'waiting' : 'idle'}">${esc(g.access.toUpperCase())}</span><span class="tr-where">${esc(whereOf(g, names))}</span><button class="ghost-btn danger">REVOKE</button>`;
    row.title = g.fact;
    (row.querySelector('button') as HTMLButtonElement).onclick = async () => {
      if (!confirm(`Revoke: ${g.agent} ${g.access} on ${whereOf(g, names)}?`)) return;
      await api.trustRevoke(g.id).then(rerender, fail);
    };
    list.appendChild(row);
  }

  // trust entries from before grants existed: plain memories, not enforced — one click turns them into grants
  const legacyEl = el.querySelector('#tr-legacy') as HTMLElement;
  for (const m of trust.legacy) {
    const agent = tagValue(m.tags, 'client');
    const f = tagValue(m.tags, 'folders');
    const row = document.createElement('div');
    row.className = 'tr-row tr-old';
    row.innerHTML = `<span class="tr-where">old memory (not enforced): ${esc(m.fact)}</span>`;
    if (agent && f) {
      const btn = document.createElement('button');
      btn.className = 'ghost-btn';
      btn.textContent = `GRANT ${agent.toUpperCase()} INTERACT ON ${f === '*' ? 'EVERYTHING' : f.toUpperCase()}`;
      btn.onclick = () =>
        api
          .trustGrant({ agent, access: 'interact', folders: f === '*' ? '*' : f.split(','), replaces: m.id })
          .then(rerender, fail);
      row.appendChild(btn);
    }
    legacyEl.appendChild(row);
  }

  (el.querySelector('#tr-grant') as HTMLButtonElement).onclick = async () => {
    const agent = (el.querySelector('#tr-agent') as HTMLInputElement).value.trim();
    const access = (el.querySelector('#tr-access') as HTMLSelectElement).value as AccessGrant['access'];
    const where = (el.querySelector('#tr-where') as HTMLSelectElement).value;
    if (!agent) return fail('which agent?');
    const body =
      where === '*'
        ? { agent, access, folders: '*' as const }
        : where.startsWith('f:')
          ? { agent, access, folders: [where.slice(2)] }
          : { agent, access, sessions: [where.slice(2)] };
    await api.trustGrant(body).then(rerender, fail);
  };
}
