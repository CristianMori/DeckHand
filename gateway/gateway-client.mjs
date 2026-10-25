#!/usr/bin/env node
// Reference client for the Deckhand gateway (wire format in wire.mjs); also the
// test tool. The identity file holds this client's PRIVATE keys: keep it 0600
// on the client machine, it never leaves it.
//
//   node gateway-client.mjs init <identity.json> <https://gateway-url>
//   node gateway-client.mjs enroll <identity.json>          (bootstrap token read from DH_BOOTSTRAP_TOKEN)
//   node gateway-client.mjs call <identity.json> GET /v1/sessions
//   node gateway-client.mjs call <identity.json> POST /v1/sessions/<id>/prompt '{"text":"hi","waitMs":120000}'

import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import {
  b64u,
  newKeyPair,
  open,
  privateFromJwk,
  privateToJwk,
  publicFromRaw,
  pushCanonical,
  rawPublic,
  requestCanonical,
  responseCanonical,
  seal,
  signText,
  verifyText,
} from './wire.mjs';

export function newIdentity(url) {
  const ed = newKeyPair('ed25519');
  const x = newKeyPair('x25519');
  return { url: url.replace(/\/+$/, ''), ed25519: privateToJwk(ed.privateKey), x25519: privateToJwk(x.privateKey) };
}

export const identityPublic = (id) => ({ ed25519: id.ed25519.x, x25519: id.x25519.x });

/**
 * No token yet: ask for one. The user accepts or rejects in Deckhand's admin
 * view; keep the returned secret, it is the only handle on the request.
 */
export async function requestAccess(url, { clientId, name, reason }) {
  const res = await fetch(`${url.replace(/\/+$/, '')}/access-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, name, reason }),
  });
  const data = await res.json();
  if (res.status !== 202) throw new Error(`request: ${res.status} ${data.error}`);
  return data; // {requestId, clientId, secret, status, poll, mint}
}

/** pending | accepted (mint before mintUntil) | rejected | expired | minted */
export async function requestStatus(url, requestId, secret) {
  const res = await fetch(`${url.replace(/\/+$/, '')}/access-requests/${requestId}`, { headers: { Authorization: `Request ${secret}` } });
  const data = await res.json();
  if (res.status !== 200) throw new Error(`status: ${res.status} ${data.error}`);
  return data;
}

/** Within a minute of acceptance: a one-time bootstrap token for enroll(). */
export async function mintFromRequest(url, requestId, secret) {
  const res = await fetch(`${url.replace(/\/+$/, '')}/access-requests/${requestId}/mint`, { method: 'POST', headers: { Authorization: `Request ${secret}` } });
  const data = await res.json();
  if (res.status !== 200) throw new Error(`mint: ${res.status} ${data.error}`);
  return data; // {clientId, token, expiresAt, gateway: {ed25519, x25519}}
}

/** Trade the one-time token for enrollment; pins the gateway's keys into the identity. */
export async function enroll(id, bootstrapToken, expectGateway) {
  const res = await fetch(`${id.url}/enroll`, {
    method: 'POST',
    headers: { Authorization: `Bootstrap ${bootstrapToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(identityPublic(id)),
  });
  const data = await res.json();
  if (res.status !== 200) throw new Error(`enroll: ${res.status} ${data.error}`);
  // the bootstrap file lists the gateway keys: a mismatch means someone is in the middle
  if (expectGateway && (expectGateway.ed25519 !== data.gateway.ed25519 || expectGateway.x25519 !== data.gateway.x25519)) {
    throw new Error('enroll: gateway keys differ from the bootstrap file');
  }
  return { ...id, clientId: data.clientId, gateway: data.gateway };
}

/** One signed, sealed request; verifies and opens the sealed answer. */
export async function call(id, method, path, bodyObj, over = {}) {
  const nonce = over.nonce ?? randomBytes(18).toString('base64url');
  const ts = String(over.timestamp ?? Math.floor(Date.now() / 1000));
  const gwX = publicFromRaw(id.gateway.x25519, 'X25519');
  const body = bodyObj === undefined ? '' : (over.rawBody ?? seal(JSON.stringify(bodyObj), gwX, { direction: 'request', methodOrStatus: method, path, nonce }));
  const signKey = over.signKey ?? privateFromJwk(id.ed25519);
  const headers = {
    'X-DH-Client': id.clientId,
    'X-DH-Timestamp': ts,
    'X-DH-Nonce': nonce,
    'X-DH-Signature': signText(signKey, requestCanonical(method, path, ts, nonce, over.signedBody ?? body)),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
  const res = await fetch(`${id.url}${path}`, { method, headers, body: body || undefined });
  const text = await res.text();
  const sig = res.headers.get('x-dh-signature');
  if (!sig) return { status: res.status, sealed: false, data: safeJson(text), headers };
  const verified = res.headers.get('x-dh-nonce') === nonce && verifyText(publicFromRaw(id.gateway.ed25519, 'Ed25519'), responseCanonical(res.status, nonce, text), sig);
  if (!verified) throw new Error('response signature does not verify');
  const xPriv = privateFromJwk(id.x25519);
  const xPub = publicFromRaw(id.x25519.x, 'X25519');
  const plain = open(text, xPriv, xPub, { direction: 'response', methodOrStatus: String(res.status), nonce });
  return { status: res.status, sealed: true, verified, data: safeJson(plain), headers, rawBody: body };
}

/**
 * Your webhook received a push: check it is the gateway's (signature, fresh
 * timestamp) and open it. headers: X-DH-Message, X-DH-Timestamp,
 * X-DH-Signature (any case); body: the raw request body string.
 * Returns {id, at, from, text}; throws when anything is off. Answer 2xx only
 * after this succeeds, or the gateway keeps the message in your inbox.
 */
export function openPush(id, headers, body, maxSkewS = 300) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
  const msgId = String(h['x-dh-message'] ?? '');
  const ts = String(h['x-dh-timestamp'] ?? '');
  if (!msgId || !/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > maxSkewS) throw new Error('push: missing or stale headers');
  if (!verifyText(publicFromRaw(id.gateway.ed25519, 'Ed25519'), pushCanonical(msgId, ts, body), String(h['x-dh-signature'] ?? ''))) {
    throw new Error('push: signature does not verify');
  }
  const plain = open(body, privateFromJwk(id.x25519), publicFromRaw(id.x25519.x, 'X25519'), { direction: 'push', methodOrStatus: 'MSG', nonce: msgId });
  const msg = JSON.parse(plain);
  if (msg.id !== msgId) throw new Error('push: message id mismatch');
  return msg;
}

/** Messages that waited for you (webhook down, or none set); ack them once handled. */
export const inbox = (id) => call(id, 'GET', '/v1/inbox');
export const ackInbox = (id, ids) => call(id, 'POST', '/v1/inbox/ack', { ids });
/** authorization: the receiver's own Authorization header value (optional; omitted = keep, null = drop) */
export const setWebhook = (id, url, authorization) => call(id, 'POST', '/v1/webhook', authorization === undefined ? { url } : { url, authorization });

const safeJson = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

const save = (file, id) => {
  writeFileSync(file, JSON.stringify(id, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
};

const isMain = process.argv[1] && import.meta.url.toLowerCase().endsWith(process.argv[1].replace(/\\/g, '/').toLowerCase().split('/').pop());
if (isMain) {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (cmd === 'init') {
    save(file, newIdentity(rest[0]));
    console.log(`identity written to ${file}; public keys:`, identityPublic(JSON.parse(readFileSync(file, 'utf8'))));
  } else if (cmd === 'enroll') {
    const id = await enroll(JSON.parse(readFileSync(file, 'utf8')), process.env.DH_BOOTSTRAP_TOKEN);
    save(file, id);
    console.log(`enrolled as ${id.clientId}; gateway keys pinned`, id.gateway);
  } else if (cmd === 'call') {
    const [method, path, body] = rest;
    const r = await call(JSON.parse(readFileSync(file, 'utf8')), method, path, body ? JSON.parse(body) : undefined);
    console.log(r.status, JSON.stringify(r.data, null, 2));
  } else {
    console.log('usage: gateway-client.mjs init <identity.json> <url> | enroll <identity.json> | call <identity.json> METHOD PATH [json]');
  }
}

export { b64u, rawPublic };
