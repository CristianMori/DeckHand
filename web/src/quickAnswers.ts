import { sendKeys } from './terminalView';

/** Canned keystrokes for triaging prompts without touching the terminal. */
const KEYS: [label: string, data: string, title: string][] = [
  ['ENTER', '\r', 'Accept / submit'],
  ['1', '1', 'Choose option 1'],
  ['2', '2', 'Choose option 2'],
  ['3', '3', 'Choose option 3'],
  ['↓', '\x1b[B', 'Arrow down'],
  ['ESC', '\x1b', 'Interrupt Claude'],
];

export function buildQuickBar(bar: HTMLElement) {
  bar.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'qa-label';
  label.textContent = 'QUICK';
  bar.appendChild(label);

  for (const [text, data, title] of KEYS) {
    const btn = document.createElement('button');
    btn.className = 'ghost-btn';
    btn.textContent = text;
    btn.title = title;
    btn.onclick = () => sendKeys(data);
    bar.appendChild(btn);
  }

  const input = document.createElement('input');
  input.placeholder = 'type a prompt and hit Enter to send it to this session…';
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && input.value) {
      sendKeys(input.value + '\r');
      input.value = '';
    }
  };
  bar.appendChild(input);
}
