// Deckhand gateway wire format, shared by the gateway and the reference client.
//
// Keys travel as base64url (no padding) of their raw 32 bytes.
//
// Request signature (Ed25519, client's key), header X-DH-Signature:
//   canonical = "DH2\n" METHOD "\n" PATH_WITH_QUERY "\n" TIMESTAMP "\n" NONCE "\n" hex(sha256(body bytes as sent))
// Response signature (Ed25519, gateway's key), header X-DH-Signature:
//   canonical = "DH2-RESP\n" STATUS "\n" NONCE "\n" hex(sha256(body bytes as sent))
//
// Body envelope (request bodies to the gateway, response bodies to the client):
//   {"v":2,"epk":"<sender's ephemeral X25519 public>","iv":"<12 bytes>","ct":"<ciphertext || 16-byte Poly1305 tag>"}
//   shared = X25519(ephemeral private, recipient's static X25519 public)
//   key    = HKDF-SHA256(ikm = shared, salt = epk raw || recipient public raw, info = "deckhand-gateway/2 " DIRECTION " " NONCE, 32 bytes)
//            DIRECTION = "request" | "response" | "push"
//   AEAD   = ChaCha20-Poly1305, AAD = "DH2 " DIRECTION "\n" METHOD-or-STATUS "\n" PATH-or-"" "\n" NONCE
//   plaintext = the JSON body (UTF-8).

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => Buffer.from(String(s ?? ''), 'base64url');
export const sha256hex = (data) => createHash('sha256').update(data).digest('hex');

/** Raw 32-byte public key from a KeyObject. */
export const rawPublic = (key) => unb64u(key.export({ format: 'jwk' }).x);

export function publicFromRaw(raw, crv) {
  const bytes = typeof raw === 'string' ? unb64u(raw) : raw;
  if (bytes.length !== 32) throw new Error(`${crv} public key must be 32 bytes`);
  return createPublicKey({ key: { kty: 'OKP', crv, x: b64u(bytes) }, format: 'jwk' });
}

export function newKeyPair(type) {
  return generateKeyPairSync(type); // 'ed25519' | 'x25519'
}

export const privateToJwk = (key) => key.export({ format: 'jwk' });
export const privateFromJwk = (jwk) => createPrivateKey({ key: jwk, format: 'jwk' });

export function requestCanonical(method, pathWithQuery, timestamp, nonce, body) {
  return ['DH2', method.toUpperCase(), pathWithQuery, String(timestamp), nonce, sha256hex(body ?? '')].join('\n');
}

export function responseCanonical(status, nonce, body) {
  return ['DH2-RESP', String(status), nonce, sha256hex(body ?? '')].join('\n');
}

/**
 * A message pushed to a client's webhook (gateway → client). The body carries
 * everything (receivers may drop custom headers):
 *   {"v":2,"kind":"deckhand-push","id":MESSAGE_ID,"ts":TIMESTAMP,"sig":SIGNATURE,"sealed":ENVELOPE_STRING}
 *   SIGNATURE = gateway Ed25519 over
 *     "DH2-PUSH\n" MESSAGE_ID "\n" TIMESTAMP "\n" hex(sha256(ENVELOPE_STRING))
 *   ENVELOPE_STRING = an envelope sealed to the client's X25519 key with
 *     DIRECTION = "push", METHOD-or-STATUS = "MSG", path "", NONCE = the message id.
 * X-DH-Message / X-DH-Timestamp / X-DH-Signature headers repeat id, ts and sig.
 */
export function pushCanonical(messageId, timestamp, body) {
  return ['DH2-PUSH', messageId, String(timestamp), sha256hex(body ?? '')].join('\n');
}

export const signText = (privateKey, text) => b64u(sign(null, Buffer.from(text), privateKey));
export function verifyText(publicKey, text, signature) {
  const sig = unb64u(signature);
  return sig.length === 64 && verify(null, Buffer.from(text), publicKey, sig);
}

function aeadKey(shared, epkRaw, recipientRaw, direction, nonce) {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epkRaw, recipientRaw]), `deckhand-gateway/2 ${direction} ${nonce}`, 32));
}

const aad = (direction, methodOrStatus, path, nonce) => Buffer.from(`DH2 ${direction}\n${methodOrStatus}\n${path}\n${nonce}`);

/** Encrypt `plaintext` to `recipientX25519` (KeyObject); returns the envelope as a JSON string. */
export function seal(plaintext, recipientX25519, { direction, methodOrStatus, path = '', nonce }) {
  const eph = newKeyPair('x25519');
  const epkRaw = rawPublic(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientX25519 });
  const key = aeadKey(shared, epkRaw, rawPublic(recipientX25519), direction, nonce);
  const iv = randomBytes(12);
  const c = createCipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 });
  const pt = Buffer.from(plaintext, 'utf8');
  c.setAAD(aad(direction, methodOrStatus, path, nonce), { plaintextLength: pt.length });
  const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  return JSON.stringify({ v: 2, epk: b64u(epkRaw), iv: b64u(iv), ct: b64u(ct) });
}

/** Open an envelope with the recipient's static X25519 private key; throws when anything is off. */
export function open(envelopeText, recipientPrivate, recipientPublic, { direction, methodOrStatus, path = '', nonce }) {
  const env = JSON.parse(envelopeText);
  if (env?.v !== 2) throw new Error('envelope version');
  const epkRaw = unb64u(env.epk);
  const iv = unb64u(env.iv);
  const ct = unb64u(env.ct);
  if (iv.length !== 12 || ct.length < 16) throw new Error('envelope shape');
  const shared = diffieHellman({ privateKey: recipientPrivate, publicKey: publicFromRaw(epkRaw, 'X25519') });
  const key = aeadKey(shared, epkRaw, rawPublic(recipientPublic), direction, nonce);
  const d = createDecipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 });
  d.setAAD(aad(direction, methodOrStatus, path, nonce), { plaintextLength: ct.length - 16 });
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8');
}
