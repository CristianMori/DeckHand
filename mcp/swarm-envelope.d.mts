export interface SwarmEnvelope {
  v: 1;
  id: string;
  type: string;
  /** the signer's public key */
  from: string;
  to: string;
  ts: number;
  body: Record<string, unknown>;
  sig: string;
}

export function newSwarmKey(): { id: string; pem: string };
export function seal(pem: string, m: { type: string; from: string; to: string; body: Record<string, unknown> }): SwarmEnvelope;
export function signatureHolds(env: unknown): env is SwarmEnvelope;
