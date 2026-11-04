import { api } from './api';
import type { RoleCharter, SessionInfo } from './types';

// ROLES: specialist role charters (server/roleCharters.ts). Built-ins ship
// with Deckhand and are never touched here; this panel edits the fleet layer,
// which lives on the authority hub and replicates everywhere. "Revert to
// built-in" deletes the fleet file. RUN starts one role now against a chosen
// lead session's HEAD (the trigger side's /run-role route).

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const platformsOf = (c: RoleCharter) => (Array.isArray(c.platforms) ? c.platforms.join(', ') : c.platforms);

function skipOf(c: RoleCharter): string {
  const parts: string[] = [];
  if (c.skip.underLines) parts.push(`diffs under ${c.skip.underLines} lines`);
  if (c.skip.docsOnly) parts.push('docs-only merges');
  return parts.length ? `skips ${parts.join(' and ')}` : '';
}

export async function renderRolesPanel(el: HTMLElement): Promise<void> {
  const [roles, sessions] = await Promise.all([api.roles().catch(() => null), api.sessions().catch(() => [] as SessionInfo[])]);
  if (!roles) {
    el.innerHTML = '<div class="empty-note">role charters unavailable on this hub</div>';
    return;
  }
  const leads = sessions.filter((s) => s.alive && (s.role === 'architect' || s.role === 'subarchitect'));
  const leadOptions = leads
    .map((s) => `<option value="${esc(s.hubId)}">${esc(s.name)} · ${esc(s.machine ?? '')}${s.role === 'subarchitect' ? ' (sub)' : ''}</option>`)
    .join('');

  el.innerHTML = `
    <div class="tr-note">A role is a charter: what it checks, how it reports. Instances run after a merge, report only and never fix. Built-ins ship with Deckhand; what you save here is the fleet layer, synced to every hub — revert deletes it. A project can still override per role in docs/architect/roles/.</div>
    <div id="ro-list"></div>
    <div class="ro-new">
      <div class="ad-col-title">NEW ROLE</div>
      <div class="tr-form">
        <input id="ro-new-name" placeholder="name (a-z, 0-9, dashes)" />
        <button class="primary-btn" id="ro-new-btn">CREATE</button>
      </div>
      <textarea id="ro-new-text" class="ro-text" rows="6" placeholder="---&#10;title: My role&#10;on: merge&#10;platforms: any&#10;---&#10;What to check, how to report."></textarea>
    </div>
    <div class="tr-error" id="ro-error"></div>`;

  const errEl = el.querySelector('#ro-error') as HTMLElement;
  const fail = (err: unknown) => (errEl.textContent = String(err instanceof Error ? err.message : err));
  const note = (text: string) => (errEl.textContent = text);
  const rerender = () => void renderRolesPanel(el);

  const list = el.querySelector('#ro-list') as HTMLElement;
  if (!roles.roles.length) list.innerHTML = '<div class="empty-note">no role charters on this hub</div>';
  for (const role of roles.roles) {
    const fleetText = roles.fleet[role.name] ?? '';
    const facts = [
      `on ${role.on}`,
      `platforms ${platformsOf(role)}`,
      role.model ? `model ${role.model}` : '',
      role.paths.length ? `paths ${role.paths.join(' ')}` : 'every merge',
      skipOf(role),
    ].filter(Boolean);
    const row = document.createElement('div');
    row.className = 'ro-role';
    row.innerHTML = `
      <div class="ro-head">
        <span class="resume-proj">${esc(role.title)}</span>
        <span class="ro-name">${esc(role.name)}</span>
        <span class="chip ${role.enabled ? 'idle' : 'exited'}">${role.enabled ? 'ENABLED' : 'DISABLED'}</span>
        ${role.layers.map((l) => `<span class="chip starting">${esc(l.toUpperCase())}</span>`).join('')}
      </div>
      <div class="ro-facts">${esc(facts.join(' · '))}</div>
      <textarea class="ro-text" rows="6" placeholder="fleet-layer override: front matter and/or body (empty = built-in only)"></textarea>
      <div class="ro-actions">
        <button class="primary-btn ro-save">SAVE</button>
        ${role.name in roles.fleet ? '<button class="ghost-btn danger ro-revert">REVERT TO BUILT-IN</button>' : ''}
        <span class="ro-run">
          <select class="ro-lead">${leadOptions || '<option value="">no live architect</option>'}</select>
          <button class="ghost-btn ro-run-btn" ${leads.length ? '' : 'disabled'}>RUN NOW</button>
        </span>
      </div>`;
    const text = row.querySelector('textarea') as HTMLTextAreaElement;
    text.value = fleetText;
    (row.querySelector('.ro-save') as HTMLButtonElement).onclick = () => {
      if (!text.value.trim()) return fail('nothing to save — use REVERT TO BUILT-IN to drop the fleet layer');
      api.roleSave(role.name, text.value).then(rerender, fail);
    };
    const revert = row.querySelector('.ro-revert') as HTMLButtonElement | null;
    if (revert) {
      revert.onclick = () => {
        if (!confirm(`Drop the fleet-layer charter for ${role.name} on every hub? The built-in stays.`)) return;
        api.roleRevert(role.name).then(rerender, fail);
      };
    }
    (row.querySelector('.ro-run-btn') as HTMLButtonElement).onclick = async () => {
      const hubId = (row.querySelector('.ro-lead') as HTMLSelectElement).value;
      if (!hubId) return fail('no live architect or sub-architect to run against');
      try {
        const out = await api.runRole(hubId, role.name);
        note(`${role.name}: ${typeof out === 'object' && out ? JSON.stringify(out) : String(out)}`);
      } catch (err) {
        fail(err);
      }
    };
    list.appendChild(row);
  }

  (el.querySelector('#ro-new-btn') as HTMLButtonElement).onclick = () => {
    const name = (el.querySelector('#ro-new-name') as HTMLInputElement).value.trim().toLowerCase();
    const text = (el.querySelector('#ro-new-text') as HTMLTextAreaElement).value;
    if (!name) return fail('which name? a slug of a-z, 0-9 and dashes');
    if (!text.trim()) return fail('a new role needs charter text');
    api.roleSave(name, text).then(rerender, fail);
  };
}
