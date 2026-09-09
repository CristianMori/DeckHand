import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { DATA_DIR, DEFAULT_PORT, HUB_ROOT, PROJECTS_ROOT, PUBLIC_DIR } from './config.js';
import { agentFor, getAgent, listAgents } from './agents/index.js';
import { SessionManager, type HubSession } from './sessionManager.js';
import { StatusEngine } from './statusEngine.js';
import { makeHookHandler } from './hooksReceiver.js';
import { startStatusFileWatcher } from './statusFileWatcher.js';
import { startSessionPusher } from './sessionPusher.js';
import { lastAssistantText } from './transcripts.js';
import { loadPersisted, savePersisted } from './persistence.js';
import { listRecentConversations } from './conversations.js';
import { Discovery } from './discovery.js';
import { Federation, type PeerAlert } from './federation.js';
import { createSyncManager, bootstrapSyncConfig, type SyncManager } from './syncthing.js';
import { loadVersionInfo } from './version.js';
import { Updater } from './updater.js';
import {
  STORE_MACHINE,
  TranscriptPusher,
  saveToStore,
  storeCatalog,
  storeFilePath,
  type StoreEntry,
} from './transcriptStore.js';
import { listLocalFolders, type FolderInfo } from './fleetFolders.js';
import { startFleetResume, getResumeJob } from './fleetResume.js';
import { startHandoff, getHandoffJob, receiveHandoff, type HandoffPayload } from './handoff.js';
import type { SessionInfo } from './types.js';

// a rejected promise in some background sweep must never take the hub down
process.on('unhandledRejection', (reason) => {
  console.error('[hub] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[hub] uncaughtException:', err);
});

const INSTANCE_ID = randomUUID();
const VERSION = loadVersionInfo();

const manager = new SessionManager();
const engine = new StatusEngine(manager);
const federation = new Federation();
const discovery = new Discovery(INSTANCE_ID, (hubs) => federation.setDiscovered(hubs));
let actualPort = DEFAULT_PORT; // updated when listen() settles (port walk)
const selfRef = {
  name: () => discovery.selfName,
  baseUrl: () => `http://127.0.0.1:${actualPort}`,
};
const updater = new Updater(VERSION, federation, selfRef);
new TranscriptPusher(federation, selfRef);

let sync: SyncManager | null = createSyncManager();
// machines without a data/sync.json learn the VPS endpoint from a fleet peer
const syncBootstrapTimer = setInterval(() => {
  if (sync) return clearInterval(syncBootstrapTimer);
  void bootstrapSyncConfig(async () => {
    for (const peer of federation.connectedPeers()) {
      try {
        const out = await federation.forward(peer, '/api/sync/config');
        const vps = (out.body as { vps?: { url: string; apiKey: string; deviceId: string } }).vps;
        if (out.status === 200 && vps?.url) return vps;
      } catch {
        /* try next peer */
      }
    }
    return null;
  }).then((m) => {
    if (m) sync = m;
  });
}, 60_000);
syncBootstrapTimer.unref();

for (const rec of loadPersisted()) manager.addExitedRecord(rec);

/** Local sessions tagged with this machine's name — the shape peers rely on. */
function localList(): SessionInfo[] {
  return manager.list().map((s) => ({ ...s, machine: discovery.selfName, origin: INSTANCE_ID }));
}

function mergedList(): SessionInfo[] {
  return federation.mergedSessions(localList());
}

/** Fleet machines (other than this one) with a live session in the named folder. */
function liveElsewhere(folderName: string): string[] {
  const machines = new Set<string>();
  const want = folderName.toLowerCase();
  for (const s of mergedList()) {
    if (!s.alive || s.unreachable || s.state === 'EXITED') continue;
    if (s.machine === discovery.selfName) continue;
    const base = s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase();
    if (base === want) machines.add(s.machine ?? 'unknown');
  }
  return [...machines];
}

/** 409 payload the UI turns into a confirmation prompt. */
function activeElsewhereError(res: express.Response, machines: string[]) {
  res.status(409).json({
    error: 'ACTIVE_ELSEWHERE',
    machines,
    message: `folder has a live session on: ${machines.join(', ')}`,
  });
}

// ---------------------------------------------------------------- HTTP API

const app = express();

// The hub listens on the tailnet, but only loopback, tailnet sources
// (100.64.0.0/10 v4, fd7a:115c:a1e0::/48 v6) and this machine's own addresses
// are trusted. Own addresses matter because Windows resolves the machine's own
// name to its LAN IP — browsing your own hub by name arrives from that IP.
let ownAddrs = new Set<string>();
let ownAddrsAt = 0;
function isOwnAddress(ip: string): boolean {
  const now = Date.now();
  if (now - ownAddrsAt > 30_000) {
    ownAddrs = new Set(
      Object.values(networkInterfaces())
        .flat()
        .filter((i): i is NonNullable<typeof i> => !!i)
        .map((i) => i.address.toLowerCase()),
    );
    ownAddrsAt = now;
  }
  return ownAddrs.has(ip.toLowerCase());
}

function isTrustedSource(addr: string | undefined): boolean {
  if (!addr) return false;
  const ip = addr.replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  const m = ip.match(/^100\.(\d+)\./);
  if (m) {
    const octet = Number(m[1]);
    return octet >= 64 && octet <= 127;
  }
  if (ip.toLowerCase().startsWith('fd7a:115c:a1e0')) return true;
  return isOwnAddress(ip);
}

app.use((req, res, next) => {
  if (!isTrustedSource(req.socket.remoteAddress)) return res.status(403).end();
  next();
});

// Fleet identity — what sibling hubs probe for during discovery.
app.get('/api/hub-info', (_req, res) => {
  res.json({
    // 'deckhand' is the wire identity; peers also accept the pre-rename value
    hub: 'deckhand',
    machine: discovery.selfName,
    instanceId: INSTANCE_ID,
    version: VERSION.version,
    build: VERSION.build,
  });
});

// Release channel: whichever machine holds files in data/releases serves the
// fleet (in practice vps-node — scripts/publish.ps1 uploads there).
app.use('/releases', express.static(join(DATA_DIR, 'releases')));

/** Forward an admin call to another machine's hub when ?machine= says so. */
function adminForward(req: express.Request, res: express.Response): boolean {
  const machine = typeof req.query.machine === 'string' ? req.query.machine : undefined;
  if (!machine || machine === discovery.selfName) return false;
  const peer = federation.peerByMachine(machine);
  if (!peer) {
    res.status(502).json({ error: `machine not connected: ${machine}` });
    return true;
  }
  federation
    .forward(peer, req.path, { method: req.method })
    .then((out) => res.status(out.status).json(out.body))
    .catch(() => res.status(502).json({ error: `forward to ${machine} failed` }));
  return true;
}

app.get('/api/admin/status', (req, res) => {
  if (adminForward(req, res)) return;
  res.json({
    machine: discovery.selfName,
    uptimeS: Math.round(process.uptime()),
    ...updater.status,
  });
});

app.post('/api/admin/check', async (req, res) => {
  if (adminForward(req, res)) return;
  res.json(await updater.check());
});

app.post('/api/admin/update', (req, res) => {
  if (adminForward(req, res)) return;
  updater.apply().catch((err) => {
    updater.status.updating = false;
    updater.status.error = err instanceof Error ? err.message : String(err);
    console.error('[updater] apply failed:', err);
  });
  res.json({ ok: true, note: 'updating — hub restarts itself when done' });
});

// remote debugging: tail this machine's launcher-captured log
app.get('/api/admin/log', (req, res) => {
  if (adminForward(req, res)) return;
  const lines = Math.min(500, Number(req.query.lines) || 100);
  const logPath = join(DATA_DIR, 'hub.log');
  if (!existsSync(logPath)) return res.status(404).json({ error: 'no hub.log on this machine' });
  const content = readFileSync(logPath, 'utf8');
  const tail = content.split(/\r?\n/).slice(-lines).join('\n');
  res.type('text/plain').send(tail);
});

app.post('/api/admin/restart', (req, res) => {
  if (adminForward(req, res)) return;
  res.json({ ok: true });
  setTimeout(() => {
    if (process.platform === 'win32' && !(process.env.DECKHAND_SERVICE || process.env.CLAUDEHUB_SERVICE)) {
      const child = spawn(
        'cmd.exe',
        ['/c', `timeout /t 2 /nobreak >nul & start "" "${join(HUB_ROOT, 'start-hub.cmd')}"`],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.unref();
      process.exit(0);
    } else {
      // service manager (NSSM/systemd) relaunches us
      process.exit(1);
    }
  }, 300);
});

app.get('/api/fleet', (_req, res) => res.json(federation.machines(discovery.selfName)));

/** Agents a machine can run, with their launch-dialog vocabularies. */
app.get('/api/agents', async (req, res) => {
  const machine = typeof req.query.machine === 'string' ? req.query.machine : undefined;
  if (machine && machine !== discovery.selfName) {
    const peer = federation.peerByMachine(machine);
    if (!peer) return res.status(502).json({ error: `machine not connected: ${machine}` });
    try {
      const out = await federation.forward(peer, '/api/agents');
      return res.status(out.status).json(out.body);
    } catch {
      return res.status(502).json({ error: `forward to ${machine} failed` });
    }
  }
  res.json(
    listAgents().map((a) => ({
      id: a.id,
      label: a.label,
      available: a.available(),
      models: a.models,
      permissionModes: a.permissionModes,
      canResume: !!a.transcript,
    })),
  );
});

// Drag-and-drop upload: the browser can't reveal a dropped file's real path, so
// the client sends the bytes here and pastes the saved path into the prompt.
// Registered before the JSON body parser — the body is raw binary.
const DROPS_DIR = join(DATA_DIR, 'drops');
app.post(
  '/api/sessions/:id/drop',
  express.raw({ type: () => true, limit: '100mb' }),
  (req, res) => {
    const session = manager.sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'unknown session' });
    const rawName = String(req.query.name ?? 'dropped-file');
    const safe = rawName.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(-150) || 'dropped-file';
    const dir = join(DROPS_DIR, session.hubId);
    mkdirSync(dir, { recursive: true });
    let target = join(dir, safe);
    if (existsSync(target)) {
      const dot = safe.lastIndexOf('.');
      const stem = dot > 0 ? safe.slice(0, dot) : safe;
      const ext = dot > 0 ? safe.slice(dot) : '';
      let n = 1;
      while (existsSync((target = join(dir, `${stem}-${n}${ext}`)))) n++;
    }
    writeFileSync(target, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    res.json({ path: target });
  },
);

// Durable conversation store (lives on STORE_MACHINE, normally vps-node).
// Push route takes raw bytes — registered before the JSON body parser.
app.post(
  '/api/tstore/:folder/:id',
  express.raw({ type: () => true, limit: '200mb' }),
  async (req, res) => {
    const mtime = Number(req.query.mtime);
    if (!Number.isFinite(mtime)) return res.status(400).json({ error: 'mtime required' });
    try {
      const out = await saveToStore(
        String(req.params.folder),
        String(req.params.id),
        Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        mtime,
        typeof req.query.agent === 'string' ? req.query.agent : undefined,
      );
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

app.get('/api/tstore', async (_req, res) => res.json(await storeCatalog()));

app.get('/api/tstore/:folder/:id', (req, res) => {
  const path = storeFilePath(
    String(req.params.folder),
    String(req.params.id),
    typeof req.query.agent === 'string' ? req.query.agent : undefined,
  );
  if (!existsSync(path)) return res.status(404).json({ error: 'not in store' });
  res.sendFile(path, { dotfiles: 'allow' });
});

app.use((req, res, next) => {
  express.json({ type: () => true, limit: '2mb' })(req, res, (err) => {
    if (err) {
      console.warn(`[http] bad JSON body on ${req.path}`);
      return res.status(400).json({ error: 'invalid JSON body' });
    }
    next();
  });
});
// hashed asset bundles may cache forever, but the HTML shell must not —
// stale index.html pins browsers to old bundles after updates
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.post('/api/hook', makeHookHandler(manager, engine));

app.get('/api/sessions', (_req, res) => res.json(mergedList()));

app.post('/api/sessions', async (req, res) => {
  const { cwd, agentType, name, model, permissionMode, initialPrompt, machine, force } = req.body ?? {};
  // spawn requested on another fleet machine — hand it to the owning hub
  if (machine && machine !== discovery.selfName) {
    const peer = federation.peerByMachine(machine);
    if (!peer) return res.status(502).json({ error: `machine not connected: ${machine}` });
    try {
      const out = await federation.forward(peer, '/api/sessions', {
        method: 'POST',
        body: { cwd, agentType, name, model, permissionMode, initialPrompt, force },
      });
      return res.status(out.status).json(out.body);
    } catch {
      return res.status(502).json({ error: `forward to ${machine} failed` });
    }
  }
  if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return res.status(400).json({ error: `not a directory: ${cwd}` });
  }
  const folderName = String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  if (!force) {
    const busy = liveElsewhere(folderName);
    if (busy.length) return activeElsewhereError(res, busy);
  }
  const session = manager.create({ cwd, agentType, name, model, permissionMode, initialPrompt });
  res.json({ ...session.info(), machine: discovery.selfName });
});

/** Route a per-session action to this hub or the owning peer. */
function sessionAction(
  local: (id: string, req: express.Request, res: express.Response) => void,
): express.RequestHandler {
  return async (req, res) => {
    const id = String(req.params.id);
    if (manager.sessions.get(id)) return local(id, req, res);
    const peer = federation.peerBySession(id);
    if (!peer) return res.status(404).json({ error: 'unknown session' });
    try {
      const out = await federation.forward(peer, req.originalUrl, {
        method: req.method,
        body: Object.keys(req.body ?? {}).length ? req.body : undefined,
      });
      res.status(out.status).json(out.body);
    } catch {
      res.status(502).json({ error: `forward to ${peer.info.machine} failed` });
    }
  };
}

// Auto-approve: when a session's toggle is on and it hits a permission
// prompt, type the accept keystroke into its PTY. Guarded by stateSince so
// each distinct prompt is answered exactly once.
// The plan-mode exit prompt is the one permission we never auto-approve —
// leaving plan mode is a real decision. It's recognizable by its options,
// which offer to keep planning (ordinary permission prompts don't).
function isProtectedPrompt(session: HubSession): boolean {
  try {
    return agentFor(session).isProtectedPrompt?.(session.snapshot()) ?? false;
  } catch {
    return false;
  }
}

function maybeAutoAnswer(session: HubSession) {
  if (!session.autoYes || !session.proc) return;
  if (session.state !== 'WAITING_PERMISSION') return;
  if (session.autoAnsweredAt >= session.stateSince) return;
  session.autoAnsweredAt = session.stateSince;
  // let the prompt finish rendering, then accept the highlighted default (Yes)
  setTimeout(() => {
    if (!session.autoYes || !session.proc || session.state !== 'WAITING_PERMISSION') return;
    if (isProtectedPrompt(session)) return; // e.g. plan-mode exit needs a human
    manager.write(session.hubId, agentFor(session).acceptKeystroke);
  }, 600);
}

app.post('/api/sessions/:id/autoyes', sessionAction((id, req, res) => {
  const session = manager.sessions.get(id)!;
  session.autoYes = !!req.body?.on;
  manager.emit('change', session);
  if (session.autoYes) maybeAutoAnswer(session); // catch an already-pending prompt
  res.json({ ok: true, autoYes: session.autoYes });
}));

app.post('/api/sessions/:id/kill', sessionAction((id, _req, res) => {
  manager.kill(id);
  res.json({ ok: true });
}));

app.post('/api/sessions/:id/resume', sessionAction((id, req, res) => {
  const existing = manager.sessions.get(id);
  if (existing && !req.body?.force) {
    const folderName = existing.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    const busy = liveElsewhere(folderName);
    if (busy.length) return activeElsewhereError(res, busy);
  }
  const session = manager.resume(id);
  if (!session) return res.status(404).json({ error: 'unknown session' });
  res.json({ ...session.info(), machine: discovery.selfName });
}));

app.post('/api/sessions/:id/remove', sessionAction((id, _req, res) => {
  manager.remove(id);
  res.json({ ok: true });
}));

app.get('/api/conversations', async (_req, res) => {
  const inHub = new Set([...manager.sessions.values()].map((s) => s.claudeSessionId));
  res.json(await listRecentConversations(inHub));
});

app.post('/api/sessions/adopt', (req, res) => {
  const { claudeSessionId, cwd, name, agentType } = req.body ?? {};
  if (!claudeSessionId || !cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return res.status(400).json({ error: `bad session id or directory` });
  }
  if (manager.byClaudeSessionId(claudeSessionId)) {
    return res.status(409).json({ error: 'already in hub' });
  }
  const session = manager.create({ cwd, agentType, name, resumeSessionId: claudeSessionId });
  res.json({ ...session.info(), machine: discovery.selfName });
});

app.get('/api/projects', async (req, res) => {
  const machine = typeof req.query.machine === 'string' ? req.query.machine : undefined;
  if (machine && machine !== discovery.selfName) {
    const peer = federation.peerByMachine(machine);
    if (!peer) return res.status(502).json({ error: `machine not connected: ${machine}` });
    try {
      const out = await federation.forward(peer, '/api/projects');
      return res.status(out.status).json(out.body);
    } catch {
      return res.status(502).json({ error: `forward to ${machine} failed` });
    }
  }
  const dirs = readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$'))
    .map((d) => ({ name: d.name, path: join(PROJECTS_ROOT, d.name) }));
  res.json(dirs);
});

// ---------------------------------------------------------- Fleet folders & sync

app.get('/api/sync/config', (_req, res) => {
  if (!sync) return res.status(404).json({ error: 'sync not configured on this machine' });
  res.json({ vps: sync.cfg.vps });
});

app.post('/api/sync/register', async (req, res) => {
  const { folder } = req.body ?? {};
  if (!sync) return res.status(503).json({ error: 'sync not configured' });
  if (!folder || !existsSync(join(PROJECTS_ROOT, folder))) {
    return res.status(400).json({ error: `unknown folder: ${folder}` });
  }
  try {
    await sync.registerFolder(String(folder));
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

async function localFolderList(): Promise<FolderInfo[]> {
  let syncedIds = new Set<string>();
  if (sync) {
    try {
      syncedIds = new Set((await sync.localFolders()).map((f) => f.id));
    } catch {
      /* syncthing down — folders still listed, just unsynced */
    }
  }
  const live = [...manager.sessions.values()].filter((s) => s.proc);
  const list = await listLocalFolders(
    syncedIds,
    live.map((s) => s.cwd),
    // hide only conversations with a LIVE hub process — resuming those would
    // fork; EXITED cards' conversations must stay resumable from the folder view
    new Set(live.map((s) => s.claudeSessionId)),
  );
  return list.map((f) => ({ ...f, machine: discovery.selfName }));
}

app.get('/api/folders', async (_req, res) => res.json(await localFolderList()));

app.get('/api/fleet-folders', async (_req, res) => {
  const mine = await localFolderList();
  const all: FolderInfo[] = [...mine];
  await Promise.all(
    federation.connectedPeers().map(async (peer) => {
      try {
        const out = await federation.forward(peer, '/api/folders');
        if (out.status === 200 && Array.isArray(out.body)) all.push(...(out.body as FolderInfo[]));
      } catch {
        /* peer folder list unavailable */
      }
    }),
  );
  const vpsCatalog = sync ? await sync.vpsCatalog() : [];

  // group by folder name across machines
  const byName = new Map<string, { folder: string; onVps: boolean; locations: FolderInfo[] }>();
  for (const f of all) {
    let g = byName.get(f.folder);
    if (!g) byName.set(f.folder, (g = { folder: f.folder, onVps: false, locations: [] }));
    g.locations.push(f);
  }
  for (const id of vpsCatalog) {
    if (!byName.has(id)) byName.set(id, { folder: id, onVps: true, locations: [] });
    else byName.get(id)!.onVps = true;
  }

  // the durable store backfills conversations no machine can offer anymore
  // (origin offline, transcript aged out locally, folder moved)
  let stored: StoreEntry[] = [];
  try {
    if (discovery.selfName === STORE_MACHINE) {
      stored = await storeCatalog();
    } else {
      const peer = federation.peerByMachine(STORE_MACHINE);
      if (peer) {
        const out = await federation.forward(peer, '/api/tstore');
        if (out.status === 200 && Array.isArray(out.body)) stored = out.body as StoreEntry[];
      }
    }
  } catch {
    /* store unavailable — machine copies still shown */
  }
  const storeByFolder = new Map<string, StoreEntry[]>();
  for (const e of stored) {
    if (!storeByFolder.has(e.folder)) storeByFolder.set(e.folder, []);
    storeByFolder.get(e.folder)!.push(e);
  }
  for (const [folder, entries] of storeByFolder) {
    let g = byName.get(folder);
    if (!g) byName.set(folder, (g = { folder, onVps: false, locations: [] }));
    const seen = new Map<string, number>(); // sessionId -> newest machine copy mtime
    for (const loc of g.locations) {
      for (const c of loc.conversations) {
        seen.set(c.claudeSessionId, Math.max(seen.get(c.claudeSessionId) ?? 0, c.updatedAt));
      }
    }
    const fresh = entries.filter((e) => (seen.get(e.claudeSessionId) ?? 0) < e.updatedAt);
    if (fresh.length === 0) continue;
    g.locations.push({
      folder,
      path: '(fleet store)',
      machine: STORE_MACHINE,
      synced: true,
      activeHubSessions: 0,
      updatedAt: Math.max(...fresh.map((e) => e.updatedAt)),
      conversations: fresh.map((e) => ({
        agentType: e.agentType ?? 'claude',
        claudeSessionId: e.claudeSessionId,
        title: e.title,
        lastText: e.lastText,
        updatedAt: e.updatedAt,
        activeElsewhere: false,
      })),
    });
  }
  res.json(
    [...byName.values()].sort((a, b) => {
      const la = Math.max(0, ...a.locations.map((l) => l.updatedAt));
      const lb = Math.max(0, ...b.locations.map((l) => l.updatedAt));
      return lb - la;
    }),
  );
});

// Printable transcript: the last N question→reply exchanges of a session,
// extracted from the jsonl (text only — tool noise omitted).
app.get('/api/sessions/:id/export', async (req, res) => {
  const session = manager.sessions.get(String(req.params.id));
  if (!session) return res.status(404).send('session not on this machine');
  const n = Math.max(1, Math.min(100, Number(req.query.replies) || 5));
  const ops = agentFor(session).transcript;
  if (!ops) return res.status(404).send('this agent keeps no readable transcript');
  const path = ops.file(session.cwd, session.claudeSessionId);
  if (!existsSync(path)) return res.status(404).send('no transcript for this session yet');

  let exchanges: { q: string; r: string }[];
  try {
    const { readFile } = await import('node:fs/promises');
    exchanges = ops.parseExchanges(await readFile(path, 'utf8'), n);
  } catch (err) {
    return res.status(500).send(String(err));
  }

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const when = new Date().toLocaleString();
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<title>${esc(session.name)} — last ${exchanges.length} exchanges</title>
<style>
  body { max-width: 860px; margin: 32px auto; padding: 0 24px; background: #fff; color: #1a1a1a;
         font: 15px/1.55 Georgia, 'Times New Roman', serif; }
  header { border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; margin-bottom: 28px; }
  header h1 { font-size: 20px; margin: 0; }
  header .meta { color: #666; font-size: 12px; margin-top: 4px; }
  .q { background: #f2f2f2; border-left: 4px solid #1a1a1a; padding: 10px 14px;
       font-weight: bold; white-space: pre-wrap; margin: 0 0 14px; }
  .r { white-space: pre-wrap; margin: 0 0 28px; }
  section + section { border-top: 1px solid #ccc; padding-top: 26px; }
  @media print { body { margin: 0; max-width: none; font-size: 12px; } }
</style></head><body>
<header><h1>${esc(session.name)}</h1>
<div class="meta">${esc(session.cwd)} · ${discovery.selfName} · exported ${esc(when)} · last ${exchanges.length} exchange${exchanges.length === 1 ? '' : 's'}</div></header>
${exchanges.map((e) => `<section><div class="q">${esc(e.q)}</div><div class="r">${esc(e.r)}</div></section>`).join('\n')}
</body></html>`);
});

app.get('/api/transcripts/:id', (req, res) => {
  const folder = String(req.query.folder ?? '');
  const id = String(req.params.id).replace(/[^a-zA-Z0-9-]/g, '');
  if (!folder || !id) return res.status(400).json({ error: 'folder and id required' });
  const agent = getAgent(typeof req.query.agent === 'string' ? req.query.agent : undefined);
  const path = agent.transcript?.file(join(PROJECTS_ROOT, folder), id);
  if (path && existsSync(path)) {
    // the path runs through a dot-directory — sendFile rejects those by default
    return res.sendFile(path, { dotfiles: 'allow' });
  }
  // not on this machine — the durable store may still have it (this is how
  // conversations survive their origin machine being wiped or offline)
  const stored = storeFilePath(folder, id, agent.id);
  if (existsSync(stored)) return res.sendFile(stored, { dotfiles: 'allow' });
  res.status(404).json({ error: 'transcript not found' });
});

// ------------------------------------------------------------ Handoff
// Source hub runs the job (it can talk to the live session); the target hub
// receives the document and starts the engine.
app.post('/api/sessions/:id/handoff', sessionAction((id, req, res) => {
  const b = req.body ?? {};
  if (!b.targetAgent) return res.status(400).json({ error: 'targetAgent required' });
  const job = startHandoff(
    {
      sourceHubId: id,
      targetAgent: String(b.targetAgent),
      targetMachine: b.targetMachine ? String(b.targetMachine) : undefined,
      targetFolder: b.targetFolder ? String(b.targetFolder) : undefined,
      newFolder: b.newFolder ? String(b.newFolder) : undefined,
      askBrief: b.askBrief !== false,
      includeDialogue: b.includeDialogue !== false,
      model: b.model ? String(b.model) : undefined,
      permissionMode: b.permissionMode ? String(b.permissionMode) : undefined,
    },
    { manager, federation, selfName: discovery.selfName },
  );
  res.json({ jobId: job.id, machine: discovery.selfName });
}));

app.get('/api/handoff/:jobId', async (req, res) => {
  const machine = typeof req.query.machine === 'string' ? req.query.machine : undefined;
  if (machine && machine !== discovery.selfName) {
    const peer = federation.peerByMachine(machine);
    if (!peer) return res.status(502).json({ error: `machine not connected: ${machine}` });
    try {
      const out = await federation.forward(peer, `/api/handoff/${req.params.jobId}`);
      return res.status(out.status).json(out.body);
    } catch {
      return res.status(502).json({ error: `forward to ${machine} failed` });
    }
  }
  const job = getHandoffJob(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: 'unknown job' });
  res.json(job);
});

app.post('/api/handoff/receive', async (req, res) => {
  try {
    const session = await receiveHandoff(req.body as HandoffPayload, { manager, selfName: discovery.selfName });
    res.json({ ...session.info(), machine: discovery.selfName });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/fleet-resume', async (req, res) => {
  const { folder, agentType, claudeSessionId, sourceMachine, machine, force } = req.body ?? {};
  if (!folder || !claudeSessionId) {
    return res.status(400).json({ error: 'folder and claudeSessionId required' });
  }
  // target is another machine — hand the whole job to its hub
  if (machine && machine !== discovery.selfName) {
    const peer = federation.peerByMachine(String(machine));
    if (!peer) return res.status(502).json({ error: `machine not connected: ${machine}` });
    try {
      const out = await federation.forward(peer, '/api/fleet-resume', {
        method: 'POST',
        body: { folder, agentType, claudeSessionId, sourceMachine, force },
      });
      return res.status(out.status).json(out.body);
    } catch {
      return res.status(502).json({ error: `forward to ${machine} failed` });
    }
  }
  if (!force) {
    const busy = liveElsewhere(String(folder));
    if (busy.length) return activeElsewhereError(res, busy);
  }
  const job = startFleetResume({
    folder: String(folder),
    agentType: agentType ? String(agentType) : undefined,
    claudeSessionId: String(claudeSessionId),
    sourceMachine: sourceMachine ? String(sourceMachine) : undefined,
    selfName: discovery.selfName,
    manager,
    sync,
    federation,
  });
  res.json({ jobId: job.id, machine: discovery.selfName });
});

app.get('/api/fleet-resume/:jobId', async (req, res) => {
  const machine = typeof req.query.machine === 'string' ? req.query.machine : undefined;
  if (machine && machine !== discovery.selfName) {
    const peer = federation.peerByMachine(machine);
    if (!peer) return res.status(502).json({ error: `machine not connected: ${machine}` });
    try {
      const out = await federation.forward(peer, `/api/fleet-resume/${req.params.jobId}`);
      return res.status(out.status).json(out.body);
    } catch {
      return res.status(502).json({ error: `forward to ${machine} failed` });
    }
  }
  const job = getResumeJob(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: 'unknown job' });
  res.json(job);
});

// ------------------------------------------------------------- WebSockets

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

const controlClients = new Set<WebSocket>();
const termClients = new Map<string, Set<WebSocket>>(); // hubId -> sockets

/** A just-spawned remote session may not be in the peer cache yet — retry briefly. */
async function findPeerForTerm(hubId: string) {
  for (let i = 0; i < 10; i++) {
    const peer = federation.peerBySession(hubId);
    if (peer?.connected) return peer;
    await new Promise((r) => setTimeout(r, 300));
  }
  return undefined;
}

httpServer.on('upgrade', (req, socket, head) => {
  const remoteAddress = (socket as import('node:net').Socket).remoteAddress;
  if (!isTrustedSource(remoteAddress)) return socket.destroy();
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/ws/control') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      controlClients.add(ws);
      ws.on('close', () => controlClients.delete(ws));
      ws.send(JSON.stringify({ type: 'sessions', sessions: mergedList() }));
    });
  } else if (url.pathname.startsWith('/ws/term/')) {
    const hubId = url.pathname.split('/').pop()!;
    const session = manager.sessions.get(hubId);
    if (session) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        let set = termClients.get(hubId);
        if (!set) termClients.set(hubId, (set = new Set()));
        set.add(ws);
        ws.on('close', () => set!.delete(ws));

        const sendInit = () =>
          ws.send(
            JSON.stringify({
              t: 'init',
              cols: session.cols,
              rows: session.rows,
              snapshot: session.snapshot(),
              mouseMode: session.mouseMode(),
            }),
          );

        // exact screen state from the server-side mirror — no raw-replay garbling
        sendInit();

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.t === 'in') manager.write(hubId, msg.d);
            else if (msg.t === 'resize') manager.resize(hubId, msg.c, msg.r);
            // post-resize re-sync: ConPTY's incremental repaint after a resize is
            // unreliable; the client asks for a clean snapshot once things settle
            else if (msg.t === 'refresh') sendInit();
          } catch {
            /* ignore malformed frames */
          }
        });
      });
    } else {
      // not ours — pipe the browser through to the hub that owns the session
      void (async () => {
        const peer = await findPeerForTerm(hubId);
        if (!peer) return socket.destroy();
        wss.handleUpgrade(req, socket, head, (client) => {
          const upstream = new WebSocket(federation.termWsUrl(peer, hubId));
          const pending: { data: Buffer; binary: boolean }[] = [];
          upstream.on('open', () => {
            for (const f of pending) upstream.send(f.data, { binary: f.binary });
            pending.length = 0;
          });
          upstream.on('message', (data, isBinary) => {
            if (client.readyState === WebSocket.OPEN)
              client.send(data as Buffer, { binary: isBinary });
          });
          client.on('message', (data, isBinary) => {
            const frame = { data: data as Buffer, binary: isBinary };
            if (upstream.readyState === WebSocket.OPEN) upstream.send(frame.data, { binary: frame.binary });
            else if (upstream.readyState === WebSocket.CONNECTING) pending.push(frame);
          });
          upstream.on('close', () => client.close());
          upstream.on('error', () => client.close());
          client.on('close', () => upstream.close());
          client.on('error', () => upstream.close());
        });
      })();
    }
  } else {
    socket.destroy();
  }
});

// Trailing-edge debounce: bursts of change events (federation churn, status
// flaps) collapse into one broadcast — belt-and-suspenders against echo storms.
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastSessions() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const payload = JSON.stringify({ type: 'sessions', sessions: mergedList() });
    for (const ws of controlClients) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }, 120);
}

// --------------------------------------------------------------- Wiring

let saveTimer: ReturnType<typeof setTimeout> | null = null;
manager.on('change', (session: HubSession) => {
  maybeAutoAnswer(session);
  broadcastSessions();
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      savePersisted(manager);
    }, 1000);
  }
  // Refresh the summary line when a turn ends or Claude starts waiting.
  // Small delay: the transcript jsonl flushes slightly after the Stop hook fires.
  if (['IDLE', 'WAITING_QUESTION', 'WAITING_PERMISSION'].includes(session.state)) {
    setTimeout(() => {
      lastAssistantText(session).then((text) => {
        if (text && text !== session.summary) {
          session.summary = text;
          broadcastSessions();
        }
      });
    }, 1200);
  }
});

manager.on('data', (session: HubSession, chunk: string) => {
  const set = termClients.get(session.hubId);
  if (!set) return;
  // binary frames = terminal output; text frames = control JSON (init)
  const payload = Buffer.from(chunk, 'utf8');
  for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
});

federation.on('change', broadcastSessions);

function broadcastAlert(payload: Record<string, unknown>) {
  const msg = JSON.stringify(payload);
  for (const ws of controlClients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

// Alerts reach the human through connected dashboards (chime + badge) — and
// later, phone push. Desktop toasts were removed deliberately.
engine.on('alert', ({ session, state, detail }: { session: HubSession; state: string; detail?: string }) => {
  broadcastAlert({
    type: 'alert',
    hubId: session.hubId,
    state,
    name: session.name,
    detail,
    machine: discovery.selfName,
    origin: INSTANCE_ID,
  });
});

federation.on('alert', (alert: PeerAlert) => {
  broadcastAlert({ ...alert, type: 'alert' });
});

startStatusFileWatcher(manager, engine);
startSessionPusher();

// Broadcast every 15 s so elapsed-in-state timers stay honest even without events.
setInterval(broadcastSessions, 15_000).unref();

// ----------------------------------------------------------------- Boot

/** Every agent materializes its hook config against the port we actually got. */
function writeHooksJson(port: number) {
  for (const agent of listAgents()) {
    try {
      agent.writeHooks?.(port);
    } catch (err) {
      console.error(`[hooks] ${agent.id}: ${err}`);
    }
  }
}

function listen(port: number, attemptsLeft: number) {
  httpServer.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.warn(`[hub] port ${port} in use, trying ${port + 1}`);
      listen(port + 1, attemptsLeft - 1);
    } else {
      throw err;
    }
  });
  // 0.0.0.0 so tailnet peers can reach us; isTrustedSource() rejects everything
  // that is not loopback or tailnet, so LAN/internet sources get 403/destroyed.
  httpServer.listen(port, '0.0.0.0', () => {
    actualPort = port;
    writeHooksJson(port);
    discovery.start();
    if (!existsSync(PROJECTS_ROOT)) {
      console.warn(
        `[hub] WARNING: projects root ${PROJECTS_ROOT} does not exist — set HUB_PROJECTS_ROOT in hub-env.cmd`,
      );
    }
    console.log(`\n  Deckhand running at http://127.0.0.1:${port} (machine: ${discovery.selfName})\n`);
  });
}

listen(DEFAULT_PORT, 10);
