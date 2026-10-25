#!/usr/bin/env node
// Deckhand public gateway: a narrow, signed and end-to-end encrypted REST
// front door to the fleet for an agent that cannot join the tailnet. Runs
// beside the hub on the store machine (vps-node), listens on 127.0.0.1 only,
// and is published to the internet by Tailscale Funnel (real certificate, no
// open port). The hub's own 5959 never faces the internet.
//
// Trust is set up once: the operator mints a one-time bootstrap token (one
// minute, single use, good only for POST /enroll); the client enrolls its own
// Ed25519 + X25519 public keys with it and gets the gateway's back. No private
// key ever crosses the wire. From then on every request is Ed25519-signed
// (replays refused) and every body travels sealed to the other side's X25519
// key (see wire.mjs). Only the routes below exist, and they reach only
// Claude/Codex sessions without auto-yes, in folders the user's trust entries
// in fleet memory grant that client.
//
//   node deckhand-gateway.mjs serve
//   node deckhand-gateway.mjs bootstrap <id>   one-time enrollment token (revokes <id>'s current key)
//   node deckhand-gateway.mjs revoke <id>      delete <id>'s enrolled key: locked out on the next request
//   node deckhand-gateway.mjs list
//   node deckhand-gateway.mjs requests          access requests, as JSON (the hub's admin view reads this)
//   node deckhand-gateway.mjs accept <request>  the requester then has one minute to mint its token
//   node deckhand-gateway.mjs reject <request>
//
// An agent without a token can ASK: POST /access-requests (plain JSON) files a
// request that the user accepts or rejects in the Deckhand admin view. The
// requester polls GET /access-requests/<id> with the secret it got back; once
// accepted it has one minute to POST /access-requests/<id>/mint, which hands it
// a bootstrap token (single use, one minute) for /enroll.
//
// Files (directory from DECKHAND_GATEWAY_DIR, default /etc/deckhand-gateway), all 0600:
//   server-keys.json   the gateway's static Ed25519 + X25519 private keys
//   clients.json       enrolled clients: [{id, ed25519, x25519, enrolledAt}] (public keys)
//   bootstrap.json     pending tokens: [{id, tokenSha256, expiresAt}]
//   bootstrap-<id>.txt the token for the user to hand over (delete once handed over)
//   requests.json      access requests: [{id, clientId, name, reason, ip, status, ...}]
//   config.json        {port, hubUrl, publicUrl, limits...}
// Which sessions a client reaches is not configured here: it comes from the
// user's trust entries in fleet memory (see trustFor).
// Audit log: one JSON line per request in DECKHAND_GATEWAY_LOG (default /var/log/deckhand-gateway/audit.log).
//
// No dependencies.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import {
  b64u,
  newKeyPair,
  open,
  privateFromJwk,
  privateToJwk,
  publicFromRaw,
  rawPublic,
  requestCanonical,
  responseCanonical,
  seal,
  signText,
  verifyText,
} from './wire.mjs';

const DIR = process.env.DECKHAND_GATEWAY_DIR || '/etc/deckhand-gateway';
const SERVER_KEYS = join(DIR, 'server-keys.json');
const CLIENTS = join(DIR, 'clients.json');
const BOOTSTRAP = join(DIR, 'bootstrap.json');
const CONFIG_FILE = join(DIR, 'config.json');
const LOG_FILE = process.env.DECKHAND_GATEWAY_LOG || '/var/log/deckhand-gateway/audit.log';
/** a bootstrap token is good for one minute after it is minted */
const BOOTSTRAP_TTL_MS = 60_000;
const REQUESTS = join(DIR, 'requests.json');
/** after the user accepts, how long the requester has to mint its token */
const MINT_WINDOW_MS = 60_000;
const MAX_OPEN_REQUESTS = 20;
const REQUESTS_PER_IP_PER_HOUR = 3;
/** decided requests are kept this long, then dropped */
const REQUEST_KEEP_MS = 30 * 24 * 3600_000;

const DEFAULTS = {
  port: 5990,
  hubUrl: 'http://127.0.0.1:5959',
  /** public base URL, written into the bootstrap file for the client */
  publicUrl: '',
  maxBodyBytes: 64 * 1024,
  /** requests per client per minute */
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
const clients = () => readJson(CLIENTS, []);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function writePrivate(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** The gateway's own static keys, created on first use. */
function serverKeys() {
  let j = readJson(SERVER_KEYS, null);
  if (!j) {
    j = { ed25519: privateToJwk(newKeyPair('ed25519').privateKey), x25519: privateToJwk(newKeyPair('x25519').privateKey), created: new Date().toISOString() };
    writePrivate(SERVER_KEYS, JSON.stringify(j, null, 2));
  }
  const edPriv = privateFromJwk(j.ed25519);
  const xPriv = privateFromJwk(j.x25519);
  const edPub = publicFromRaw(j.ed25519.x, 'Ed25519');
  const xPub = publicFromRaw(j.x25519.x, 'X25519');
  return { edPriv, edPub, xPriv, xPub, edRaw: b64u(rawPublic(edPub)), xRaw: b64u(rawPublic(xPub)) };
}

// ------------------------------------------------------------------ admin CLI

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A one-time enrollment token for `id` (single use, one minute). Re-minting locks `id`'s current key out. */
function mintToken(id, via) {
  if (!ID_RE.test(id ?? '')) throw new Error('client id: lowercase letters, digits and dashes, up to 32');
  // re-bootstrapping locks the current key out now, not after enrollment
  const enrolled = clients();
  const revokedPrevious = enrolled.some((c) => c.id === id);
  if (revokedPrevious) writePrivate(CLIENTS, JSON.stringify(enrolled.filter((c) => c.id !== id), null, 2));
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + BOOTSTRAP_TTL_MS;
  const pending = readJson(BOOTSTRAP, []).filter((b) => b.id !== id && b.expiresAt > Date.now());
  pending.push({ id, tokenSha256: sha256(token), expiresAt });
  writePrivate(BOOTSTRAP, JSON.stringify(pending, null, 2));
  audit({ event: 'bootstrap', client: id, via, expiresAt: new Date(expiresAt).toISOString(), revokedPrevious });
  return { token, expiresAt, revokedPrevious };
}

function bootstrap(id) {
  const keys = serverKeys();
  const { token, expiresAt, revokedPrevious } = mintToken(id, 'cli');
  const handoff = join(DIR, `bootstrap-${id}.txt`);
  const cfg = config();
  writePrivate(
    handoff,
    [
      `client id:        ${id}`,
      `bootstrap token:  ${token}`,
      `expires:          ${new Date(expiresAt).toISOString()} (single use, POST /enroll only)`,
      `gateway url:      ${cfg.publicUrl || '(see publicUrl in config.json)'}`,
      `gateway ed25519:  ${keys.edRaw}`,
      `gateway x25519:   ${keys.xRaw}`,
      '',
    ].join('\n'),
  );
  console.log(`bootstrap token for ${id} written to ${handoff} (root only), expires ${new Date(expiresAt).toISOString()}.`);
  if (revokedPrevious) console.log(`${id}'s previous key is revoked.`);
}

// ------------------------------------------------------------ access requests

/** Requests, with accepted ones whose mint window passed marked expired. */
function requests() {
  const now = Date.now();
  const all = readJson(REQUESTS, []);
  let changed = false;
  for (const r of all) {
    if (r.status === 'accepted' && r.mintUntil < now) {
      r.status = 'expired';
      changed = true;
    }
  }
  const kept = all.filter((r) => ['pending', 'accepted'].includes(r.status) || now - Date.parse(r.decidedAt ?? r.createdAt) < REQUEST_KEEP_MS);
  if (changed || kept.length !== all.length) writePrivate(REQUESTS, JSON.stringify(kept, null, 2));
  return kept;
}

const saveRequests = (all) => writePrivate(REQUESTS, JSON.stringify(all, null, 2));
const publicRequest = ({ secretSha256, ...r }) => r;

function decide(requestId, status) {
  const all = requests();
  const r = all.find((x) => x.id === requestId);
  if (!r) throw new Error(`no request ${requestId}`);
  if (status === 'accepted' && r.status !== 'pending') throw new Error(`request ${requestId} is ${r.status}, not pending`);
  if (status === 'rejected' && !['pending', 'accepted'].includes(r.status)) throw new Error(`request ${requestId} is already ${r.status}`);
  r.status = status;
  r.decidedAt = new Date().toISOString();
  if (status === 'accepted') r.mintUntil = Date.now() + MINT_WINDOW_MS;
  saveRequests(all);
  audit({ event: status === 'accepted' ? 'accept' : 'reject', client: r.clientId, request: r.id });
  console.log(JSON.stringify(publicRequest(r)));
}

/** POST /access-requests: anyone may ask; the user decides. */
function fileRequest(raw, addr) {
  let b;
  try {
    b = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'body: {"clientId": "...", "name": "...", "reason": "..."}');
  }
  const clientId = String(b.clientId ?? '').toLowerCase();
  if (!ID_RE.test(clientId)) throw new HttpError(400, 'clientId: lowercase letters, digits and dashes, up to 32');
  const name = String(b.name ?? '').trim().slice(0, 80);
  const reason = String(b.reason ?? '').trim().slice(0, 500);
  if (!name || !reason) throw new HttpError(400, 'name and reason are required');
  if (clients().some((c) => c.id === clientId)) throw new HttpError(409, `${clientId} is already enrolled`);
  const all = requests();
  const open = all.filter((r) => ['pending', 'accepted'].includes(r.status));
  if (open.some((r) => r.clientId === clientId)) throw new HttpError(409, `a request for ${clientId} is already open`);
  if (open.length >= MAX_OPEN_REQUESTS) throw new HttpError(429, 'too many open requests; try later');
  if (all.filter((r) => r.ip === addr && Date.now() - Date.parse(r.createdAt) < 3600_000).length >= REQUESTS_PER_IP_PER_HOUR) {
    throw new HttpError(429, 'too many requests from this address; try later');
  }
  const secret = randomBytes(32).toString('base64url');
  const r = { id: randomUUID(), clientId, name, reason, ip: addr, createdAt: new Date().toISOString(), status: 'pending', secretSha256: sha256(secret) };
  saveRequests([...all, r]);
  return { requestId: r.id, clientId, secret, status: 'pending', poll: `/access-requests/${r.id}`, mint: `/access-requests/${r.id}/mint` };
}

/** The request this secret belongs to, or an auth error. */
function ownRequest(req, requestId) {
  const secret = /^Request (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
  const all = requests();
  const r = all.find((x) => x.id === requestId);
  if (!r || !secret || !safeEqual(sha256(secret), r.secretSha256)) throw new AuthError('bad request secret');
  return { r, all };
}

/** POST /access-requests/<id>/mint: inside the minute after acceptance, a bootstrap token. */
function mintForRequest(req, requestId, keys) {
  const { r, all } = ownRequest(req, requestId);
  if (r.status !== 'accepted') throw new HttpError(409, `request is ${r.status}`);
  const { token, expiresAt } = mintToken(r.clientId, `request ${r.id}`);
  r.status = 'minted';
  r.mintedAt = new Date().toISOString();
  saveRequests(all);
  return { requestId: r.id, clientId: r.clientId, token, expiresAt: new Date(expiresAt).toISOString(), enroll: '/enroll', gateway: { ed25519: keys.edRaw, x25519: keys.xRaw } };
}

function revoke(id) {
  const enrolled = clients();
  const pending = readJson(BOOTSTRAP, []);
  if (!enrolled.some((c) => c.id === id) && !pending.some((b) => b.id === id)) throw new Error(`no client ${id}`);
  writePrivate(CLIENTS, JSON.stringify(enrolled.filter((c) => c.id !== id), null, 2));
  writePrivate(BOOTSTRAP, JSON.stringify(pending.filter((b) => b.id !== id), null, 2));
  rmSync(join(DIR, `bootstrap-${id}.txt`), { force: true });
  audit({ event: 'revoke', client: id });
  console.log(`${id} revoked: its key and any pending bootstrap token are gone (takes effect on the next request).`);
}

function list() {
  const keys = serverKeys();
  console.log(`gateway ed25519 ${keys.edRaw}\ngateway x25519  ${keys.xRaw}`);
  for (const c of clients()) console.log(`client ${c.id}\tenrolled ${c.enrolledAt}`);
  for (const b of readJson(BOOTSTRAP, [])) console.log(`pending ${b.id}\texpires ${new Date(b.expiresAt).toISOString()}${b.expiresAt < Date.now() ? ' (expired)' : ''}`);
  console.log('access: from trust entries in fleet memory (tags trusted-agent, client:<id>|client:*, folders:*|folders:A,B)');
}

// ------------------------------------------------------------------- serving

const nonces = new Map(); // client:nonce -> expiry ms
const failures = new Map(); // address -> [times ms]
const lockedUntil = new Map(); // address -> ms
const rate = new Map(); // client id -> [times ms]

setInterval(() => {
  const now = Date.now();
  for (const [n, exp] of nonces) if (exp < now) nonces.delete(n);
  for (const [a, until] of lockedUntil) if (until < now) lockedUntil.delete(a);
}, 60_000).unref();

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

class AuthError extends Error {}
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** POST /enroll: trade a bootstrap token for a client entry. Returns the response object. */
function enroll(req, raw, keys) {
  const token = /^Bootstrap (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
  if (!token) throw new AuthError('missing bootstrap token');
  const pending = readJson(BOOTSTRAP, []);
  const hash = sha256(token);
  let match;
  for (const b of pending) if (safeEqual(hash, b.tokenSha256)) match = b; // look at every entry: no early exit
  if (!match) throw new AuthError('unknown bootstrap token');
  if (match.expiresAt < Date.now()) throw new AuthError('bootstrap token expired');
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
    publicFromRaw(body.ed25519, 'Ed25519');
    publicFromRaw(body.x25519, 'X25519');
  } catch {
    throw new HttpError(400, 'body: {"ed25519": "<32-byte public key, base64url>", "x25519": "<same>"}');
  }
  // burn first, then enroll
  writePrivate(BOOTSTRAP, JSON.stringify(pending.filter((b) => b !== match), null, 2));
  rmSync(join(DIR, `bootstrap-${match.id}.txt`), { force: true });
  const entry = { id: match.id, ed25519: body.ed25519, x25519: body.x25519, enrolledAt: new Date().toISOString() };
  writePrivate(CLIENTS, JSON.stringify([...clients().filter((c) => c.id !== match.id), entry], null, 2));
  return { clientId: match.id, gateway: { ed25519: keys.edRaw, x25519: keys.xRaw } };
}

/** Check the signature, freshness and nonce; returns the client entry. */
function authenticate(req, raw, cfg) {
  const h = req.headers;
  const id = String(h['x-dh-client'] ?? '');
  const ts = String(h['x-dh-timestamp'] ?? '');
  const nonce = String(h['x-dh-nonce'] ?? '');
  const sig = String(h['x-dh-signature'] ?? '');
  if (!id || !ts || !nonce || !sig) throw new AuthError('missing auth headers');
  const client = clients().find((c) => c.id === id);
  if (!client) throw new AuthError('unknown client');
  if (!/^\d{1,12}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > cfg.replayWindowS) throw new AuthError('stale or bad timestamp');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new AuthError('bad nonce');
  const ok = verifyText(publicFromRaw(client.ed25519, 'Ed25519'), requestCanonical(req.method, req.url, ts, nonce, raw), sig);
  if (!ok) throw new AuthError('bad signature');
  if (nonces.has(`${id}:${nonce}`)) throw new AuthError('replayed request');
  nonces.set(`${id}:${nonce}`, Date.now() + cfg.replayWindowS * 2000);
  return { client, nonce };
}

/** the request being served: its audit id and client, handed to the hub for its provenance log */
const trace = new AsyncLocalStorage();

async function hub(cfg, method, path, body, timeoutMs = 30_000) {
  const t = trace.getStore();
  const traceHeaders = t ? { 'X-Deckhand-Request': t.req, 'X-Deckhand-Caller': `gateway:${t.client}`, 'X-Deckhand-Via': 'gateway' } : {};
  const res = await fetch(`${cfg.hubUrl}${path}`, {
    method,
    headers: { Accept: 'application/json', ...traceHeaders, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
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

/**
 * What a client may reach, read from fleet memory on every request: the trust
 * entries the user made (instructed, never written by a gateway client),
 * tagged `trusted-agent`, naming the client (`client:<id>`, or `client:*` for
 * every gateway client) and the folders (`folders:*`, or `folders:A,B`; none
 * given = every folder). No entry, no access; forgetting it revokes.
 */
async function trustFor(cfg, clientId) {
  const found = await hub(cfg, 'GET', `/api/memories?q=${encodeURIComponent('trusted-agent')}&limit=200`);
  const access = { all: false, folders: new Set(), entries: [] };
  for (const m of Array.isArray(found) ? found : []) {
    const tags = String(m.tags ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    const byGateway = String(m.originMachine ?? '').startsWith('gateway:') || String(m.originSession ?? '').startsWith('gateway:');
    if (!m.instructed || m.deleted || byGateway || !tags.includes('trusted-agent')) continue;
    if (!tags.includes(`client:${clientId.toLowerCase()}`) && !tags.includes('client:*')) continue;
    access.entries.push(m.id);
    // folder lists may span several tags: folders:A,B arrives split into "folders:a" and "b"
    const raw = String(m.tags ?? '').match(/folders:([^\s]+)/i)?.[1];
    if (!raw || raw === '*') access.all = true;
    else for (const f of raw.split(',').filter(Boolean)) access.folders.add(f.toLowerCase());
  }
  return access;
}

/** May the gateway touch this session, for the client being served? */
function allowed(s) {
  const access = trace.getStore()?.access;
  return (
    !!s &&
    !!access &&
    (access.all || access.folders.has(folderOf(s.cwd).toLowerCase())) &&
    // agent sessions only (a terminal would run the text as a command); auto-yes
    // and bypass-permissions sessions are visible too: the user's choice
    (s.agentType === 'claude' || s.agentType === 'codex')
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
  // a session outside the client's trust looks exactly like one that does not exist
  if (!allowed(s)) throw new HttpError(404, 'unknown session');
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
    return (Array.isArray(all) ? all : []).filter((s) => allowed(s)).map(pick);
  }],
  ['GET', /^\/v1\/fleet$/, async (cfg) => {
    const ms = await hub(cfg, 'GET', '/api/fleet');
    return (Array.isArray(ms) ? ms : []).map((m) => ({ machine: m.machine, connected: m.connected, self: m.self }));
  }],
  ['GET', /^\/v1\/agents$/, async (cfg) => hub(cfg, 'GET', '/api/agents')],
  ['GET', /^\/v1\/projects$/, async (cfg) => {
    // the folders this client's trust reaches that have a session in them
    const all = await hub(cfg, 'GET', '/api/sessions');
    return [...new Set((Array.isArray(all) ? all : []).filter((s) => allowed(s)).map((s) => folderOf(s.cwd)))].sort();
  }],
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
  ['POST', /^\/v1\/sessions\/([^/]+)\/prompt$/, async (cfg, m, _url, body, clientId) => {
    const s = await allowedSession(cfg, m[1]);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HttpError(400, 'text is required');
    if (text.length > 20_000) throw new HttpError(400, 'text is over 20000 characters');
    const out = { text: `[Deckhand gateway, client ${clientId}] ${text}`, queue: body.queue === true };
    if (body.waitMs !== undefined) out.wait = intParam(body.waitMs, 0, 0, cfg.maxWaitMs);
    const r = await hub(cfg, 'POST', `/api/sessions/${s.hubId}/prompt`, out, (out.wait ?? 0) + 30_000);
    return { ...pick({ ...s, ...r }), reply: r.reply ?? null, timedOut: !!r.timedOut };
  }],
  ['GET', /^\/v1\/memories$/, async (cfg, _m, url) => {
    const q = url.searchParams.get('q') ?? '';
    return hub(cfg, 'GET', `/api/memories?q=${encodeURIComponent(q.slice(0, 200))}&limit=${intParam(url.searchParams.get('limit'), 20, 1, 50)}`);
  }],
  ['POST', /^\/v1\/memories$/, async (cfg, _m, _url, body, clientId) => {
    const fact = typeof body.fact === 'string' ? body.fact.trim() : '';
    if (!fact) throw new HttpError(400, 'fact is required');
    const scope = body.scope === 'project' ? 'project' : 'global';
    const project = scope === 'project' ? String(body.project ?? '') : undefined;
    const access = trace.getStore()?.access;
    if (scope === 'project' && !(access?.all || access?.folders.has(project.toLowerCase()))) {
      throw new HttpError(400, 'project must be a folder this client is trusted with');
    }
    return hub(cfg, 'POST', '/api/memories', {
      fact,
      scope,
      project,
      tags: typeof body.tags === 'string' ? body.tags : '',
      instructed: false,
      originSession: `gateway:${clientId}`,
      originMachine: `gateway:${clientId}`,
    });
  }],
];

function clientAddress(req) {
  // only Funnel reaches the loopback listener; it names the real caller here
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || '?';
}

const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

/** Before a client is known: plain JSON, unsigned. */
function sendPlain(res, status, data) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/** To an authenticated client: sealed to its X25519 key and signed by the gateway. */
function sendSealed(res, status, data, client, nonce, keys) {
  const body = seal(JSON.stringify(data), publicFromRaw(client.x25519, 'X25519'), { direction: 'response', methodOrStatus: String(status), nonce });
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'X-DH-Nonce': nonce,
    'X-DH-Signature': signText(keys.edPriv, responseCanonical(status, nonce, body)),
  });
  res.end(body);
}

function noteFailure(addr, cfg) {
  const now = Date.now();
  const recent = (failures.get(addr) ?? []).filter((t) => t > now - cfg.lockWindowS * 1000);
  recent.push(now);
  failures.set(addr, recent);
  if (recent.length >= cfg.lockFailures) lockedUntil.set(addr, now + cfg.lockS * 1000);
}

async function handle(req, res, keys) {
  const started = Date.now();
  const cfg = config();
  const addr = clientAddress(req);
  const log = { req: randomUUID(), ip: addr, method: req.method, path: (req.url ?? '').split('?')[0] };
  const done = (status, extra = {}) => audit({ ...log, status, ms: Date.now() - started, ...extra });

  if ((lockedUntil.get(addr) ?? 0) > Date.now()) {
    sendPlain(res, 429, { error: 'locked out after repeated bad auth; try later' });
    return done(429, { locked: true });
  }

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > cfg.maxBodyBytes) {
      sendPlain(res, 413, { error: `body over ${cfg.maxBodyBytes} bytes` });
      return done(413);
    }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks);

  // access requests: unauthenticated by nature, answered in plain JSON
  const ar = /^\/access-requests(?:\/([0-9a-f-]{36})(\/mint)?)?$/.exec(req.url ?? '');
  if (ar) {
    try {
      let status = 200;
      let out;
      if (req.method === 'POST' && !ar[1]) {
        out = fileRequest(raw, addr);
        status = 202;
      } else if (req.method === 'GET' && ar[1] && !ar[2]) {
        const { r } = ownRequest(req, ar[1]);
        out = { requestId: r.id, clientId: r.clientId, status: r.status, ...(r.mintUntil ? { mintUntil: new Date(r.mintUntil).toISOString() } : {}) };
      } else if (req.method === 'POST' && ar[1] && ar[2]) {
        out = mintForRequest(req, ar[1], keys);
      } else {
        throw new HttpError(404, 'no such route');
      }
      sendPlain(res, status, out);
      return done(status, { event: 'access-request', client: out.clientId, request: out.requestId });
    } catch (err) {
      if (err instanceof AuthError) noteFailure(addr, cfg);
      const status = err instanceof HttpError ? err.status : 401;
      sendPlain(res, status, { error: status === 401 ? 'unauthorized' : err.message });
      return done(status, { event: 'access-request', request: ar[1], authError: err.message });
    }
  }

  if (req.method === 'POST' && req.url === '/enroll') {
    try {
      const out = enroll(req, raw, keys);
      failures.delete(addr);
      sendPlain(res, 200, out);
      return done(200, { event: 'enroll', client: out.clientId });
    } catch (err) {
      if (err instanceof AuthError) noteFailure(addr, cfg);
      const status = err instanceof HttpError ? err.status : 401;
      sendPlain(res, status, { error: status === 401 ? 'unauthorized' : err.message });
      return done(status, { event: 'enroll', authError: err.message });
    }
  }

  let client, nonce;
  try {
    ({ client, nonce } = authenticate(req, raw, cfg));
  } catch (err) {
    noteFailure(addr, cfg);
    sendPlain(res, 401, { error: 'unauthorized' });
    return done(401, { authError: err.message, client: String(req.headers['x-dh-client'] ?? '').slice(0, 40) });
  }
  log.client = client.id;
  failures.delete(addr);
  const reply = (status, data, extra) => {
    sendSealed(res, status, data, client, nonce, keys);
    done(status, extra);
  };

  const window = (rate.get(client.id) ?? []).filter((t) => t > Date.now() - 60_000);
  if (window.length >= cfg.ratePerMinute) return reply(429, { error: 'rate limit' });
  window.push(Date.now());
  rate.set(client.id, window);

  const url = new URL(req.url ?? '/', 'http://gateway');
  const route = ROUTES.find(([method, re]) => method === req.method && re.test(url.pathname));
  if (!route) return reply(404, { error: 'no such route' });

  let body = {};
  if (raw.length) {
    try {
      body = JSON.parse(open(raw.toString('utf8'), keys.xPriv, keys.xPub, { direction: 'request', methodOrStatus: req.method, path: req.url, nonce }));
    } catch {
      return reply(400, { error: 'body must be a sealed envelope for this request' });
    }
  }
  try {
    // trust is looked up fresh for every request: a forgotten trust entry locks the client out at once
    const access = await trustFor(cfg, client.id);
    const data = await trace.run({ req: log.req, client: client.id, access }, () => route[2](cfg, url.pathname.match(route[1]), url, body ?? {}, client.id));
    reply(200, data, req.method === 'POST' ? { text: String(body.text ?? body.fact ?? '').slice(0, 200) } : {});
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 502;
    reply(status, { error: err instanceof HttpError ? err.message : 'hub unreachable' }, status === 502 ? { hubError: String(err?.message ?? err) } : {});
  }
}

function serve() {
  const cfg = config();
  const keys = serverKeys();
  if (!clients().length) console.warn('[gateway] no enrolled clients yet: only POST /enroll with a bootstrap token works');
  const server = createServer((req, res) => {
    handle(req, res, keys).catch((err) => {
      console.error('[gateway]', err);
      if (!res.headersSent) sendPlain(res, 500, { error: 'internal error' });
    });
  });
  server.requestTimeout = cfg.maxWaitMs + 60_000;
  server.listen(cfg.port, '127.0.0.1', () => console.log(`[gateway] listening on 127.0.0.1:${cfg.port}, hub ${cfg.hubUrl}; access from fleet-memory trust entries`));
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'serve') serve();
  else if (cmd === 'bootstrap') bootstrap(arg);
  else if (cmd === 'revoke') revoke(arg);
  else if (cmd === 'list') list();
  else if (cmd === 'requests') console.log(JSON.stringify(requests().map(publicRequest)));
  else if (cmd === 'accept') decide(arg, 'accepted');
  else if (cmd === 'reject') decide(arg, 'rejected');
  else console.log('usage: deckhand-gateway.mjs serve | bootstrap <id> | revoke <id> | list | requests | accept <request> | reject <request>');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
