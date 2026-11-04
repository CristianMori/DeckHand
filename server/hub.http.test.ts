import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';

/**
 * HTTP-level harness for the hub's real Express app (server/index.ts).
 *
 * The security gates — case-sensitive routing with case-insensitive path
 * gates, the cross-site browser refusal, the agent access gate, and the
 * outside-agent-turn refusal — live in index.ts's wiring, which the helpers'
 * unit tests (access.test.ts, needsYou.test.ts) never exercise. This file
 * loads the real index.ts and sends real requests to it.
 *
 * HUB_LISTEN=0 makes index.ts skip its own listen(), so nothing touches port
 * 5959 (a live hub may own it); the harness listens on an ephemeral loopback
 * port instead. A temporary HUB_DATA_DIR keeps tokens, provenance and memory
 * out of real data, HUB_SOLO keeps discovery off the tailnet, and HUB_RESTORE=0
 * plus the skipped listen() callback mean no sessions are spawned or restored.
 */

// Environment before any hub module loads — config.ts reads these at import,
// so they must be set before the dynamic import below (never statically
// import hub modules in this file).
const dataDir = mkdtempSync(join(tmpdir(), 'hub-http-data-'));
const projectsRoot = mkdtempSync(join(tmpdir(), 'hub-http-projects-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.HUB_PROJECTS_ROOT = projectsRoot;
process.env.HUB_LISTEN = '0';
process.env.HUB_RESTORE = '0';
process.env.HUB_SOLO = '1';
process.env.HUB_EVEN_PORT = '0';

const hub = await import('./index.js');
const { loadDelegateKey } = await import('./agentAccess.js');
const { startEvenBridge } = await import('./evenBridge.js');

const port = await new Promise<number>((resolve, reject) => {
  hub.httpServer.once('error', reject);
  hub.httpServer.listen(0, '127.0.0.1', () => resolve((hub.httpServer.address() as AddressInfo).port));
});
const base = `http://127.0.0.1:${port}`;

after(() => {
  hub.httpServer.close();
});

async function req(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json: Record<string, unknown> | unknown[] | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

const errorOf = (r: { json?: unknown }) => String((r.json as { error?: string } | undefined)?.error ?? '');

// --------------------------------------------------------------- path case

test('GET /api/sessions works; mixed-case spellings match no route', async () => {
  const good = await req('GET', '/api/sessions');
  assert.equal(good.status, 200);
  assert.ok(Array.isArray(good.json), 'the session list is an array');

  for (const path of ['/API/sessions', '/Api/sessions']) {
    const get = await req('GET', path);
    assert.equal(get.status, 404, `GET ${path} must match no route`);
    const post = await req('POST', path, { body: {} });
    assert.equal(post.status, 404, `POST ${path} must match no route`);
  }
});

test('POST /api/sessions reaches the real route (refused inside it, not lost)', async () => {
  const r = await req('POST', '/api/sessions', { body: {} });
  assert.equal(r.status, 400, 'the route itself answers (bad request), proving it was matched');
  assert.ok(!/cross-site/i.test(errorOf(r)));
});

test('agent access gate claims mixed-case paths for delegated-agent callers', async () => {
  const key = loadDelegateKey();
  const agentHeaders = { 'x-deckhand-caller': 'gateway:testbot', 'x-deckhand-delegate-key': key };

  // the canonical path answers the agent (empty — nothing is granted) …
  const canonical = await req('GET', '/api/sessions', { headers: agentHeaders });
  assert.equal(canonical.status, 200);
  assert.deepEqual(canonical.json, [], 'no grants: the agent sees no sessions');

  // … and a mixed-case path is still claimed by the gate and refused,
  // never waved past as "not the API"
  const mixed = await req('GET', '/API/sessions', { headers: agentHeaders });
  assert.equal(mixed.status, 403, 'a delegated-agent caller on /API/… is refused by the gate');
  assert.match(errorOf(mixed), /agents may only/i);

  // without the delegate key the gate refuses even earlier
  const noKey = await req('GET', '/API/sessions', { headers: { 'x-deckhand-caller': 'gateway:testbot' } });
  assert.equal(noKey.status, 401);
});

// --------------------------------------------------------------- cross-site

const FOREIGN = 'https://evil.example';

test('state-changing requests with a foreign Origin get 403', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await req(method, '/api/sessions', { headers: { origin: FOREIGN }, body: {} });
    assert.equal(r.status, 403, `${method} with a foreign Origin`);
    assert.match(errorOf(r), /cross-site/i);
  }
});

test('Sec-Fetch-Site: cross-site with no Origin gets 403', async () => {
  const r = await req('POST', '/api/sessions', { headers: { 'sec-fetch-site': 'cross-site' }, body: {} });
  assert.equal(r.status, 403);
  assert.match(errorOf(r), /cross-site/i);
});

test('own origin, tailnet origin, and no headers at all pass the cross-site gate', async () => {
  // /api/renames answers 400 deterministically when the gate lets the request
  // through — unlike /api/sessions it needs no engine installed on the machine
  const cases: Record<string, string>[] = [
    { origin: base }, // the hub's own origin
    { origin: 'http://100.100.1.1:5959' }, // a tailnet address
    {}, // no browser headers: curl, the iOS app, hooks, MCP, federation
  ];
  for (const headers of cases) {
    const r = await req('POST', '/api/renames', { headers, body: {} });
    assert.equal(r.status, 400, `POST with headers ${JSON.stringify(headers)} reaches the route`);
    assert.match(errorOf(r), /from and to/i);
    const d = await req('DELETE', '/api/memories/no-such-id', { headers });
    assert.notEqual(d.status, 403, `DELETE with headers ${JSON.stringify(headers)} passes the gate`);
    assert.ok(!/cross-site/i.test(errorOf(d)));
  }
});

test('GET with a foreign Origin passes (reads are not the risk)', async () => {
  const r = await req('GET', '/api/sessions', { headers: { origin: FOREIGN } });
  assert.equal(r.status, 200);
});

test('WebSocket upgrade: foreign Origin destroyed, no Origin connects', async () => {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/control`, { origin: FOREIGN });
    ws.on('open', () => reject(new Error('a foreign-Origin socket must not connect')));
    ws.on('error', () => resolve()); // the hub destroys the socket before the handshake
  });

  const first = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/control`);
    ws.on('message', (data) => {
      resolve(String(data));
      ws.close();
    });
    ws.on('error', reject);
  });
  assert.equal((JSON.parse(first) as { type: string }).type, 'sessions');
});

// --------------------------------------------------- outside-agent turns

test('a turn begun by an outside agent cannot start workers; the next user turn can', async () => {
  const lead = hub.manager.addExitedRecord({
    agentType: 'claude',
    claudeSessionId: 'conv-outside-agent-turn-1',
    name: 'lead-workers',
    cwd: projectsRoot,
  });
  lead.role = 'architect';
  const asItself = { 'x-deckhand-caller': `session:${lead.hubId}/conv@test` };

  // the current turn began with a gateway prompt (what /prompt records via
  // needsYou.promptFrom before typing, and the next UserPromptSubmit hook starts)
  hub.needsYou.promptFrom(lead, 'gateway:ron', false);
  hub.needsYou.turnStarted(lead);

  const refused = await req('POST', `/api/sessions/${lead.hubId}/workers`, { headers: asItself, body: { task: 'do x' } });
  assert.equal(refused.status, 403);
  assert.match(errorOf(refused), /outside agent/i);

  // a user-started turn (no pending API prompt): the refusal lifts. Swarm.start
  // is stubbed so no real worker (worktree, PTY) is created.
  hub.needsYou.turnStarted(lead);
  const swarm = hub.swarm as unknown as { start: (...args: unknown[]) => Promise<unknown> };
  const realStart = swarm.start;
  swarm.start = async () => ({ session: undefined, info: { ok: true, stubbed: true } });
  try {
    const allowed = await req('POST', `/api/sessions/${lead.hubId}/workers`, { headers: asItself, body: { task: 'do x' } });
    assert.equal(allowed.status, 200);
    assert.equal((allowed.json as { stubbed?: boolean }).stubbed, true);
  } finally {
    swarm.start = realStart;
  }
});

test('a turn begun by Mimir cannot run roles; the next user turn can', async () => {
  const cwd = join(projectsRoot, 'lead-roles');
  mkdirSync(cwd, { recursive: true });
  const lead = hub.manager.addExitedRecord({
    agentType: 'claude',
    claudeSessionId: 'conv-outside-agent-turn-2',
    name: 'lead-roles',
    cwd,
  });
  lead.role = 'architect';
  const asItself = { 'x-deckhand-caller': `session:${lead.hubId}/conv@test` };

  hub.needsYou.promptFrom(lead, 'mimir', false);
  hub.needsYou.turnStarted(lead);

  const refused = await req('POST', `/api/sessions/${lead.hubId}/run-role`, { headers: asItself, body: { role: 'tester' } });
  assert.equal(refused.status, 403);
  assert.match(errorOf(refused), /outside agent/i);

  // user-started turn: past the refusal. The lead's folder is no git
  // repository, so the manual run fails later inside the route (400 from
  // gitHead) — the point is only that the outside-agent gate no longer fires.
  hub.needsYou.turnStarted(lead);
  const allowed = await req('POST', `/api/sessions/${lead.hubId}/run-role`, { headers: asItself, body: { role: 'tester' } });
  assert.notEqual(allowed.status, 403);
  assert.ok(!/outside agent/i.test(errorOf(allowed)));
});

// ------------------------------------------------------------- Even bridge

test('the Even bridge refuses a foreign-Origin POST', async () => {
  const bridge = startEvenBridge(0, {
    sessions: () => [],
    hubUrl: () => base,
    selfName: () => 'test',
    defaultCwd: () => projectsRoot,
    version: 'test',
  });
  await once(bridge, 'listening');
  const evenBase = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
  try {
    const refused = await fetch(`${evenBase}/api/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: FOREIGN },
      body: '{}',
    });
    assert.equal(refused.status, 403, 'foreign-Origin POST to the bridge');

    // without browser headers (the Even app) the same POST reaches the route
    const reached = await fetch(`${evenBase}/api/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(reached.status, 404, 'no such session — but the route answered');
  } finally {
    bridge.close();
  }
});
