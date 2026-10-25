import { createServer } from 'node:http';
import { authorize, cookieHeader, loadApiToken, LAN_ENABLED } from './access.js';
import { startBeacon } from './beacon.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { mkdir as mkdirAsync, rename, writeFile as writeFileAsync } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import express from 'express';
import { copyIn, listDir, safePath, zipFolder } from './files.js';
import { FLEET_RULES, folderOwner, projectFolderOf } from './etiquette.js';
import { runShell } from './agents/shell.js';
import { WebSocketServer, WebSocket } from 'ws';
import { DATA_DIR, DEFAULT_PORT, HUB_ROOT, PROJECTS_ROOT, PUBLIC_DIR } from './config.js';
import { agentFor, getAgent, listAgents } from './agents/index.js';
import { SessionManager, type HubSession } from './sessionManager.js';
import { StatusEngine } from './statusEngine.js';
import { hookBus, makeHookHandler } from './hooksReceiver.js';
import { detailOf, startEvenBridge, summarizeTool } from './evenBridge.js';
import { startStatusFileWatcher } from './statusFileWatcher.js';
import { startSessionPusher } from './sessionPusher.js';
import { lastAssistantText } from './transcripts.js';
import { moveDir, normCwd } from './transcriptIo.js';
import { loadPersisted, savePersisted } from './persistence.js';
import { listRecentConversations } from './conversations.js';
import { Discovery } from './discovery.js';
import { Federation, type PeerAlert } from './federation.js';
import { createSyncManager, bootstrapSyncConfig, type SyncManager } from './syncthing.js';
import { loadVersionInfo } from './version.js';
import { FLEET_TARGET_FILE, UPDATE_MACHINE, Updater, type FleetTarget } from './updater.js';
import {
  storeMeta,
  applyUpload,
  STORE_DIR,
  STORE_MACHINE,
  TranscriptPusher,
  saveToStore,
  storeCatalog,
  storeFilePath,
  type StoreEntry,
} from './transcriptStore.js';
import { listLocalFolders, type FolderInfo } from './fleetFolders.js';
import { startFleetResume, getResumeJob, ensureTranscript } from './fleetResume.js';
import { startHandoff, getHandoffJob, receiveHandoff, type HandoffPayload } from './handoff.js';
import { isFrozen, setFrozen, folderNameOf } from './frozen.js';
import { applyOnAuthority, changesSince, forget, formatMemory, initFleetMemory, recall, remember, renameProjectMemories, type MemoryOp } from './fleetMemory.js';
import { initProvenance, provenanceMiddleware, readProvenance } from './provenance.js';
import { decideRequest, gatewayAgentLog, gatewayAgents, gatewayPresent, revokeAgent, sendAgentMessage } from './gatewayAgents.js';
import { MIMIR_MACHINE, mimirCall, mimirHere } from './mimir.js';
import { markRenameSeen, mergeRenames, recordRename, renameLog, unseenRenames, type RenameEntry } from './renameJournal.js';
import {
  KEYS,
  isSettled,
  lastExchanges,
  replyTo,
  screenText,
  typePrompt,
  waitForTurn,
  waitUntil,
} from './automation.js';
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
initProvenance(() => discovery.selfName);
let actualPort = DEFAULT_PORT; // updated when listen() settles (port walk)
const selfRef = {
  name: () => discovery.selfName,
  baseUrl: () => `http://127.0.0.1:${actualPort}`,
};
const updater = new Updater(VERSION, federation, selfRef);
updater.beforeApply = () => savePersisted(manager); // a self-started update restores live sessions too
const pusher = new TranscriptPusher(federation, selfRef, {
  isLive: (id) => !!manager.byClaudeSessionId(id)?.proc,
});
// a session that went idle or exited gets its transcript pushed right away
manager.on('change', (session: HubSession) => {
  if (session.state === 'IDLE' || session.state === 'EXITED') pusher.nudge(session.claudeSessionId);
});

let sync: SyncManager | null = createSyncManager();

/** Ignore rules shipped in a release propagate on boot: every synced folder is topped up. */
function reconcileIgnoresSoon(m: SyncManager, delayMs: number) {
  setTimeout(() => {
    m.reconcileIgnores()
      .then((changed) => {
        if (changed.length === 0) return console.log('[sync] ignore rules up to date on all folders');
        for (const c of changed) console.log(`[sync] ${c.folder}: added ignore rules ${c.added.join(', ')}`);
      })
      .catch((err) => console.warn(`[sync] ignore reconcile skipped: ${err}`));
  }, delayMs).unref();
}
if (sync) reconcileIgnoresSoon(sync, 20_000);
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
    if (m) {
      sync = m;
      reconcileIgnoresSoon(m, 5_000);
    }
  });
}, 60_000);
syncBootstrapTimer.unref();

// Cards from the previous run come back as EXITED; the ones that were running
// when the hub went down are relaunched once we listen (restoreSessions).
const toRestore: HubSession[] = [];
for (const rec of loadPersisted()) {
  const s = manager.addExitedRecord(rec);
  s.autoYes = !!rec.autoYes;
  if (rec.alive) toRestore.push(s);
}

/**
 * Relaunch the sessions that were live before the restart, one every couple
 * of seconds so a dozen agents don't start at once. Skipped for a session
 * whose engine is missing here, whose folder is gone, or whose conversation
 * never got an id (an unbound Codex card). HUB_RESTORE=0 disables it.
 */
function restoreSessions() {
  if (process.env.HUB_RESTORE === '0' || !toRestore.length) return;
  const eligible = toRestore.filter((s) => {
    if (s.claudeSessionId.startsWith('pending-')) return false;
    // a terminal has no conversation to pick up — it waits for a manual restart
    // rather than reopening a shell (and whatever it was doing) on its own
    if (getAgent(s.agentType).outputOnlyStatus) return false;
    if (!existsSync(s.cwd)) return false;
    try {
      return getAgent(s.agentType).available();
    } catch {
      return false;
    }
  });
  console.log(`[restore] ${eligible.length} of ${toRestore.length} session(s) were running before the restart — resuming`);
  eligible.forEach((s, i) => {
    setTimeout(() => {
      if (s.proc || !manager.sessions.has(s.hubId)) return; // resumed by hand meanwhile, or removed
      try {
        manager.resume(s.hubId);
        console.log(`[restore] resumed ${s.name} (${s.agentType}, ${s.claudeSessionId.slice(0, 8)})`);
      } catch (err) {
        console.error(`[restore] could not resume ${s.name}:`, err);
      }
    }, 1500 + i * 2500).unref();
  });
}

/** Local sessions tagged with this machine's name — the shape peers rely on. */
function localList(): SessionInfo[] {
  return manager.list().map((s) => ({
    ...s,
    machine: discovery.selfName,
    origin: INSTANCE_ID,
    frozen: isFrozen(folderNameOf(s.cwd)) || undefined,
  }));
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
    if (getAgent(s.agentType).ownsFolder === false) continue; // a terminal claims no folder
    const base = s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase();
    if (base === want) machines.add(s.machine ?? 'unknown');
  }
  return [...machines];
}

/** "~" and "~/…" mean this machine's home folder (terminal cards, dh_run). */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (/^~[\\/]/.test(p)) return join(homedir(), p.slice(2));
  return p;
}

/** 400 when the requested engine is not installed here (a viewer-only machine, say). */
function engineMissing(res: express.Response, agentType: unknown): boolean {
  const agent = getAgent(typeof agentType === 'string' ? agentType : undefined);
  if (agent.available()) return false;
  res.status(400).json({ error: `${agent.label} is not installed on ${discovery.selfName}` });
  return true;
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

// Who gets in is decided in access.ts: loopback/own-address/tailnet freely,
// the private LAN with the API token, nobody else.
app.use((req, res, next) => {
  const verdict = authorize(req.socket.remoteAddress, req.headers, req.url);
  if (verdict.status === 403) return res.status(403).end();
  if (verdict.status === 401) {
    return res.status(401).json({ error: 'API token required (Authorization: Bearer …, or open /?token=… once)' });
  }
  if (verdict.setCookie) res.setHeader('Set-Cookie', cookieHeader());
  next();
});

// Provenance: one line per action, with its caller and the hubs it passed through.
app.use(
  provenanceMiddleware((id) => {
    const local = manager.sessions.get(id) ?? manager.byClaudeSessionId(id) ?? byConversationPrefix(id);
    if (local) return { id, hubId: local.hubId, name: local.name, conversationId: local.claudeSessionId };
    const peer = federation.peerBySession(id);
    const s = peer?.sessions.find((x) => x.hubId === id || x.claudeSessionId.startsWith(id));
    return s ? { id, hubId: s.hubId, name: s.name, conversationId: s.claudeSessionId } : undefined;
  }),
);

/** GET forwarded to another machine with its query (minus `machine`), or false when it is ours. */
function forwardGetWithQuery(req: express.Request, res: express.Response, machine: string | undefined): boolean {
  if (!machine || machine === discovery.selfName) return false;
  const peer = federation.peerByMachine(machine);
  if (!peer) {
    res.status(502).json({ error: `machine not connected: ${machine}` });
    return true;
  }
  const qs = new URLSearchParams(req.query as Record<string, string>);
  qs.delete('machine');
  federation
    .forward(peer, `${req.path}${qs.size ? `?${qs}` : ''}`)
    .then((out) => res.status(out.status).json(out.body))
    .catch(() => res.status(502).json({ error: `forward to ${machine} failed` }));
  return true;
}

// The provenance log of one machine (?machine=, default this one), newest first.
app.get('/api/provenance', (req, res) => {
  if (forwardGetWithQuery(req, res, typeof req.query.machine === 'string' ? req.query.machine : undefined)) return;
  res.json(
    readProvenance({
      limit: Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000),
      q: typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined,
      id: typeof req.query.id === 'string' && req.query.id ? req.query.id : undefined,
      since: Number(req.query.since) || undefined,
    }),
  );
});

// Public-gateway clients and their request logs, from the machine that runs the gateway.
app.get('/api/gateway/agents', (req, res) => {
  if (!gatewayPresent() && forwardGetWithQuery(req, res, STORE_MACHINE)) return;
  res.json({ machine: discovery.selfName, present: gatewayPresent(), agents: gatewayPresent() ? gatewayAgents() : [] });
});
app.get('/api/gateway/agents/:id/log', (req, res) => {
  if (!gatewayPresent() && forwardGetWithQuery(req, res, STORE_MACHINE)) return;
  res.json(gatewayAgentLog(String(req.params.id), Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000)));
});

// ACCEPT / REJECT an agent's access request. Accepting only lets it mint a
// token and enroll (prove who it is); what it may reach is decided by the
// user's own trust entries in fleet memory, never by accepting.
app.post('/api/gateway/requests/:id/:decision', async (req, res) => {
  const decision = String(req.params.decision);
  const id = String(req.params.id);
  if ((decision !== 'accept' && decision !== 'reject') || !/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: 'POST /api/gateway/requests/<request id>/accept|reject' });
  if (!gatewayPresent()) {
    const peer = federation.peerByMachine(STORE_MACHINE);
    if (!peer) return res.status(502).json({ error: `${STORE_MACHINE} is not connected` });
    const out = await federation.forward(peer, req.path, { method: 'POST' }).catch(() => null);
    return out ? res.status(out.status).json(out.body) : res.status(502).json({ error: `forward to ${STORE_MACHINE} failed` });
  }
  try {
    res.json(await decideRequest(id, decision));
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// A message to a gateway agent: pushed to its webhook, or left in its inbox.
// Mimir (the broker) may message any enrolled agent: delegating a task to an
// agent the user accepted is what accepting it approved. Anyone else may only
// message agents with the user's trust entry in fleet memory.
app.post('/api/gateway/agents/:id/messages', express.json({ type: () => true, limit: '64kb' }), async (req, res) => {
  const clientId = String(req.params.id).toLowerCase();
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(clientId) || !text) return res.status(400).json({ error: 'POST /api/gateway/agents/<client>/messages {"text": "...", "taskId"?: "...", "inReplyTo"?: "..."}' });
  const extra: { taskId?: string; inReplyTo?: string } = {};
  for (const k of ['taskId', 'inReplyTo'] as const) if (typeof req.body?.[k] === 'string' && req.body[k]) extra[k] = String(req.body[k]).slice(0, 200);
  if (!gatewayPresent()) {
    const peer = federation.peerByMachine(STORE_MACHINE);
    if (!peer) return res.status(502).json({ error: `${STORE_MACHINE} is not connected` });
    const out = await federation.forward(peer, req.path, { method: 'POST', body: { text, ...extra } }).catch(() => null);
    return out ? res.status(out.status).json(out.body) : res.status(502).json({ error: `forward to ${STORE_MACHINE} failed` });
  }
  const from = String(req.headers['x-deckhand-caller'] ?? '') || (/mozilla/i.test(String(req.headers['user-agent'] ?? '')) ? 'dashboard' : 'api');
  if (from !== 'mimir') {
    // the trust rule, outward: nothing leaves for an agent without the user's trust entry
    const trusted = (await recall('trusted-agent', 200).catch(() => [])).some((m) => {
      const tags = m.tags.toLowerCase().split(/[\s,]+/);
      return m.instructed && !m.deleted && !m.originMachine.startsWith('gateway:') && !m.originSession.startsWith('gateway:') &&
        tags.includes('trusted-agent') && (tags.includes(`client:${clientId}`) || tags.includes('client:*'));
    });
    if (!trusted) return res.status(403).json({ error: `${clientId} has no trust entry in fleet memory: not sending (hand Mimir a task instead)` });
  }
  try {
    res.json(await sendAgentMessage(clientId, from, text, extra));
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Revoke a gateway agent: its key (and any pending token) go at once.
app.post('/api/gateway/agents/:id/revoke', async (req, res) => {
  const clientId = String(req.params.id).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(clientId)) return res.status(400).json({ error: 'bad client id' });
  if (!gatewayPresent()) {
    const peer = federation.peerByMachine(STORE_MACHINE);
    if (!peer) return res.status(502).json({ error: `${STORE_MACHINE} is not connected` });
    const out = await federation.forward(peer, req.path, { method: 'POST' }).catch(() => null);
    return out ? res.status(out.status).json(out.body) : res.status(502).json({ error: `forward to ${STORE_MACHINE} failed` });
  }
  try {
    res.json({ revoked: clientId, note: await revokeAgent(clientId) });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Mimir: hand it a task (a session's reply address travels along), follow a
// task, and see its view of the agents. Answered on the machine holding
// Mimir's key, forwarded there from any other hub.
async function mimirRoute(req: express.Request, res: express.Response, method: 'GET' | 'POST', path: string, body?: unknown) {
  if (!mimirHere()) {
    const peer = federation.peerByMachine(MIMIR_MACHINE);
    if (!peer) return res.status(502).json({ error: `${MIMIR_MACHINE} (Mimir's machine) is not connected` });
    // forward the request as it came: the other hub reshapes it for Mimir itself
    const out = await federation.forward(peer, req.originalUrl, { method, body: method === 'POST' ? req.body : undefined }).catch(() => null);
    return out ? res.status(out.status).json(out.body) : res.status(502).json({ error: `forward to ${MIMIR_MACHINE} failed` });
  }
  try {
    const out = await mimirCall(method, path, body);
    res.status(out.status).json(out.body);
  } catch (err) {
    res.status(503).json({ error: `Mimir is unreachable: ${err instanceof Error ? err.message : err}` });
  }
}
app.get('/api/mimir/agents', (req, res) => void mimirRoute(req, res, 'GET', '/api/v1/agents'));
app.get('/api/mimir/tasks/:id', (req, res) => void mimirRoute(req, res, 'GET', `/api/v1/tasks/${encodeURIComponent(String(req.params.id))}`));
app.post('/api/mimir/tasks', express.json({ type: () => true, limit: '64kb' }), (req, res) => {
  const b = req.body ?? {};
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  const conversationId = typeof b.conversationId === 'string' ? b.conversationId : '';
  if (!text) return res.status(400).json({ error: 'POST /api/mimir/tasks {"text": "...", "conversationId": "<your DECKHAND_CONVERSATION>", "delegate"?: "<agent>"}' });
  const caller = String(req.headers['x-deckhand-caller'] ?? '') || 'api';
  void mimirRoute(req, res, 'POST', '/api/v1/tasks', {
    text,
    ...(typeof b.delegate === 'string' && b.delegate ? { delegate: b.delegate } : {}),
    // the result comes back as a "[Mimir, task T7] …" prompt to that conversation; without one, poll
    replyTo: conversationId ? { kind: 'deckhand', conversationId } : { kind: 'poll' },
    requester: caller,
  });
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

// check, and prestage the newest build so updating needs no release machine later
app.post('/api/admin/check', async (req, res) => {
  if (adminForward(req, res)) return;
  res.json(await updater.checkAndStage());
});

app.post('/api/admin/update', (req, res) => {
  if (adminForward(req, res)) return;
  savePersisted(manager); // which sessions are live right now — restored after the restart
  updater.apply().catch((err) => {
    updater.status.updating = false;
    updater.status.error = err instanceof Error ? err.message : String(err);
    console.error('[updater] apply failed:', err);
  });
  res.json({ ok: true, note: 'updating — hub restarts itself when done' });
});

/** Leave UPDATE ALL's mark where every hub looks for it (the release machine). */
async function writeFleetTarget(target: FleetTarget) {
  const dir = join(DATA_DIR, 'releases');
  await mkdirAsync(dir, { recursive: true });
  await writeFileAsync(join(dir, FLEET_TARGET_FILE), JSON.stringify(target, null, 2));
}

// Release machine only: record the fleet target. Hubs read it from /releases.
// registered before the hub-wide JSON parser (like every /api/admin route): parse here
app.post('/api/admin/fleet-target', express.json({ type: () => true, limit: '16kb' }), async (req, res) => {
  if (discovery.selfName !== UPDATE_MACHINE) return res.status(409).json({ error: `the fleet target lives on ${UPDATE_MACHINE}` });
  const b = req.body ?? {};
  const build = Number(b.build);
  if (!Number.isInteger(build) || build < 1) return res.status(400).json({ error: 'build: a positive integer' });
  const target: FleetTarget = {
    build,
    version: String(b.version ?? ''),
    requestedAt: String(b.requestedAt ?? new Date().toISOString()),
    requestedBy: String(b.requestedBy ?? 'unknown'),
  };
  await writeFleetTarget(target);
  res.json(target);
});

/**
 * UPDATE ALL: pin the fleet to the newest published build, then tell every
 * connected hub to update now. A hub that is off catches up when it comes
 * back: it reads the mark at start and every 10 minutes (Updater.followFleetTarget).
 */
app.post('/api/admin/update-all', async (_req, res) => {
  const status = await updater.checkAndStage();
  if (!status.latestBuild) return res.status(502).json({ error: status.error ?? 'release machine not reachable' });
  const target: FleetTarget = {
    build: status.latestBuild,
    version: status.latestVersion ?? '',
    requestedAt: new Date().toISOString(),
    requestedBy: discovery.selfName,
  };
  try {
    if (discovery.selfName === UPDATE_MACHINE) await writeFleetTarget(target);
    else {
      const origin = federation.peerByMachine(UPDATE_MACHINE);
      if (!origin) return res.status(502).json({ error: `${UPDATE_MACHINE} is not connected: the mark could not be left` });
      const out = await federation.forward(origin, '/api/admin/fleet-target', { method: 'POST', body: target });
      if (out.status !== 200) return res.status(502).json({ error: (out.body as { error?: string })?.error ?? `mark refused (${out.status})` });
    }
  } catch (err) {
    return res.status(502).json({ error: `mark: ${err instanceof Error ? err.message : err}` });
  }
  const machines: { machine: string; told: boolean; error?: string }[] = [];
  const seen = new Set([discovery.selfName]);
  const peers = federation.connectedPeers().filter((p) => !seen.has(p.info.machine) && seen.add(p.info.machine));
  // 1. everyone downloads the release while the release machine is still up
  await Promise.all(peers.map((p) => federation.forward(p, '/api/admin/check', { method: 'POST' }).catch(() => null)));
  // 2. then they install it: the release machine goes last of the peers, the
  //    hub that was clicked after everyone (below)
  const ordered = [...peers.filter((p) => p.info.machine !== UPDATE_MACHINE), ...peers.filter((p) => p.info.machine === UPDATE_MACHINE)];
  for (const peer of ordered) {
    try {
      const out = await federation.forward(peer, '/api/admin/update', { method: 'POST' });
      machines.push({ machine: peer.info.machine, told: out.status === 200, ...(out.status === 200 ? {} : { error: `answered ${out.status}` }) });
    } catch (err) {
      machines.push({ machine: peer.info.machine, told: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const offline = federation.machines(discovery.selfName).filter((m) => !m.connected).map((m) => m.machine);
  const selfBehind = VERSION.build > 0 && VERSION.build < target.build;
  res.json({ target, machines: [...machines, { machine: discovery.selfName, told: selfBehind }], offline });
  // this hub last, after the answer is out
  if (selfBehind) {
    savePersisted(manager);
    updater.apply().catch((err) => {
      updater.status.updating = false;
      updater.status.error = err instanceof Error ? err.message : String(err);
      console.error('[updater] apply failed:', err);
    });
  }
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
  savePersisted(manager); // which sessions are live right now — restored after the restart
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
      optionLabel: a.optionLabel,
      terminal: !!a.outputOnlyStatus || undefined,
      install: a.available() ? undefined : a.installCommand,
    })),
  );
});

// Drag-and-drop upload: the browser can't reveal a dropped file's real path, so
// the client sends the bytes here and pastes the saved path into the prompt.
// Registered before the JSON body parser — the body is raw binary.
const DROPS_DIR = join(DATA_DIR, 'drops');

/**
 * sessionAction for the drop routes: same handles (hub id, conversation id or
 * a unique prefix), but a session on another machine gets the raw bytes
 * proxied to and from its hub — the file lives where the session runs.
 */
function dropAction(
  local: (session: HubSession, req: express.Request, res: express.Response) => unknown,
): express.RequestHandler {
  return async (req, res) => {
    const id = String(req.params.id);
    const session = manager.sessions.get(id) ?? manager.byClaudeSessionId(id) ?? byConversationPrefix(id);
    if (session) return local(session, req, res);
    const peer = federation.peerBySession(id);
    if (!peer) return res.status(404).json({ error: 'unknown session' });
    try {
      const out = await federation.forwardRaw(peer, req.originalUrl, {
        method: req.method,
        body: req.method === 'POST' ? (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)) : undefined,
        contentType: req.get('content-type'),
      });
      res.status(out.status).type(out.contentType).send(out.bytes);
    } catch {
      res.status(502).json({ error: `forward to ${peer.info.machine} failed` });
    }
  };
}

app.post(
  '/api/sessions/:id/drop',
  express.raw({ type: () => true, limit: '100mb' }),
  dropAction((session, req, res) => {
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
  }),
);

// The bytes of a dropped file back, by the path the POST answered — the iOS app
// shows attached photos inline. Any session's drop folder on this hub counts:
// the folder is named after the hub id, which changes on every hub restart,
// so a photo from before the restart sits under an older one.
app.get('/api/sessions/:id/drop', dropAction((_session, req, res) => {
  const root = resolve(DROPS_DIR);
  const target = resolve(String(req.query.path ?? ''));
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (!fold(target).startsWith(fold(root) + sep)) return res.status(400).json({ error: 'path is not a dropped file' });
  if (!existsSync(target) || !statSync(target).isFile()) return res.status(404).json({ error: 'no such dropped file' });
  res.sendFile(target, { dotfiles: 'allow' });
}));

// Durable conversation store (lives on STORE_MACHINE, normally vps-node).
// Push route takes raw bytes — registered before the JSON body parser.
// Bodies may be gzipped (Content-Encoding) — express.raw inflates them. A
// request carrying size+sha256 is a verified whole-file or append-only delta
// upload (see applyUpload); without them it is a legacy whole-file push.
app.post(
  '/api/tstore/:folder/:id',
  express.raw({ type: () => true, limit: '400mb', inflate: true }),
  async (req, res) => {
    const mtime = Number(req.query.mtime);
    if (!Number.isFinite(mtime)) return res.status(400).json({ error: 'mtime required' });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const agent = typeof req.query.agent === 'string' ? req.query.agent : undefined;
    const folder = String(req.params.folder);
    const id = String(req.params.id);
    try {
      if (typeof req.query.size === 'string' && typeof req.query.sha256 === 'string') {
        const out = await applyUpload(folder, id, agent, {
          offset: Number(req.query.offset) || 0,
          size: Number(req.query.size),
          sha256: req.query.sha256,
          mtime,
          body,
        });
        if (!out.stored && (out.reason === 'offset-mismatch' || out.reason === 'hash-mismatch' || out.reason === 'size-mismatch')) {
          console.log(`[tstore] ${folder}/${id.slice(0, 8)}: rejected ${out.reason} (have ${out.size} bytes)`);
          return res.status(409).json(out);
        }
        return res.json(out);
      }
      res.json(await saveToStore(folder, id, body, mtime, agent));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

app.get('/api/tstore', async (_req, res) => res.json(await storeCatalog()));

/** What the store holds for one transcript (size, mtime, sha256) — the pusher's delta base. */
app.get('/api/tstore/:folder/:id/meta', async (req, res) => {
  try {
    res.json(
      await storeMeta(
        String(req.params.folder),
        String(req.params.id),
        typeof req.query.agent === 'string' ? req.query.agent : undefined,
      ),
    );
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

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

app.post('/api/hook', makeHookHandler(manager, engine, () => mergedList()));

// Remember each session's latest tool call in the shape other hubs can show:
// the glasses bridge on another machine has no hook payloads of its own.
hookBus.on('hook', (session, event, body) => {
  if (event !== 'PreToolUse' || !body.tool_name) return;
  const input = (body.tool_input ?? {}) as Record<string, unknown>;
  session.lastTool = { name: body.tool_name, summary: summarizeTool(body.tool_name, input), detail: detailOf(input), at: Date.now() };
});

/** The etiquette every fleet session is briefed with (level 1), for humans and agents to read. */
app.get('/api/etiquette', (_req, res) => res.type('text/plain').send(FLEET_RULES));

app.get('/api/sessions', (_req, res) => res.json(mergedList()));

// Forwarded waits ride on a peer's fetch, whose header timeout is 5 minutes —
// every long-poll is capped below that and returns timedOut so callers loop.
const WAIT_DEFAULT_MS = 120_000;
const WAIT_MAX_MS = 240_000;
const clampWait = (v: unknown, fallback = WAIT_DEFAULT_MS) =>
  Math.max(1000, Math.min(WAIT_MAX_MS, Number(v) || fallback));

/** Turn outcome for automation callers: state plus the agent's reply text. */
async function turnResult(session: HubSession, prompt: string | undefined, timedOut: string | null) {
  const reply = !timedOut && prompt && isSettled(session) ? await replyTo(session, prompt) : undefined;
  return { ...session.info(), machine: discovery.selfName, timedOut: timedOut ?? false, reply };
}

app.post('/api/sessions', async (req, res) => {
  const { agentType, name, model, permissionMode, initialPrompt, machine, force, newFolder, wait } = req.body ?? {};
  let cwd: string | undefined = req.body?.cwd;
  // spawn requested on another fleet machine — hand it to the owning hub
  if (machine && machine !== discovery.selfName) {
    const peer = federation.peerByMachine(machine);
    if (!peer) return res.status(502).json({ error: `machine not connected: ${machine}` });
    try {
      const out = await federation.forward(peer, '/api/sessions', {
        method: 'POST',
        body: { cwd, agentType, name, model, permissionMode, initialPrompt, force, newFolder, wait },
      });
      return res.status(out.status).json(out.body);
    } catch {
      return res.status(502).json({ error: `forward to ${machine} failed` });
    }
  }
  if (engineMissing(res, agentType)) return;
  const terminal = !!getAgent(agentType).outputOnlyStatus;
  if (typeof cwd === 'string') cwd = expandHome(cwd);
  // a brand-new project: create its folder under the projects root first
  if (newFolder) {
    const safe = String(newFolder).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
    if (!safe || safe.startsWith('.')) return res.status(400).json({ error: 'bad folder name' });
    if (!existsSync(PROJECTS_ROOT)) {
      return res.status(400).json({ error: `projects root ${PROJECTS_ROOT} does not exist — set HUB_PROJECTS_ROOT` });
    }
    cwd = join(PROJECTS_ROOT, safe);
    mkdirSync(cwd, { recursive: true });
  }
  if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return res.status(400).json({ error: `not a directory: ${cwd}` });
  }
  const folderName = String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  if (!force && !terminal) {
    const busy = liveElsewhere(folderName);
    if (busy.length) return activeElsewhereError(res, busy);
  }
  const session = manager.create({ cwd, agentType, name, model, permissionMode, initialPrompt });
  if (!wait) return res.json({ ...session.info(), machine: discovery.selfName });
  // automation: block until the first turn (the initial prompt, or just the
  // startup) settles, and hand back the reply with the session
  const timeoutMs = clampWait(wait);
  const timedOut = initialPrompt
    ? await waitForTurn(manager, session, { startMs: timeoutMs, totalMs: timeoutMs })
    : (await waitUntil(manager, () => isSettled(session), timeoutMs)) ? null : 'done';
  res.json(await turnResult(session, initialPrompt, timedOut));
});

// Run one command on this machine (or `machine`) and hand back its output and
// exit code: what dh_run calls. It runs in a terminal card named after the
// command, so the user can open it and see what was run. A command still
// running at the timeout keeps running; the caller gets timedOut plus the
// card's hubId to wait on. Fleet etiquette applies: a folder a live agent
// session works in is refused (409) unless the caller passes force after
// agreeing with that session. Anywhere else (home, /opt, …) just runs.
const RUN_OUTPUT_MAX = 100_000;
const RUN_CARDS_KEPT = 10;

app.post('/api/run', async (req, res) => {
  const b = req.body ?? {};
  const machine = typeof b.machine === 'string' && b.machine ? b.machine : undefined;
  if (machine && machine !== discovery.selfName) {
    const peer = federation.peerByMachine(machine);
    if (!peer) return res.status(502).json({ error: `machine not connected: ${machine}` });
    try {
      const out = await federation.forward(peer, '/api/run', { method: 'POST', body: { ...b, machine: undefined } });
      return res.status(out.status).json(out.body);
    } catch {
      return res.status(502).json({ error: `forward to ${machine} failed` });
    }
  }
  const command = typeof b.command === 'string' ? b.command.trim() : '';
  if (!command) return res.status(400).json({ error: 'command required' });
  const cwd = expandHome(typeof b.cwd === 'string' && b.cwd ? b.cwd : '~');
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return res.status(400).json({ error: `not a directory on ${discovery.selfName}: ${cwd}` });
  }
  const folder = projectFolderOf(cwd);
  const owner = folder ? folderOwner(folder, String(b.from ?? ''), mergedList()) : undefined;
  if (owner && !b.force) {
    return res.status(409).json({
      error:
        `${cwd} is in project folder "${folder}", which belongs to the live session "${owner.name}" ` +
        `(${owner.agentType} on ${owner.machine}, hub id ${owner.hubId}). Agree the command with that session ` +
        `first (dh_send_prompt), then run again with force.`,
      owner: { hubId: owner.hubId, name: owner.name, machine: owner.machine },
    });
  }

  // finished run cards are a log; keep the newest few
  const finished = [...manager.sessions.values()]
    .filter((s) => s.command && !s.proc)
    .sort((x, y) => x.stateSince - y.stateSince);
  for (const s of finished.slice(0, Math.max(0, finished.length - (RUN_CARDS_KEPT - 1)))) manager.remove(s.hubId);

  const oneLine = command.replace(/\s+/g, ' ');
  const session = manager.create({
    cwd,
    agentType: 'shell',
    model: runShell(typeof b.shell === 'string' ? b.shell : undefined),
    name: typeof b.name === 'string' && b.name ? b.name : `run: ${oneLine.length > 48 ? oneLine.slice(0, 47) + '…' : oneLine}`,
    command,
  });
  const done = await waitUntil(manager, () => !session.proc, clampWait(b.timeoutMs));
  if (done) await new Promise((r) => setTimeout(r, 300)); // the PTY can deliver its last output after the exit
  let output = session.fullText();
  const truncated = output.length > RUN_OUTPUT_MAX;
  if (truncated) output = output.slice(-RUN_OUTPUT_MAX);
  res.json({
    hubId: session.hubId,
    machine: discovery.selfName,
    cwd,
    shell: session.model,
    exitCode: done ? (session.exitCode ?? null) : null,
    timedOut: !done,
    truncated,
    output,
  });
});

/** A live session whose conversation id starts with `prefix` (8+ chars), if exactly one matches. */
function byConversationPrefix(prefix: string): HubSession | undefined {
  if (prefix.length < 8) return undefined;
  const hits = [...manager.sessions.values()].filter((s) => s.claudeSessionId.startsWith(prefix));
  const live = hits.filter((s) => s.proc);
  const pool = live.length ? live : hits;
  return pool.length === 1 ? pool[0] : undefined;
}

/** Route a per-session action to this hub or the owning peer. */
function sessionAction(
  local: (id: string, req: express.Request, res: express.Response) => unknown,
): express.RequestHandler {
  return async (req, res) => {
    let id = String(req.params.id);
    if (manager.sessions.get(id)) return local(id, req, res);
    // hub ids change on every hub restart and migration; the agent's own
    // conversation id does not — accept it (or a unique prefix) so automation
    // keeps a stable handle on a session
    const byConv = manager.byClaudeSessionId(id) ?? byConversationPrefix(id);
    if (byConv) {
      id = byConv.hubId;
      return local(id, req, res);
    }
    const peer = federation.peerBySession(id);
    if (!peer) return res.status(404).json({ error: 'unknown session' });
    try {
      const out = await federation.forward(peer, req.originalUrl, {
        method: req.method,
        body: Object.keys(req.body ?? {}).length ? req.body : undefined,
      });
      if (typeof out.body === 'string') res.status(out.status).type(out.contentType || 'text/plain').send(out.body);
      else res.status(out.status).json(out.body);
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

app.post('/api/sessions/:id/resume', sessionAction(async (id, req, res) => {
  const existing = manager.sessions.get(id);
  if (!existing) return res.status(404).json({ error: 'unknown session' });
  if (engineMissing(res, existing.agentType)) return;
  const folderName = existing.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  if (!req.body?.force) {
    const busy = liveElsewhere(folderName);
    if (busy.length) return activeElsewhereError(res, busy);
  }
  // The agent keeps its transcript outside the project folder, and its own
  // retention cleanup can remove it. A card whose transcript is gone is still
  // resumable from the fleet store — fetch it back first.
  if (!existing.proc && !existing.claudeSessionId.startsWith('pending-')) {
    const ops = agentFor(existing).transcript;
    if (ops && !existsSync(ops.file(existing.cwd, existing.claudeSessionId))) {
      try {
        await ensureTranscript({
          folder: folderName,
          localPath: existing.cwd,
          agentType: existing.agentType,
          claudeSessionId: existing.claudeSessionId,
          selfName: discovery.selfName,
          federation,
        });
        console.log(`[resume] ${existing.name}: transcript restored from the fleet store`);
      } catch (err) {
        return res.status(409).json({ error: `cannot resume: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }
  const session = manager.resume(id);
  if (!session) return res.status(404).json({ error: 'unknown session' });
  res.json({ ...session.info(), machine: discovery.selfName });
}));

app.post('/api/sessions/:id/remove', sessionAction((id, _req, res) => {
  manager.remove(id);
  res.json({ ok: true });
}));

// ----------------------------------------------------------- Rename
// A session is named after its folder, so renaming a session renames the
// folder — on every machine that holds a copy — and everything keyed by its
// path or name: the agents' conversations and memory, the fleet store, the
// frozen flag, the Syncthing folder, and the cards. Three phases so no machine
// moves anything until every machine has said yes, and Syncthing only
// re-registers once every copy carries the new name.

const FOLDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/;
type RenamePhase = 'check' | 'move' | 'resync';
/** folders this hub took out of Syncthing during a move, to put back in the resync phase */
const unsyncedForRename = new Set<string>();

async function renameFolderHere(fromCwd: string, toName: string, phase: RenamePhase): Promise<string[]> {
  const from = folderNameOf(fromCwd);
  const toCwd = join(dirname(fromCwd), toName);
  const caseOnly = normCwd(fromCwd) === normCwd(toCwd);
  const self = discovery.selfName;
  if (phase === 'check') {
    const live = [...manager.sessions.values()].filter((s) => s.proc && normCwd(s.cwd) === normCwd(fromCwd));
    if (live.length) throw new Error(`${from} has a live session on ${self} (${live.map((s) => s.name).join(', ')}) — stop it first`);
    if (!caseOnly && existsSync(toCwd)) throw new Error(`${toName} already exists on ${self}`);
    return [];
  }
  if (phase === 'resync') {
    if (!unsyncedForRename.delete(from.toLowerCase()) || !sync) return [];
    await sync.registerFolder(toName);
    return ['sync'];
  }
  const done: string[] = [];
  const underRoot = normCwd(dirname(fromCwd)) === normCwd(PROJECTS_ROOT);
  let synced = false;
  if (underRoot && sync) {
    synced = await sync.localFolders().then((fs) => fs.some((f) => f.id === from), () => false);
    if (synced) await sync.unregisterFolder(from);
  }
  if (existsSync(fromCwd)) {
    try {
      await rename(fromCwd, toCwd);
    } catch (err) {
      if (synced && sync) await sync.registerFolder(from).catch(() => {});
      throw new Error(`cannot rename ${from} on ${self}: ${err instanceof Error ? err.message : String(err)}`);
    }
    done.push('folder');
  }
  if (synced) unsyncedForRename.add(toName.toLowerCase());
  for (const agent of listAgents()) {
    if (!agent.transcript?.moveFolder) continue;
    try {
      if (await agent.transcript.moveFolder(fromCwd, toCwd)) done.push(agent.id);
    } catch (err) {
      console.warn(`[rename] ${agent.id} conversations of ${from}: ${err}`);
    }
  }
  if (await moveDir(join(STORE_DIR, from), join(STORE_DIR, toName)).catch(() => false)) done.push('fleet store');
  if (isFrozen(from)) {
    setFrozen(from, false);
    setFrozen(toName, true);
  }
  for (const s of manager.sessions.values()) {
    if (normCwd(s.cwd) !== normCwd(fromCwd)) continue;
    s.cwd = toCwd;
    if (s.name === from) s.name = toName;
    manager.emit('change', s);
  }
  console.log(`[rename] ${from} → ${toName}: ${done.join(', ') || 'nothing here'}`);
  return done;
}

/** Run one phase on this machine and every connected peer; the owner's own folder goes first. */
async function renamePhase(fromCwd: string, toName: string, phase: RenamePhase, entry?: RenameEntry) {
  const fleetWide = !!entry;
  const results: { machine: string; done?: string[]; error?: string }[] = [];
  try {
    results.push({ machine: discovery.selfName, done: await renameFolderHere(fromCwd, toName, phase) });
  } catch (err) {
    results.push({ machine: discovery.selfName, error: err instanceof Error ? err.message : String(err) });
  }
  if (!fleetWide || (phase === 'move' && results[0].error)) return results;
  const seen = new Set([discovery.selfName]);
  for (const peer of federation.connectedPeers()) {
    if (seen.has(peer.info.machine)) continue;
    seen.add(peer.info.machine);
    try {
      const out = await federation.forward(peer, `/api/folders/${encodeURIComponent(folderNameOf(fromCwd))}/rename`, {
        method: 'POST',
        body: { to: toName, phase, entry },
      });
      const body = out.body as { done?: string[]; error?: string };
      results.push({ machine: peer.info.machine, ...(out.status < 300 ? { done: body.done ?? [] } : { error: body.error ?? `HTTP ${out.status}` }) });
    } catch {
      results.push({ machine: peer.info.machine, error: `${peer.info.machine} did not answer` });
    }
  }
  return results;
}

app.post('/api/sessions/:id/rename', sessionAction(async (id, req, res) => {
  const session = manager.sessions.get(id)!;
  const name = String(req.body?.name ?? '').trim();
  if (!FOLDER_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'name: letters, digits, space, dot, dash or underscore (up to 80), starting with a letter or digit' });
  }
  // a terminal claims no folder: only its card is renamed
  if (agentFor(session).ownsFolder === false) {
    session.name = name;
    manager.emit('change', session);
    return res.json({ ...session.info(), machine: discovery.selfName, machines: [] });
  }
  const from = folderNameOf(session.cwd);
  if (name === from) return res.status(400).json({ error: `already named ${name}` });
  const busy = liveElsewhere(from);
  if (busy.length) return res.status(409).json({ error: `${from} has a live session on ${busy.join(', ')} — stop it first` });
  // a folder under the projects root is the fleet's folder of that name; any
  // other folder, or a frozen one, exists only here
  const fleetWide = normCwd(dirname(session.cwd)) === normCwd(PROJECTS_ROOT) && !isFrozen(from);
  const entry = fleetWide ? { id: randomUUID(), from, to: name, at: Date.now(), by: discovery.selfName } : undefined;
  const checks = await renamePhase(session.cwd, name, 'check', entry);
  const refused = checks.filter((r) => r.error);
  if (refused.length) return res.status(409).json({ error: refused.map((r) => r.error).join('; ') });
  const fromCwd = session.cwd;
  const moved = await renamePhase(fromCwd, name, 'move', entry);
  if (moved[0].error) return res.status(409).json({ error: moved[0].error, machines: moved });
  // logged once this machine has moved: whoever is offline catches up from the log
  if (entry) recordRename(entry.from, entry.to, entry.by, entry.id, entry.at);
  void renameProjectMemories(from, name);
  const resynced = await renamePhase(fromCwd, name, 'resync', entry);
  for (const r of resynced) {
    const m = moved.find((x) => x.machine === r.machine);
    if (m && r.done?.length) m.done = [...(m.done ?? []), ...r.done];
    else if (m && r.error) m.error = r.error;
  }
  session.name = name;
  manager.emit('change', session);
  const offline = federation.machines(discovery.selfName).filter((m) => !m.connected).map((m) => m.machine);
  res.json({ ...session.info(), machine: discovery.selfName, machines: moved, offline: fleetWide ? offline : [] });
}));

/** One phase of a fleet-wide folder rename, asked for by the hub that owns the session. */
app.post('/api/folders/:name/rename', async (req, res) => {
  const from = String(req.params.name);
  const to = String(req.body?.to ?? '');
  const phase = String(req.body?.phase ?? '') as RenamePhase;
  if (!FOLDER_NAME_RE.test(from) || !FOLDER_NAME_RE.test(to) || !['check', 'move', 'resync'].includes(phase)) {
    return res.status(400).json({ error: 'bad rename request' });
  }
  const entry = req.body?.entry as RenameEntry | undefined;
  try {
    const done = await renameFolderHere(join(PROJECTS_ROOT, from), to, phase);
    if (phase === 'move' && entry?.id) recordRename(entry.from, entry.to, entry.by, entry.id, entry.at);
    res.json({ done });
  } catch (err) {
    if (phase === 'move' && entry?.id) mergeRenames([entry]); // not done here: catch-up retries it
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// The rename log, for peers catching up. POST logs a rename done by hand.
app.get('/api/renames', (_req, res) => res.json(renameLog()));
app.post('/api/renames', (req, res) => {
  const from = String(req.body?.from ?? '');
  const to = String(req.body?.to ?? '');
  if (!FOLDER_NAME_RE.test(from) || !FOLDER_NAME_RE.test(to) || from === to) return res.status(400).json({ error: 'from and to: folder names' });
  res.json(recordRename(from, to, discovery.selfName));
});

/**
 * Catch up on renames this machine missed while it was offline: copy the log
 * from every peer, then apply each entry not dealt with yet. A folder with a
 * live session waits for the next round; a name already taken here, or a
 * frozen folder (this machine's own, not the fleet's), is left alone.
 */
let catchingUp = false;
async function catchUpRenames() {
  if (catchingUp) return;
  catchingUp = true;
  try {
    const seenMachines = new Set<string>();
    for (const peer of federation.connectedPeers()) {
      if (seenMachines.has(peer.info.machine)) continue;
      seenMachines.add(peer.info.machine);
      try {
        const out = await federation.forward(peer, '/api/renames');
        if (out.status === 200 && Array.isArray(out.body)) mergeRenames(out.body as RenameEntry[]);
      } catch {
        /* peer on an older build, or gone */
      }
    }
    for (const e of unseenRenames()) {
      const fromCwd = join(PROJECTS_ROOT, e.from);
      const toCwd = join(PROJECTS_ROOT, e.to);
      const caseOnly = normCwd(fromCwd) === normCwd(toCwd);
      if (!existsSync(fromCwd) || isFrozen(e.from) || (!caseOnly && existsSync(toCwd))) {
        if (existsSync(fromCwd)) console.warn(`[rename] catch-up: left ${e.from} alone (${isFrozen(e.from) ? 'frozen' : `${e.to} already exists`})`);
        markRenameSeen(e.id);
        continue;
      }
      try {
        await renameFolderHere(fromCwd, e.to, 'check');
        await renameFolderHere(fromCwd, e.to, 'move');
        await renameFolderHere(fromCwd, e.to, 'resync').catch((err) => console.warn(`[rename] catch-up resync ${e.to}: ${err}`));
        markRenameSeen(e.id);
        console.log(`[rename] caught up: ${e.from} → ${e.to} (renamed on ${e.by})`);
      } catch (err) {
        console.warn(`[rename] catch-up ${e.from} → ${e.to} waits: ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    catchingUp = false;
  }
}
setTimeout(() => void catchUpRenames(), 20_000);
setInterval(() => void catchUpRenames(), 60_000);

// ----------------------------------------------------------- Fleet memory
// Small facts shared by every session (see fleetMemory.ts). The store
// machine holds the truth; every hub keeps a replica for recall and briefings.
void initFleetMemory({
  selfName: () => discovery.selfName,
  authorityName: STORE_MACHINE,
  callAuthority: async (path, init) => {
    const peer = federation.peerByMachine(STORE_MACHINE);
    return peer ? federation.forward(peer, path, init) : undefined;
  },
});

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

app.get('/api/memories', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
  try {
    const found = await recall(String(req.query.q ?? ''), limit);
    if (req.query.format === 'text') return res.type('text/plain').send(found.map(formatMemory).join('\n'));
    res.json(found);
  } catch (err) {
    res.status(503).json({ error: errText(err) });
  }
});
app.post('/api/memories', async (req, res) => {
  const b = req.body ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  try {
    res.json(await remember({
      fact: String(b.fact ?? ''),
      scope: str(b.scope),
      machine: str(b.machine),
      project: str(b.project),
      tags: str(b.tags),
      instructed: b.instructed === true,
      originSession: str(b.originSession),
      originMachine: str(b.originMachine) ?? discovery.selfName,
      originFolder: str(b.originFolder),
    }));
  } catch (err) {
    res.status(400).json({ error: errText(err) });
  }
});
app.delete('/api/memories/:id', async (req, res) => {
  try {
    res.json(await forget(String(req.params.id)));
  } catch (err) {
    res.status(404).json({ error: errText(err) });
  }
});
// authority side: replicas send their changes here and pull from /changes
app.post('/api/memories/apply', (req, res) => {
  if (discovery.selfName !== STORE_MACHINE) return res.status(409).json({ error: `memories are kept on ${STORE_MACHINE}` });
  try {
    res.json({ rows: applyOnAuthority(req.body as MemoryOp) });
  } catch (err) {
    res.status(400).json({ error: errText(err) });
  }
});
app.get('/api/memories/changes', (req, res) => {
  if (discovery.selfName !== STORE_MACHINE) return res.status(409).json({ error: `memories are kept on ${STORE_MACHINE}` });
  res.json(changesSince(Number(req.query.since) || 0));
});

// ----------------------------------------------------------- Automation
// Drive a session from a script: read it, type into it, wait on it. Every
// route goes through sessionAction, so a script talks to any hub in the
// fleet and the owning machine answers.

app.get('/api/sessions/:id', sessionAction((id, _req, res) => {
  res.json({ ...manager.sessions.get(id)!.info(), machine: discovery.selfName });
}));

// Submit a prompt. With `wait` (true or a ms budget) the call blocks until
// the turn settles and returns the reply; a WORKING session is refused
// unless `queue` is set (the TUI would stack the prompt behind the current turn).
app.post('/api/sessions/:id/prompt', sessionAction(async (id, req, res) => {
  const session = manager.sessions.get(id)!;
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!text.trim()) return res.status(400).json({ error: 'text required' });
  if (!session.proc) return res.status(409).json({ error: 'session has exited — resume it first' });
  if (session.state === 'WORKING' && !req.body?.queue) {
    return res.status(409).json({ error: 'session is WORKING — wait for it to settle, or pass queue:true' });
  }
  await typePrompt(manager, session, text);
  if (!req.body?.wait) return res.json({ ...session.info(), machine: discovery.selfName });
  const timeoutMs = clampWait(req.body.wait);
  const timedOut = await waitForTurn(manager, session, { startMs: timeoutMs, totalMs: timeoutMs });
  res.json(await turnResult(session, text, timedOut));
}));

// Raw keystrokes: `keys` is a list of named keys (enter, esc, up, down, 1…)
// or literal strings; `data` is sent verbatim. For answering prompts and menus.
app.post('/api/sessions/:id/keys', sessionAction((id, req, res) => {
  const session = manager.sessions.get(id)!;
  if (!session.proc) return res.status(409).json({ error: 'session has exited' });
  const keys: unknown[] = Array.isArray(req.body?.keys) ? req.body.keys : [];
  let data = typeof req.body?.data === 'string' ? req.body.data : '';
  for (const k of keys) {
    if (typeof k !== 'string') continue;
    data += KEYS[k.toLowerCase()] ?? k;
  }
  if (!data) return res.status(400).json({ error: 'keys or data required' });
  manager.write(id, data);
  res.json({ ok: true, sent: data.length });
}));

// Long-poll until the session reaches a state. `until` is a state name,
// `settled` (default: anything but STARTING/WORKING) or `changed` (any
// state other than `from`). Returns timedOut:true instead of erroring so
// callers can simply loop.
app.get('/api/sessions/:id/wait', sessionAction(async (id, req, res) => {
  const session = manager.sessions.get(id)!;
  const until = String(req.query.until ?? 'settled').toUpperCase();
  const from = typeof req.query.from === 'string' ? req.query.from.toUpperCase() : session.state;
  const pred =
    until === 'SETTLED'
      ? () => isSettled(session)
      : until === 'CHANGED'
        ? () => session.state !== from
        : () => session.state === until || (!session.proc && until === 'EXITED');
  const ok = await waitUntil(manager, pred, clampWait(req.query.timeout));
  res.json({ ...session.info(), machine: discovery.selfName, timedOut: !ok });
}));

// The screen as text (default: what a viewer sees; ?scrollback=N adds lines
// above). ?format=ansi returns the exact serialized stream instead.
app.get('/api/sessions/:id/screen', sessionAction((id, req, res) => {
  const session = manager.sessions.get(id)!;
  if (req.query.format === 'ansi') return res.type('text/plain').send(session.snapshot());
  res.type('text/plain').send(screenText(session, Math.min(5000, Number(req.query.scrollback) || 0)));
}));

// The last N question→reply exchanges as JSON (oldest first) — the same
// text the PRINT export renders.
// Hand a file to the user (dh_send_file): the file stays where it is, the
// session's card gets a download link served by this hub, and the glasses
// bridge turns it into a tap-to-download phone push. Links are unguessable
// ids, live until the hub restarts, and pass the hub's normal access check.
const sharedFiles = new Map<string, { abs: string; name: string }>();
const SHARED_KEPT_PER_SESSION = 10;

/** This hub as the phone sees it: its tailnet address when it has one. */
function publicBase(): string {
  const tailnet = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i.address));
  return `http://${tailnet?.address ?? discovery.selfName}:${actualPort}`;
}

app.post('/api/sessions/:id/files', sessionAction((id, req, res) => {
  const session = manager.sessions.get(id)!;
  const raw = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
  if (!raw) return res.status(400).json({ error: 'path required' });
  const expanded = expandHome(raw);
  const abs = isAbsolute(expanded) ? expanded : resolve(session.cwd, expanded);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return res.status(404).json({ error: `not a file on ${discovery.selfName}: ${abs}` });
  }
  const fileId = randomBytes(12).toString('hex');
  const name = typeof req.body?.name === 'string' && req.body.name.trim() ? basename(req.body.name.trim()) : basename(abs);
  sharedFiles.set(fileId, { abs, name });
  const entry = { id: fileId, name, size: statSync(abs).size, at: Date.now(), url: `${publicBase()}/api/shared/${fileId}` };
  for (const old of session.files.slice(SHARED_KEPT_PER_SESSION - 1)) sharedFiles.delete(old.id);
  session.files = [entry, ...session.files].slice(0, SHARED_KEPT_PER_SESSION);
  manager.emit('change', session);
  console.log(`[share] ${session.name}: ${name} (${entry.size} bytes)`);
  res.json(entry);
}));

app.get('/api/shared/:fileId', (req, res) => {
  const f = sharedFiles.get(String(req.params.fileId));
  if (!f) return res.status(404).json({ error: 'unknown or expired file link' });
  if (!existsSync(f.abs)) return res.status(410).json({ error: 'the file is no longer there' });
  res.download(f.abs, f.name, { dotfiles: 'allow' });
});

app.get('/api/sessions/:id/exchanges', sessionAction(async (id, req, res) => {
  const session = manager.sessions.get(id)!;
  const n = Math.max(1, Math.min(200, Number(req.query.n) || 5));
  try {
    const exchanges = await lastExchanges(session, n);
    if (!exchanges) return res.status(404).json({ error: 'this agent keeps no readable transcript' });
    res.json(exchanges);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
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
  if (engineMissing(res, agentType)) return;
  const session = manager.create({ cwd, agentType, name, resumeSessionId: claudeSessionId });
  res.json({ ...session.info(), machine: discovery.selfName });
});

// ------------------------------------------------------------ file browser

/** Directory listing under a machine's projects root (forwarded for peers). */
app.get('/api/files', async (req, res) => {
  const machine = typeof req.query.machine === 'string' ? req.query.machine : undefined;
  const path = typeof req.query.path === 'string' ? req.query.path : '';
  if (machine && machine !== discovery.selfName) {
    const peer = federation.peerByMachine(machine);
    if (!peer) return res.status(502).json({ error: `machine not connected: ${machine}` });
    try {
      const out = await federation.forward(peer, `/api/files?path=${encodeURIComponent(path)}`);
      return res.status(out.status).json(out.body);
    } catch {
      return res.status(502).json({ error: `forward to ${machine} failed` });
    }
  }
  try {
    res.json({ machine: discovery.selfName, root: PROJECTS_ROOT, ...(await listDir(path)) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Raw bytes of one file on THIS machine — browser downloads and hub-to-hub copies. */
app.get('/api/files/raw', (req, res) => {
  const path = typeof req.query.path === 'string' ? req.query.path : '';
  try {
    const abs = safePath(path);
    if (!existsSync(abs) || !statSync(abs).isFile()) return res.status(404).json({ error: 'not a file' });
    res.download(abs, basename(abs), { dotfiles: 'allow' });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** A folder on THIS machine as a zip stream. node_modules and .git are skipped unless ?full=1. */
app.get('/api/files/zip', (req, res) => {
  const path = typeof req.query.path === 'string' ? req.query.path : '';
  try {
    const abs = safePath(path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return res.status(404).json({ error: 'not a folder' });
    const name = basename(abs) || 'projects';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/["\\]/g, '_')}.zip"`);
    zipFolder(abs, name, req.query.full === '1', res);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Copy a file between machines: runs on the TARGET machine, which pulls the
 * bytes from the source hub. { fromMachine, fromPath, toMachine, toDir, overwrite }
 */
app.post('/api/files/copy', async (req, res) => {
  const { fromMachine, fromPath, toMachine, toDir, overwrite } = req.body ?? {};
  if (!fromMachine || !fromPath || !toMachine) {
    return res.status(400).json({ error: 'fromMachine, fromPath and toMachine required' });
  }
  if (toMachine !== discovery.selfName) {
    const peer = federation.peerByMachine(String(toMachine));
    if (!peer) return res.status(502).json({ error: `machine not connected: ${toMachine}` });
    try {
      const out = await federation.forward(peer, '/api/files/copy', {
        method: 'POST',
        body: { fromMachine, fromPath, toMachine, toDir, overwrite },
      });
      return res.status(out.status).json(out.body);
    } catch {
      return res.status(502).json({ error: `forward to ${toMachine} failed` });
    }
  }
  try {
    const name = String(fromPath).split('/').pop() ?? '';
    let out;
    if (fromMachine === discovery.selfName) {
      out = await copyIn({ sourceAbs: safePath(String(fromPath)), toDir: String(toDir ?? ''), name, overwrite: !!overwrite });
    } else {
      const peer = federation.peerByMachine(String(fromMachine));
      if (!peer) return res.status(502).json({ error: `machine not connected: ${fromMachine}` });
      out = await copyIn({
        sourceUrl: `${peer.info.url}/api/files/raw?path=${encodeURIComponent(String(fromPath))}`,
        toDir: String(toDir ?? ''),
        name,
        overwrite: !!overwrite,
      });
    }
    res.json({ ok: true, machine: discovery.selfName, ...out });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
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

/** Force the ignore-rule top-up now (it also runs at every boot). */
app.post('/api/sync/reconcile', async (req, res) => {
  const machine = typeof req.query.machine === 'string' ? req.query.machine : undefined;
  if (machine && machine !== discovery.selfName) {
    const peer = federation.peerByMachine(machine);
    if (!peer) return res.status(502).json({ error: `machine not connected: ${machine}` });
    try {
      const out = await federation.forward(peer, '/api/sync/reconcile', { method: 'POST' });
      return res.status(out.status).json(out.body);
    } catch {
      return res.status(502).json({ error: `forward to ${machine} failed` });
    }
  }
  if (!sync) return res.status(503).json({ error: 'sync not configured on this machine' });
  try {
    res.json({ machine: discovery.selfName, changed: await sync.reconcileIgnores() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/sync/config', (_req, res) => {
  if (!sync) return res.status(404).json({ error: 'sync not configured on this machine' });
  res.json({ vps: sync.cfg.vps });
});

/** Freeze/unfreeze a folder to this machine (forwarded with ?machine=). */
app.post('/api/folders/:name/frozen', async (req, res) => {
  const machine = typeof req.query.machine === 'string' ? req.query.machine : undefined;
  if (machine && machine !== discovery.selfName) {
    const peer = federation.peerByMachine(machine);
    if (!peer) return res.status(502).json({ error: `machine not connected: ${machine}` });
    try {
      const out = await federation.forward(peer, `/api/folders/${encodeURIComponent(String(req.params.name))}/frozen`, {
        method: 'POST',
        body: req.body,
      });
      return res.status(out.status).json(out.body);
    } catch {
      return res.status(502).json({ error: `forward to ${machine} failed` });
    }
  }
  const name = String(req.params.name);
  if (!existsSync(join(PROJECTS_ROOT, name))) return res.status(400).json({ error: `unknown folder: ${name}` });
  const on = !!req.body?.on;
  setFrozen(name, on);
  if (on && sync) await sync.unregisterFolder(name).catch(() => {}); // stop replication that already started
  broadcastSessions();
  res.json({ ok: true, folder: name, frozen: on, machine: discovery.selfName });
});

app.post('/api/sync/register', async (req, res) => {
  const { folder } = req.body ?? {};
  if (!sync) return res.status(503).json({ error: 'sync not configured' });
  if (!folder || !existsSync(join(PROJECTS_ROOT, folder))) {
    return res.status(400).json({ error: `unknown folder: ${folder}` });
  }
  if (isFrozen(String(folder))) {
    return res.status(409).json({ error: `folder ${folder} is frozen to ${discovery.selfName} — it does not leave this machine` });
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
  if (agentFor(manager.sessions.get(id)!).outputOnlyStatus || getAgent(String(b.targetAgent)).outputOnlyStatus) {
    return res.status(400).json({ error: 'a terminal session has no conversation to hand off' });
  }
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
  if (authorize(remoteAddress, req.headers, req.url ?? '/').status !== 0) return socket.destroy();
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

// Even Realities glasses: the Even app's Terminal client pairs with this
// port (even-terminal's default). HUB_EVEN_PORT=0 turns the bridge off.
const EVEN_PORT = process.env.HUB_EVEN_PORT === undefined ? 3456 : Number(process.env.HUB_EVEN_PORT) || 0;

/** A prompt from the glasses with no session and no folder starts here. */
function evenDefaultCwd(): string {
  const dir = process.env.HUB_EVEN_CWD || join(PROJECTS_ROOT, 'glasses');
  mkdirSync(dir, { recursive: true });
  return dir;
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
  // 0.0.0.0 so tailnet peers can reach us; authorize() rejects everything
  // that is not loopback, tailnet or a token-bearing LAN caller.
  httpServer.listen(port, '0.0.0.0', () => {
    actualPort = port;
    manager.identity = { machine: discovery.selfName, hubUrl: `http://127.0.0.1:${port}` };
    // the tailnet name arrives with the first discovery tick; keep the briefing current
    setTimeout(() => (manager.identity.machine = discovery.selfName), 5_000).unref();
    writeHooksJson(port);
    restoreSessions();
    discovery.start();
    loadApiToken();
    if (LAN_ENABLED) {
      startBeacon({
        machine: () => discovery.selfName,
        instanceId: INSTANCE_ID,
        version: VERSION.version,
        build: VERSION.build,
        port,
      });
    }
    if (EVEN_PORT) {
      startEvenBridge(EVEN_PORT, {
        sessions: mergedList,
        hubUrl: () => `http://127.0.0.1:${actualPort}`,
        selfName: () => discovery.selfName,
        defaultCwd: evenDefaultCwd,
        version: `${VERSION.version}+${VERSION.build}`,
      });
    }
    if (!existsSync(PROJECTS_ROOT)) {
      console.warn(
        `[hub] WARNING: projects root ${PROJECTS_ROOT} does not exist — set HUB_PROJECTS_ROOT in hub-env.cmd`,
      );
    }
    console.log(`\n  Deckhand running at http://127.0.0.1:${port} (machine: ${discovery.selfName})\n`);
  });
}

listen(DEFAULT_PORT, 10);
