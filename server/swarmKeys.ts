import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newSwarmKey, seal, type SwarmEnvelope } from '../mcp/swarm-envelope.mjs';
import { DATA_DIR } from './config.js';

/**
 * Private keys of the sessions in a swarm, one file each, read by that
 * session's MCP server and by the hub for its own notices about it. They live
 * outside every synced folder and never leave this machine: only the public
 * half is on a session's card.
 */
const KEYS = join(DATA_DIR, 'swarm-keys');

const keyFile = (id: string) => join(KEYS, `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.pem`);

/** The session's key file, made the first time it has a role. */
export function ensureSwarmKey(session: { swarmKey?: string }): string {
  if (session.swarmKey) return keyFile(session.swarmKey);
  const { id, pem } = newSwarmKey();
  mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  writeFileSync(keyFile(id), pem, { mode: 0o600 });
  session.swarmKey = id;
  return keyFile(id);
}

/** Signed by the hub on a session's behalf: what it says about the session, not what the session said. */
export function sealAs(id: string, m: { type: string; to: string; body: Record<string, unknown> }): SwarmEnvelope {
  return seal(readFileSync(keyFile(id), 'utf8'), { ...m, from: id });
}

export function dropSwarmKey(id: string | undefined) {
  if (id) rmSync(keyFile(id), { force: true });
}
