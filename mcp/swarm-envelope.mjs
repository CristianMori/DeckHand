// The envelope architects, sub-architects and workers sign their messages with.
// Plain JavaScript and no dependencies: the hub and the MCP server both load it.
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

/** A new Ed25519 key pair. Its id is the public key, so a message names who signed it. */
export function newSwarmKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { id: publicKey.export({ format: 'jwk' }).x, pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/** The same bytes for the same value, whatever order its keys arrived in. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const signedBytes = ({ v, id, type, from, to, ts, body }) => Buffer.from(stable({ v, id, type, from, to, ts, body }));

export function seal(pem, { type, from, to, body }) {
  const env = { v: 1, id: randomBytes(16).toString('hex'), type, from, to, ts: Date.now(), body };
  return { ...env, sig: sign(null, signedBytes(env), pem).toString('base64url') };
}

/** Whether the key the envelope names really signed it. Whether that key is one to trust is the caller's question. */
export function signatureHolds(env) {
  try {
    if (env?.v !== 1 || typeof env.id !== 'string' || typeof env.type !== 'string' || typeof env.from !== 'string' || typeof env.to !== 'string') return false;
    if (typeof env.ts !== 'number' || typeof env.sig !== 'string' || !env.body || typeof env.body !== 'object') return false;
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: env.from }, format: 'jwk' });
    return verify(null, signedBytes(env), key, Buffer.from(env.sig, 'base64url'));
  } catch {
    return false;
  }
}
