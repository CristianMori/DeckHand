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
