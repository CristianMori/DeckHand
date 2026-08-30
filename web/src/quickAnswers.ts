import { api } from './api';
import { sendKeys, scrollActivePages, scrollSensitivity, setScrollSensitivity } from './terminalView';
import type { SessionInfo } from './types';

/**
 * Terminal control bar: paging, wheel sensitivity, printable transcript
 * export, and a one-line prompt box. (The old 1/2/3 quick-answer buttons
 * retired — auto-yes made them obsolete.)
 */
export function buildQuickBar(root: HTMLElement, getSelected: () => SessionInfo | null) {
  root.innerHTML = `
    <span class="qa-label">TERM</span>
    <button data-scroll="-1" title="Page up">⇈</button>
    <button data-scroll="-0.5" title="Half page up">↑</button>
    <button data-scroll="0.5" title="Half page down">↓</button>
    <button data-scroll="1" title="Page down">⇊</button>
    <select id="qb-sens" title="Mouse scroll sensitivity">
      <option value="0.5">SCROLL ×0.5</option>
      <option value="1">SCROLL ×1</option>
      <option value="2">SCROLL ×2</option>
      <option value="3">SCROLL ×3</option>
    </select>
    <span class="qa-sep"></span>
    <input id="qb-print-n" type="number" min="1" max="100" value="5" title="How many question/reply exchanges to include" />
    <button id="qb-print" title="Open a printable transcript of the last N exchanges">PRINT ⎙</button>
    <span class="qa-sep"></span>
    <button data-key="esc" class="danger" title="Escape">ESC</button>
    <input id="qb-prompt" placeholder="type a prompt and hit Enter to send it to this session…" />
  `;

  const KEYS: Record<string, string> = { esc: '' };
  root.querySelectorAll<HTMLButtonElement>('button[data-scroll]').forEach((b) => {
    b.onclick = () => scrollActivePages(parseFloat(b.dataset.scroll!));
  });
  root.querySelectorAll<HTMLButtonElement>('button[data-key]').forEach((b) => {
    b.onclick = () => sendKeys(KEYS[b.dataset.key!] ?? b.dataset.key!);
  });

  const sens = root.querySelector('#qb-sens') as HTMLSelectElement;
  sens.value = String(scrollSensitivity());
  if (![...sens.options].some((o) => o.value === sens.value)) sens.value = '1';
  sens.onchange = () => setScrollSensitivity(parseFloat(sens.value));

  (root.querySelector('#qb-print') as HTMLButtonElement).onclick = async () => {
    const s = getSelected();
    if (!s) return;
    const n = Math.max(1, Math.min(100, Number((root.querySelector('#qb-print-n') as HTMLInputElement).value) || 5));
    let base = '';
    if (s.machine) {
      // the export is served by the hub that owns the session
      const fleet = await api.fleet().catch(() => []);
      const m = fleet.find((f) => f.machine === s.machine);
      if (m && !m.self && m.url) base = m.url;
    }
    window.open(`${base}/api/sessions/${s.hubId}/export?replies=${n}`, '_blank');
  };

  const prompt = root.querySelector('#qb-prompt') as HTMLInputElement;
  prompt.onkeydown = (e) => {
    if (e.key === 'Enter' && prompt.value) {
      sendKeys(prompt.value);
      setTimeout(() => sendKeys('\r'), 60);
      prompt.value = '';
    }
  };
}
