#!/usr/bin/env node
// deckhand — run Claude Code sessions the hub owns, from a real terminal.
//
//   deckhand                 spawn a session in the current directory, attach
//   deckhand attach <name>   attach to a running session (any fleet machine)
//   deckhand ls              list fleet sessions
//
// Detach with Ctrl+Q — the session keeps running; reattach from anywhere,
// including the web dashboard. Closing the window never kills the session.

import WebSocket from 'ws';
import { basename } from 'node:path';

const DETACH = 0x11; // Ctrl+Q

async function findHub() {
  if (process.env.HUB_URL) return process.env.HUB_URL;
  for (let port = 5959; port <= 5969; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/hub-info`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        const info = await res.json();
        if (info.hub === 'deckhand' || info.hub === 'claude-hub') return `http://127.0.0.1:${port}`;
      }
    } catch {
      /* next port */
    }
  }
  return null;
}

function die(msg) {
  console.error(`deckhand: ${msg}`);
  process.exit(1);
}

async function api(hub, path, init) {
  const res = await fetch(`${hub}${path}`, init);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

function attach(hub, session) {
  const wsUrl = hub.replace(/^http/, 'ws') + `/ws/term/${session.hubId}`;
  const ws = new WebSocket(wsUrl);
  let initialized = false;
  let refreshTimer = null;

  const cleanup = (msg) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write('\x1b[?25h\n'); // cursor back
    if (msg) console.log(msg);
    process.exit(0);
  };

  ws.on('open', () => {
    process.stdout.write('\x1b[2J\x1b[H'); // clear before snapshot lands
    ws.send(JSON.stringify({ t: 'resize', c: process.stdout.columns, r: process.stdout.rows }));
    ws.send(JSON.stringify({ t: 'refresh' }));
  });

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.t === 'init') {
          process.stdout.write('\x1b[2J\x1b[H');
          if (msg.snapshot) process.stdout.write(msg.snapshot);
          initialized = true;
        }
      } catch {
        /* ignore */
      }
      return;
    }
    if (initialized) process.stdout.write(data);
  });

  ws.on('close', () => cleanup('[deckhand] session ended or connection lost.'));
  ws.on('error', (e) => cleanup(`[deckhand] connection error: ${e.message}`));

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (buf) => {
    if (buf.length === 1 && buf[0] === DETACH) {
      ws.close();
      cleanup(
        `[deckhand] detached — session keeps running. Reattach: deckhand attach ${session.name}`,
      );
      return;
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', d: buf.toString('utf8') }));
  });

  process.stdout.on('resize', () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: 'resize', c: process.stdout.columns, r: process.stdout.rows }));
    // ConPTY repaints misalign after resize — pull a clean snapshot once settled
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'refresh' }));
    }, 450);
  });
}

const hub = await findHub();
if (!hub) die('no hub found on 127.0.0.1:5959-5969 — is Deckhand running? (npm run start)');

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'ls') {
  const sessions = await api(hub, '/api/sessions');
  if (sessions.length === 0) console.log('no sessions');
  for (const s of sessions) {
    console.log(
      `${s.hubId}  ${(s.name ?? '').padEnd(20)} ${(s.machine ?? '?').padEnd(16)} ${s.state}${s.unreachable ? ' (unreachable)' : ''}`,
    );
  }
  // let the fetch pool settle before exiting — process.exit() here races libuv
  setTimeout(() => process.exit(0), 150);
} else if (cmd === 'attach') {
  if (!arg) die('usage: deckhand attach <name|hubId>');
  const sessions = await api(hub, '/api/sessions');
  const matches = sessions.filter(
    (s) =>
      !s.unreachable &&
      s.state !== 'EXITED' &&
      (s.hubId === arg || s.hubId.startsWith(arg) || s.name.toLowerCase() === arg.toLowerCase()),
  );
  if (matches.length === 0) die(`no live session matching "${arg}" (try: deckhand ls)`);
  if (matches.length > 1) die(`ambiguous: ${matches.map((s) => `${s.hubId}(${s.name})`).join(', ')}`);
  const s = matches[0];
  console.log(`[deckhand] attaching to ${s.name} @ ${s.machine ?? 'local'} — Ctrl+Q to detach`);
  attach(hub, s);
} else if (cmd === undefined) {
  const cwd = process.cwd();
  const session = await api(hub, '/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, name: basename(cwd) }),
  });
  console.log(`[deckhand] session ${session.hubId} started — Ctrl+Q detaches, session survives`);
  attach(hub, session);
} else {
  die(`unknown command "${cmd}" — usage: deckhand [ls | attach <name>]`);
}
