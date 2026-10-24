#!/usr/bin/env node
// Deckhand public gateway: a narrow, signed REST front door to the fleet for
// an agent that cannot join the tailnet. Runs beside the hub on the store
// machine (vps-node), listens on 127.0.0.1 only, and is published to the
// internet by Tailscale Funnel (real certificate, no open port). The hub's
// own 5959 never faces the internet.
//
// Every request needs a bearer token AND an HMAC-SHA256 signature over
// method, path, timestamp, nonce and body hash; replays are refused. Only the
// routes below exist, and they reach only sessions in opted-in folders that
// are Claude/Codex agents with auto-yes off.
//
//   node deckhand-gateway.mjs serve
//   node deckhand-gateway.mjs keygen <id>     new key; secrets go to a root-only handoff file
//   node deckhand-gateway.mjs revoke <id>
//   node deckhand-gateway.mjs list
//
// Files (directory from DECKHAND_GATEWAY_DIR, default /etc/deckhand-gateway):
//   keys.json     [{id, tokenSha256, hmacSecret, created, revoked}]   0600
//   config.json   {allowFolders: [...], port, hubUrl, ...}
//   handoff-<id>.txt   the new key's token + secret, for the user to collect, then delete
// Audit log: one JSON line per request in DECKHAND_GATEWAY_LOG (default /var/log/deckhand-gateway/audit.log).
//
// No dependencies.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';

const DIR = process.env.DECKHAND_GATEWAY_DIR || '/etc/deckhand-gateway';
const KEYS_FILE = join(DIR, 'keys.json');
const CONFIG_FILE = join(DIR, 'config.json');
const LOG_FILE = process.env.DECKHAND_GATEWAY_LOG || '/var/log/deckhand-gateway/audit.log';

const DEFAULTS = {
  port: 5990,
  hubUrl: 'http://127.0.0.1:5959',
  /** project folder names whose sessions the gateway may see and prompt */
  allowFolders: [],
  maxBodyBytes: 64 * 1024,
  /** requests per key per minute */
  ratePerMinute: 60,
  replayWindowS: 300,
  /** bad-auth lockout: this many failures from one address within lockWindowS locks it out for lockS */
  lockFailures: 10,
  lockWindowS: 600,
  lockS: 900,
  /** longest a prompt or wait may block */
  maxWaitMs: 15 * 60_000,
};

const readJson = (file, fallback) => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
};
const config = () => ({ ...DEFAULTS, ...readJson(CONFIG_FILE, {}) });
const keys = () => readJson(KEYS_FILE, []);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function writePrivate(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

// ------------------------------------------------------------------ admin CLI

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function keygen(id) {
  if (!ID_RE.test(id ?? '')) throw new Error('key id: lowercase letters, digits and dashes, up to 32');
  const all = keys();
  if (all.some((k) => k.id === id)) throw new Error(`key ${id} exists; pick a new id (rotate = keygen new, then revoke old)`);
  const token = randomBytes(32).toString('base64url');
  const hmacSecret = randomBytes(32).toString('base64url');
  all.push({ id, tokenSha256: sha256(token), hmacSecret, created: new Date().toISOString(), revoked: false });
  writePrivate(KEYS_FILE, JSON.stringify(all, null, 2));
  const handoff = join(DIR, `handoff-${id}.txt`);
  writePrivate(handoff, `key id:      ${id}\ntoken:       ${token}\nhmac secret: ${hmacSecret}\n`);
  if (!existsSync(CONFIG_FILE)) writePrivate(CONFIG_FILE, JSON.stringify({ allowFolders: [] }, null, 2));
  console.log(`key ${id} created. Secrets are in ${handoff} (root only): hand them over, then delete that file.`);
}

function revoke(id) {
  const all = keys();
  const k = all.find((x) => x.id === id);
  if (!k) throw new Error(`no key ${id}`);
  k.revoked = true;
  k.revokedAt = new Date().toISOString();
  writePrivate(KEYS_FILE, JSON.stringify(all, null, 2));
  console.log(`key ${id} revoked (takes effect on the next request).`);
}

function list() {
  for (const k of keys()) console.log(`${k.id}\tcreated ${k.created}\t${k.revoked ? `REVOKED ${k.revokedAt ?? ''}` : 'active'}`);
  console.log(`allowFolders: ${JSON.stringify(config().allowFolders)}`);
}

// ------------------------------------------------------------------- serving

const nonces = new Map(); // nonce -> expiry ms
const failures = new Map(); // address -> [times ms]
const lockedUntil = new Map(); // address -> ms
const rate = new Map(); // key id -> [times ms]

function sweep() {
  const now = Date.now();
  for (const [n, exp] of nonces) if (exp < now) nonces.delete(n);
  for (const [a, until] of lockedUntil) if (until < now) lockedUntil.delete(a);
}
setInterval(sweep, 60_000).unref();

function audit(entry) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true, mode: 0o700 });
    appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch (err) {
    console.error(`[gateway] audit log: ${err.message}`);
  }
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The string the client signs, one field per line. */
export function canonical(method, pathWithQuery, timestamp, nonce, body) {
  return [method.toUpperCase(), pathWithQuery, timestamp, nonce, sha256(body)].join('\n');
}

/** Check bearer + signature + freshness; returns the key id or throws an auth error. */
function authenticate(req, body, cfg) {
  const h = req.headers;
  const bearer = /^Bearer (.+)$/.exec(String(h.authorization ?? ''))?.[1] ?? '';
  const keyId = String(h['x-dh-key'] ?? '');
  const ts = String(h['x-dh-timestamp'] ?? '');
  const nonce = String(h['x-dh-nonce'] ?? '');
  const sig = String(h['x-dh-signature'] ?? '').toLowerCase();
  if (!bearer || !keyId || !ts || !nonce || !sig) throw new AuthError('missing auth headers');
  const key = keys().find((k) => k.id === keyId);
  // compare against a dummy hash when the key is unknown, so timing says nothing
  const tokenOk = safeEqual(sha256(bearer), key?.tokenSha256 ?? sha256('no-such-key'));
  if (!key || key.revoked || !tokenOk) throw new AuthError('bad credentials');
  if (!/^\d{1,12}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > cfg.replayWindowS) throw new AuthError('stale or bad timestamp');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new AuthError('bad nonce');
  const expected = createHmac('sha256', key.hmacSecret).update(canonical(req.method, req.url, ts, nonce, body)).digest('hex');
  if (!safeEqual(sig, expected)) throw new AuthError('bad signature');
  if (nonces.has(`${keyId}:${nonce}`)) throw new AuthError('replayed request');
  nonces.set(`${keyId}:${nonce}`, Date.now() + cfg.replayWindowS * 2000);
  return keyId;
}

class AuthError extends Error {}
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function hub(cfg, method, path, body, timeoutMs = 30_000) {
  const res = await fetch(`${cfg.hubUrl}${path}`, {
    method,
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* text answer */
  }
  if (!res.ok) throw new HttpError(res.status, typeof data === 'object' && data?.error ? data.error : `hub answered ${res.status}`);
  return data;
}

const folderOf = (cwd) => String(cwd ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';

/** May the gateway touch this session? */
function allowed(s, cfg) {
  const folders = new Set(cfg.allowFolders.map((f) => String(f).toLowerCase()));
  return (
    !!s &&
    folders.has(folderOf(s.cwd).toLowerCase()) &&
    (s.agentType === 'claude' || s.agentType === 'codex') &&
    !s.autoYes &&
    s.permissionMode !== 'bypassPermissions'
  );
}

/** Look the session up through the hub (any id form, any machine) and check it is allowed. */
async function allowedSession(cfg, id) {
  if (!/^[A-Za-z0-9-]{4,64}$/.test(id)) throw new HttpError(400, 'bad session id');
  let s;
  try {
    s = await hub(cfg, 'GET', `/api/sessions/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw new HttpError(404, 'unknown session');
    throw err;
  }
  // a session outside the opt-in list looks exactly like one that does not exist
  if (!allowed(s, cfg)) throw new HttpError(404, 'unknown session');
  return s;
}

const pick = (s) => ({
  hubId: s.hubId,
  conversationId: s.claudeSessionId,
  name: s.name,
  folder: folderOf(s.cwd),
  machine: s.machine,
  agentType: s.agentType,
  state: s.state,
  detail: s.detail,
  alive: s.alive,
});

const intParam = (v, def, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : def;
};

/** The allowlist: [method, pattern, handler]. Anything else is 404. */
const ROUTES = [
  ['GET', /^\/v1\/sessions$/, async (cfg) => {
    const all = await hub(cfg, 'GET', '/api/sessions');
    return (Array.isArray(all) ? all : []).filter((s) => allowed(s, cfg)).map(pick);
  }],
  ['GET', /^\/v1\/fleet$/, async (cfg) => {
    const ms = await hub(cfg, 'GET', '/api/fleet');
    return (Array.isArray(ms) ? ms : []).map((m) => ({ machine: m.machine, connected: m.connected, self: m.self }));
  }],
  ['GET', /^\/v1\/agents$/, async (cfg) => hub(cfg, 'GET', '/api/agents')],
  ['GET', /^\/v1\/projects$/, async (cfg) => cfg.allowFolders],
  ['GET', /^\/v1\/sessions\/([^/]+)$/, async (cfg, m) => pick(await allowedSession(cfg, m[1]))],
  ['GET', /^\/v1\/sessions\/([^/]+)\/exchanges$/, async (cfg, m, url) => {
    const s = await allowedSession(cfg, m[1]);
    return hub(cfg, 'GET', `/api/sessions/${s.hubId}/exchanges?n=${intParam(url.searchParams.get('n'), 5, 1, 50)}`);
  }],
  ['GET', /^\/v1\/sessions\/([^/]+)\/last-reply$/, async (cfg, m) => {
    const s = await allowedSession(cfg, m[1]);
    const es = await hub(cfg, 'GET', `/api/sessions/${s.hubId}/exchanges?n=1`);
    return { ...pick(s), exchange: Array.isArray(es) ? (es[0] ?? null) : null };
  }],
  ['GET', /^\/v1\/sessions\/([^/]+)\/screen$/, async (cfg, m) => {
    const s = await allowedSession(cfg, m[1]);
    return { screen: await hub(cfg, 'GET', `/api/sessions/${s.hubId}/screen`) };
  }],
  ['GET', /^\/v1\/sessions\/([^/]+)\/wait$/, async (cfg, m, url) => {
    const s = await allowedSession(cfg, m[1]);
    const t = intParam(url.searchParams.get('timeoutMs'), 60_000, 1_000, cfg.maxWaitMs);
    const until = url.searchParams.get('until') === 'idle' ? 'idle' : 'settled';
    return hub(cfg, 'GET', `/api/sessions/${s.hubId}/wait?until=${until}&timeout=${t}`, undefined, t + 30_000);
  }],
  ['POST', /^\/v1\/sessions\/([^/]+)\/prompt$/, async (cfg, m, _url, body, keyId) => {
    const s = await allowedSession(cfg, m[1]);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HttpError(400, 'text is required');
    if (text.length > 20_000) throw new HttpError(400, 'text is over 20000 characters');
    const out = { text: `[Deckhand gateway, key ${keyId}] ${text}`, queue: body.queue === true };
    if (body.waitMs !== undefined) out.wait = intParam(body.waitMs, 0, 0, cfg.maxWaitMs);
    const r = await hub(cfg, 'POST', `/api/sessions/${s.hubId}/prompt`, out, (out.wait ?? 0) + 30_000);
    return { ...pick({ ...s, ...r }), reply: r.reply ?? null, timedOut: !!r.timedOut };
  }],
  ['GET', /^\/v1\/memories$/, async (cfg, _m, url) => {
    const q = url.searchParams.get('q') ?? '';
    return hub(cfg, 'GET', `/api/memories?q=${encodeURIComponent(q.slice(0, 200))}&limit=${intParam(url.searchParams.get('limit'), 20, 1, 50)}`);
  }],
  ['POST', /^\/v1\/memories$/, async (cfg, _m, _url, body, keyId) => {
    const fact = typeof body.fact === 'string' ? body.fact.trim() : '';
    if (!fact) throw new HttpError(400, 'fact is required');
    const scope = body.scope === 'project' ? 'project' : 'global';
    const project = scope === 'project' ? String(body.project ?? '') : undefined;
    if (scope === 'project' && !cfg.allowFolders.some((f) => f.toLowerCase() === project.toLowerCase())) {
      throw new HttpError(400, 'project must be one of the opted-in folders');
    }
    return hub(cfg, 'POST', '/api/memories', {
      fact,
      scope,
      project,
      tags: typeof body.tags === 'string' ? body.tags : '',
      instructed: false,
      originSession: `gateway:${keyId}`,
      originMachine: `gateway:${keyId}`,
    });
  }],
];

function clientAddress(req) {
  // only Funnel reaches the loopback listener; it names the real caller here
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || '?';
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

async function handle(req, res) {
  const started = Date.now();
  const cfg = config();
  const addr = clientAddress(req);
  const log = { ip: addr, method: req.method, path: (req.url ?? '').split('?')[0] };
  const finish = (status, data, extra = {}) => {
    send(res, status, data);
    audit({ ...log, status, ms: Date.now() - started, ...extra });
  };

  if ((lockedUntil.get(addr) ?? 0) > Date.now()) return finish(429, { error: 'locked out after repeated bad auth; try later' }, { locked: true });

  // body, capped
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > cfg.maxBodyBytes) return finish(413, { error: `body over ${cfg.maxBodyBytes} bytes` });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks);

  let keyId;
  try {
    keyId = authenticate(req, raw, cfg);
  } catch (err) {
    const now = Date.now();
    const recent = (failures.get(addr) ?? []).filter((t) => t > now - cfg.lockWindowS * 1000);
    recent.push(now);
    failures.set(addr, recent);
    if (recent.length >= cfg.lockFailures) lockedUntil.set(addr, now + cfg.lockS * 1000);
    return finish(401, { error: 'unauthorized' }, { authError: err.message, key: String(req.headers['x-dh-key'] ?? '').slice(0, 40) });
  }
  log.key = keyId;
  failures.delete(addr);

  const window = (rate.get(keyId) ?? []).filter((t) => t > Date.now() - 60_000);
  if (window.length >= cfg.ratePerMinute) return finish(429, { error: 'rate limit' });
  window.push(Date.now());
  rate.set(keyId, window);

  const url = new URL(req.url ?? '/', 'http://gateway');
  const route = ROUTES.find(([method, re]) => method === req.method && re.test(url.pathname));
  if (!route) return finish(404, { error: 'no such route' });
  let body = {};
  if (raw.length) {
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return finish(400, { error: 'body is not JSON' });
    }
  }
  try {
    const data = await route[2](cfg, url.pathname.match(route[1]), url, body ?? {}, keyId);
    finish(200, data, req.method === 'POST' ? { text: String(body.text ?? body.fact ?? '').slice(0, 200) } : {});
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 502;
    finish(status, { error: err instanceof HttpError ? err.message : 'hub unreachable' }, status === 502 ? { hubError: String(err?.message ?? err) } : {});
  }
}

function serve() {
  const cfg = config();
  if (!keys().some((k) => !k.revoked)) console.warn('[gateway] no active keys: every request will be refused');
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[gateway]', err);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    });
  });
  server.requestTimeout = cfg.maxWaitMs + 60_000;
  server.listen(cfg.port, '127.0.0.1', () => console.log(`[gateway] listening on 127.0.0.1:${cfg.port}, hub ${cfg.hubUrl}, folders ${JSON.stringify(cfg.allowFolders)}`));
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'serve') serve();
  else if (cmd === 'keygen') keygen(arg);
  else if (cmd === 'revoke') revoke(arg);
  else if (cmd === 'list') list();
  else console.log('usage: deckhand-gateway.mjs serve | keygen <id> | revoke <id> | list');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
