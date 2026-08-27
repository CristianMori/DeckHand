import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { api } from './api';

interface TermConn {
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket;
  container: HTMLDivElement;
  refreshTimer?: number;
}

const conns = new Map<string, TermConn>();
let activeHubId: string | null = null;
let resizeTimer: number | undefined;

const host = () => document.getElementById('terminal-host') as HTMLDivElement;

// xterm measures glyph widths at open(); if the webfont isn't loaded yet it
// measures the fallback font and everything renders garbled.
const fontsReady = Promise.all([
  document.fonts.load("13px 'IBM Plex Mono'"),
  document.fonts.load("bold 13px 'IBM Plex Mono'"),
]).catch(() => {});

// Clipboard API needs a secure context — dashboards are plain http on the
// tailnet, so fall back to the hidden-textarea trick which works anywhere.
// MUST be called synchronously inside a user-gesture handler (mouseup,
// keydown, contextmenu). execCommand goes FIRST: it is synchronous and
// gesture-scoped, and works on http and localhost alike. The async
// Clipboard API is only a fallback — observed to hang indefinitely on
// these dashboards — and is raced against a timeout so it can never
// strand the flash.
function clipboardWrite(text: string) {
  if (legacyCopy(text)) {
    showCopyFlash(true);
    return;
  }
  if (navigator.clipboard?.writeText) {
    void Promise.race([
      navigator.clipboard.writeText(text).then(() => true, () => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 1500)),
    ]).then((ok) => showCopyFlash(ok));
  } else {
    showCopyFlash(false);
  }
}

// the flash reports the REAL outcome — a lying success indicator is worse
// than none
let flashEl: HTMLDivElement | null = null;
let flashTimer: number | undefined;
function showCopyFlash(ok: boolean) {
  if (!flashEl) {
    flashEl = document.createElement('div');
    document.body.appendChild(flashEl);
  }
  flashEl.className = `copy-flash show${ok ? '' : ' fail'}`;
  flashEl.textContent = ok ? 'copied ✓' : 'copy failed';
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => flashEl?.classList.remove('show'), 900);
}

function legacyCopy(text: string): boolean {
  const refocus = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    ta.remove();
    refocus?.focus?.(); // don't strand keyboard focus on a removed textarea
  }
  return ok;
}

function wsUrl(hubId: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws/term/${hubId}`;
}

function connect(hubId: string): TermConn {
  const container = document.createElement('div');
  container.style.height = '100%';

  const term = new Terminal({
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 13,
    scrollback: 8000,
    allowProposedApi: true,
    theme: {
      background: '#0c100e',
      foreground: '#cfe0d8',
      cursor: '#ffb454',
      selectionBackground: '#2c3b34',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';

  // Never surrender the mouse BUTTONS to the TUI. Claude requests
  // mouse-reporting and then does its own select/copy/paste against the
  // clipboard of the machine it runs on — a hidden session nobody can see.
  // Consuming the requests keeps every drag a local browser selection.
  // But Claude still believes reporting is on — so wheel events are
  // hand-forged below and sent as SGR reports, giving native TUI scrolling
  // without giving up the buttons.
  let tuiWantsMouse = false;
  const MOUSE_EVENT_MODES = new Set([9, 1000, 1002, 1003]);
  const MOUSE_ENC_MODES = new Set([1005, 1006, 1015, 1016]);
  const swallowMouseMode = (params: ArrayLike<number>, enabled: boolean) => {
    if (params.length !== 1) return false;
    const mode = params[0];
    if (MOUSE_EVENT_MODES.has(mode)) {
      tuiWantsMouse = enabled;
      return true;
    }
    return MOUSE_ENC_MODES.has(mode);
  };
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (p) => swallowMouseMode(p as never, true));
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (p) => swallowMouseMode(p as never, false));

  container.addEventListener(
    'wheel',
    (e) => {
      if (!tuiWantsMouse || !term.element || ws.readyState !== WebSocket.OPEN) return;
      // stop xterm's wheel→arrow-key fallback (arrows navigate input history)
      e.preventDefault();
      e.stopPropagation();
      const rect = term.element.getBoundingClientRect();
      const col = Math.min(term.cols, Math.max(1, Math.ceil((e.clientX - rect.left) / (rect.width / term.cols))));
      const row = Math.min(term.rows, Math.max(1, Math.ceil((e.clientY - rect.top) / (rect.height / term.rows))));
      const btn = e.deltaY < 0 ? 64 : 65;
      const ticks = Math.min(3, Math.max(1, Math.round(Math.abs(e.deltaY) / 60)));
      let seq = '';
      for (let i = 0; i < ticks; i++) seq += `\x1b[<${btn};${col};${row}M`;
      ws.send(JSON.stringify({ t: 'in', d: seq }));
    },
    { passive: false, capture: true },
  );

  const ws = new WebSocket(wsUrl(hubId));
  ws.binaryType = 'arraybuffer';
  const decoder = new TextDecoder();
  let initialized = false;

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      // control frame: init snapshot at the server's current PTY dimensions
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'init') {
          term.resize(msg.cols, msg.rows);
          term.reset();
          if (msg.snapshot) term.write(msg.snapshot);
          initialized = true;
          // now adapt the PTY to *our* viewport; the TUI repaints on resize
          requestAnimationFrame(() => {
            if (term.element) fit.fit();
          });
        }
      } catch {
        /* ignore */
      }
      return;
    }
    if (initialized) term.write(decoder.decode(ev.data));
  };
  ws.onclose = () => {
    conns.delete(hubId);
    if (activeHubId === hubId) {
      // stale socket (e.g. session resumed under same hubId) — reattach fresh
      const id = hubId;
      activeHubId = null;
      setTimeout(() => showTerminal(id), 300);
    }
  };

  const conn: TermConn = { term, fit, ws, container };

  // ── clipboard ──
  // select = copy (PuTTY-style); Ctrl+C copies when a selection exists and is
  // the interrupt key otherwise; Ctrl+Shift+C explicit copy; right-click
  // copies the selection. Paste stays native Ctrl+V (works on http), with
  // Ctrl+Shift+V going through the async Clipboard API where available.
  // copy-on-select must happen synchronously in the mouseup handler — a
  // debounced timeout falls outside the user gesture and execCommand refuses
  container.addEventListener('mouseup', () => {
    if (term.hasSelection()) clipboardWrite(term.getSelection());
  });
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const key = ev.key.toLowerCase();
    if (ev.ctrlKey && key === 'c' && (ev.shiftKey || term.hasSelection())) {
      const sel = term.getSelection();
      if (sel) clipboardWrite(sel);
      term.clearSelection();
      ev.preventDefault();
      return false;
    }
    if (ev.ctrlKey && key === 'v') {
      // returning false WITHOUT preventDefault: xterm must not send ^V to the
      // PTY (Claude's TUI binds it to pasting its own host-side clipboard),
      // but the browser default proceeds — a native paste event lands in
      // xterm's textarea and the OS clipboard text flows to the session.
      return false;
    }
    return true;
  });
  // Right-clicks must never reach xterm: in mouse-reporting mode it forwards
  // them to Claude's TUI, which insta-pastes its host-side clipboard — and
  // xterm also clears the local selection. Capture-stop the event, snapshot
  // the selection, and let only the browser's own context menu happen (its
  // Paste inserts the OS clipboard via the focused textarea).
  let rightClickSel = '';
  container.addEventListener(
    'mousedown',
    (e) => {
      if (e.button === 2) {
        rightClickSel = term.getSelection();
        e.stopPropagation();
      }
    },
    true,
  );
  container.addEventListener(
    'mouseup',
    (e) => {
      if (e.button === 2) e.stopPropagation();
    },
    true,
  );
  container.addEventListener('contextmenu', (e) => {
    const sel = term.hasSelection() ? term.getSelection() : rightClickSel;
    rightClickSel = '';
    if (sel) {
      e.preventDefault();
      clipboardWrite(sel);
      term.clearSelection();
    }
  });

  // ── touch scrolling ──
  // xterm's canvas ignores touch pans (unscrollable on phones); translate
  // vertical drags into buffer scrolls ourselves.
  let touchY: number | null = null;
  container.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 1) touchY = e.touches[0].clientY;
    },
    { passive: true },
  );
  container.addEventListener(
    'touchmove',
    (e) => {
      if (touchY === null || e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - touchY;
      const cell = term.element ? term.element.clientHeight / term.rows : 17;
      const lines = Math.trunc(dy / cell);
      if (lines !== 0) {
        if (tuiWantsMouse && ws.readyState === WebSocket.OPEN) {
          // full-screen TUI: no scrollback to scroll — forge wheel reports
          const btn = lines > 0 ? 64 : 65;
          let seq = '';
          for (let i = 0; i < Math.min(4, Math.abs(lines)); i++) seq += `\x1b[<${btn};1;1M`;
          ws.send(JSON.stringify({ t: 'in', d: seq }));
        } else {
          term.scrollLines(-lines);
        }
        touchY += lines * cell;
        e.preventDefault();
      }
    },
    { passive: false },
  );
  container.addEventListener('touchend', () => {
    touchY = null;
  });

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', d: data }));
  });
  term.onResize(({ cols, rows }) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: 'resize', c: cols, r: rows }));
    // ConPTY's incremental repaint after a resize misaligns lines; once the
    // resize settles, pull a clean snapshot from the server-side mirror.
    clearTimeout(conn.refreshTimer);
    conn.refreshTimer = window.setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'refresh' }));
    }, 450);
  });

  conns.set(hubId, conn);
  return conn;
}

export function showTerminal(hubId: string) {
  if (activeHubId === hubId) return;
  activeHubId = hubId;
  const h = host();
  h.innerHTML = '';
  let conn = conns.get(hubId);
  if (!conn || conn.ws.readyState > WebSocket.OPEN) {
    conn?.term.dispose();
    conns.delete(hubId);
    conn = connect(hubId);
  }
  const c = conn;
  h.appendChild(c.container);
  fontsReady.then(() => {
    if (activeHubId !== hubId) return;
    if (!c.term.element) {
      c.term.open(c.container);
      try {
        c.term.loadAddon(new WebglAddon());
      } catch {
        /* WebGL unavailable — DOM renderer is fine */
      }
    }
    requestAnimationFrame(() => {
      c.fit.fit();
      c.term.focus();
    });
  });
}

export function hideTerminal() {
  activeHubId = null;
  host().innerHTML = '';
}

export function activeTerminal(): string | null {
  return activeHubId;
}

export function sendKeys(data: string) {
  if (!activeHubId) return;
  const conn = conns.get(activeHubId);
  if (conn?.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify({ t: 'in', d: data }));
    conn.term.focus();
  }
}

export function dropTerminal(hubId: string) {
  const conn = conns.get(hubId);
  if (conn) {
    conn.ws.close();
    conn.term.dispose();
    conns.delete(hubId);
  }
  if (activeHubId === hubId) activeHubId = null;
}

// ── drag & drop ──
// Browsers hide a dropped file's real path, so the file is uploaded to the hub
// (saved under data\drops\<session>) and the saved path is typed into the prompt.
const panel = document.getElementById('terminal-panel')!;
let dragDepth = 0;

// a drop outside the panel must not navigate the page away from the hub
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

panel.addEventListener('dragenter', (e) => {
  if (!activeHubId) return;
  e.preventDefault();
  dragDepth++;
  panel.classList.add('drop-target');
});
panel.addEventListener('dragover', (e) => {
  if (!activeHubId) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
});
panel.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    panel.classList.remove('drop-target');
  }
});
panel.addEventListener('drop', async (e) => {
  dragDepth = 0;
  panel.classList.remove('drop-target');
  if (!activeHubId) return;
  e.preventDefault();
  const hubId = activeHubId;
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length === 0) {
    // dragged text/URL — just type it
    const text = e.dataTransfer?.getData('text/plain');
    if (text) sendKeys(text);
    return;
  }
  for (const file of files) {
    try {
      const { path } = await api.dropFile(hubId, file);
      if (activeHubId === hubId) sendKeys(`"${path}" `);
    } catch (err) {
      console.error('[drop] upload failed', err);
    }
  }
});

// Watch the terminal panel itself (catches window resizes AND layout changes
// like the quick-bar appearing). fit() only fires term.onResize when the
// cols/rows actually change, and that handler does the PTY resize + re-sync.
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (!activeHubId) return;
    const conn = conns.get(activeHubId);
    const h = host();
    if (conn?.term.element && h.offsetWidth > 0 && h.offsetHeight > 0) conn.fit.fit();
  }, 200);
}).observe(host());
