#!/usr/bin/env node
// Reference client for the Deckhand gateway: shows the signing scheme and
// doubles as a test tool. Credentials come from the environment, never argv:
//   DH_GATEWAY_URL   e.g. https://vps-node.example.ts.net
//   DH_KEY_ID, DH_TOKEN, DH_HMAC_SECRET
//
//   node gateway-client.mjs GET /v1/sessions
//   node gateway-client.mjs POST /v1/sessions/<id>/prompt '{"text":"hi","waitMs":120000}'
//
// Signing: canonical = METHOD \n PATH?QUERY \n TIMESTAMP \n NONCE \n hex(sha256(body))
// signature = hex(HMAC-SHA256(hmac secret, canonical)); headers below.

import { createHash, createHmac, randomBytes } from 'node:crypto';

export function signedHeaders({ method, path, body = '', keyId, token, hmacSecret, timestamp, nonce }) {
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
  const n = nonce ?? randomBytes(16).toString('base64url');
  const canonical = [method.toUpperCase(), path, ts, n, createHash('sha256').update(body).digest('hex')].join('\n');
  return {
    Authorization: `Bearer ${token}`,
    'X-DH-Key': keyId,
    'X-DH-Timestamp': ts,
    'X-DH-Nonce': n,
    'X-DH-Signature': createHmac('sha256', hmacSecret).update(canonical).digest('hex'),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
}

if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/').split('/').pop() ?? '')) {
  const [method = 'GET', path = '/v1/sessions', body = ''] = process.argv.slice(2);
  const env = process.env;
  const headers = signedHeaders({ method, path, body, keyId: env.DH_KEY_ID, token: env.DH_TOKEN, hmacSecret: env.DH_HMAC_SECRET });
  const res = await fetch(`${env.DH_GATEWAY_URL}${path}`, { method, headers, body: body || undefined });
  console.log(res.status, await res.text());
}
