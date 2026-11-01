import { createPrivateKey, sign } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import { isAbsolute, join } from 'node:path';
import { DATA_DIR } from './config.js';
import type { AttentionCleared, AttentionEvent } from './needsYou.js';

/**
 * Push to the Deckhand iOS app through APNs, with token auth. Off until
 * data/attention.json has an "apns" block and the hub holds the .p8 key it
 * names. As with Discord, exactly one hub is configured, so nothing doubles.
 */

export type ApnsEnvironment = 'sandbox' | 'production';

export interface ApnsConfig {
  /** the .p8 from Apple: absolute, or relative to the hub's data folder */
  keyFile?: string;
  keyId?: string;
  teamId?: string;
  bundleId?: string;
  /** override Apple's servers (tests) */
  sandboxUrl?: string;
  productionUrl?: string;
}

const APPLE: Record<ApnsEnvironment, string> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};
const TOKEN_REUSE_MS = 50 * 60_000; // Apple refuses one over an hour old, and refreshing under 20 minutes
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_AFTER_MS = 30_000;
const ALERT_BODY_CAP = 300;
const DEVICES_FILE = join(DATA_DIR, 'push-devices.json');
const TRANSIENT = new Set([429, 500, 503]);

export interface PushDevice {
  token: string;
  environment: ApnsEnvironment;
  name?: string;
  registeredAt: number;
}

export const validDeviceToken = (t: unknown): t is string => typeof t === 'string' && /^[0-9a-fA-F]{32,400}$/.test(t);

/** The devices that asked for push: a git-ignored file only this hub reads. */
export class PushDevices {
  constructor(private file = DEVICES_FILE) {}

  list(): PushDevice[] {
    try {
      return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as PushDevice[]) : [];
    } catch (err) {
      console.warn(`[apns] ignoring ${this.file}: ${err}`);
      return [];
    }
  }

  private save(devices: PushDevice[]) {
    writeFileSync(this.file, JSON.stringify(devices, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  add(token: string, environment: ApnsEnvironment, name?: string, now = Date.now()) {
    const t = token.toLowerCase();
    this.save([...this.list().filter((d) => d.token !== t), { token: t, environment, name, registeredAt: now }]);
  }

  remove(token: string) {
    const t = token.toLowerCase();
    this.save(this.list().filter((d) => d.token !== t));
  }
}

const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** A provider token: ES256 over {alg,kid}.{iss,iat}, in the raw r||s form JWT needs. */
export function providerToken(keyPem: string, keyId: string, teamId: string, now = Date.now()): string {
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64u(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key: createPrivateKey(keyPem), dsaEncoding: 'ieee-p1363' });
  return `${head}.${claims}.${b64u(signature)}`;
}

/** What the app gets for an alert. Everything it routes on is at the top level. */
export function attentionPayload(e: AttentionEvent) {
  const what = e.kind === 'permission' ? 'wants approval' : 'has a question';
  const body = e.text.length > ALERT_BODY_CAP ? `${e.text.slice(0, ALERT_BODY_CAP)}…` : e.text;
  return {
    aps: {
      alert: { title: e.machine ? `${e.name} on ${e.machine}` : e.name, subtitle: what, body },
      sound: 'default',
      'thread-id': e.conversationId,
    },
    type: 'attention',
    conversationId: e.conversationId,
    episode: e.episode,
    kind: e.kind,
    name: e.name,
    text: e.text,
    machine: e.machine,
    hubId: e.hubId,
    state: e.state,
  };
}

interface ApnsAnswer {
  status: number;
  reason?: string;
  timestamp?: number;
}

function post(client: http2.ClientHttp2Session, path: string, headers: Record<string, string>, body: string): Promise<ApnsAnswer> {
  return new Promise((resolve, reject) => {
    const req = client.request({ ':method': 'POST', ':path': path, 'content-type': 'application/json', ...headers });
    let status = 0;
    let text = '';
    req.setEncoding('utf8');
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on('response', (h) => (status = Number(h[':status'])));
    req.on('data', (d: string) => (text += d));
    req.on('error', reject);
    req.on('close', () => {
      if (!status) return reject(new Error('no answer from APNs'));
      let parsed: { reason?: string; timestamp?: number } = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        /* an empty 200 is the normal answer; a garbled error still has its status */
      }
      resolve({ status, reason: parsed.reason, timestamp: parsed.timestamp });
    });
    req.end(body);
  });
}

interface Push {
  headers: Record<string, string>;
  body: string;
  label: string;
}

export interface PushResult {
  sent: number;
  dropped: number;
  failed: number;
}

export class ApnsSender {
  private jwt?: { value: string; id: string; at: number };

  constructor(
    private devices: PushDevices,
    private config: () => ApnsConfig | undefined,
    private opts: { retryAfterMs?: number } = {},
  ) {}

  /** Complete config and a key file that exists; anything less is simply off. */
  private ready(): Required<Pick<ApnsConfig, 'keyFile' | 'keyId' | 'teamId' | 'bundleId'>> & ApnsConfig | undefined {
    const c = this.config();
    if (!c?.keyFile || !c.keyId || !c.teamId || !c.bundleId) return undefined;
    const keyFile = isAbsolute(c.keyFile) ? c.keyFile : join(DATA_DIR, c.keyFile);
    if (!existsSync(keyFile)) {
      console.warn(`[apns] key file not found: ${keyFile}`);
      return undefined;
    }
    return { ...c, keyFile, keyId: c.keyId, teamId: c.teamId, bundleId: c.bundleId };
  }

  enabled = () => !!this.ready();

  sendAttention(e: AttentionEvent): Promise<PushResult> {
    return this.send({
      label: e.episode,
      // the collapse id replaces an earlier copy, should the same episode ever be sent twice
      headers: { 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': e.episode.slice(0, 64) },
      body: JSON.stringify(attentionPayload(e)),
    });
  }

  /**
   * APNs has no "remove" call. A silent background push wakes the app, which
   * removes the delivered notification itself. Apple throttles these and does
   * not deliver them to an app the user force-quit, so this is best effort.
   */
  sendCleared(e: AttentionCleared): Promise<PushResult> {
    return this.send({
      label: `${e.episode} cleared`,
      headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
      body: JSON.stringify({
        aps: { 'content-available': 1 },
        type: 'attention-cleared',
        episode: e.episode,
        conversationId: e.conversationId,
        hubId: e.hubId,
      }),
    });
  }

  private token(c: NonNullable<ReturnType<ApnsSender['ready']>>): string {
    const id = `${c.keyId}:${c.teamId}`;
    if (this.jwt?.id === id && Date.now() - this.jwt.at < TOKEN_REUSE_MS) return this.jwt.value;
    this.jwt = { value: providerToken(readFileSync(c.keyFile, 'utf8'), c.keyId, c.teamId), id, at: Date.now() };
    return this.jwt.value;
  }

  private async send(push: Push): Promise<PushResult> {
    const result: PushResult = { sent: 0, dropped: 0, failed: 0 };
    const c = this.ready();
    if (!c) return result;
    let targets = this.devices.list();
    for (let attempt = 0; targets.length && attempt < 2; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, this.opts.retryAfterMs ?? RETRY_AFTER_MS));
      const again: PushDevice[] = [];
      for (const environment of ['sandbox', 'production'] as const) {
        const group = targets.filter((d) => d.environment === environment);
        if (group.length) again.push(...(await this.sendTo(c, environment, group, push, result)));
      }
      targets = again;
    }
    result.failed += targets.length;
    if (targets.length) console.warn(`[apns] ${push.label}: gave up on ${targets.length} device(s)`);
    return result;
  }

  /** One connection for one environment; answers the devices worth trying again. */
  private async sendTo(
    c: NonNullable<ReturnType<ApnsSender['ready']>>,
    environment: ApnsEnvironment,
    group: PushDevice[],
    push: Push,
    result: PushResult,
  ): Promise<PushDevice[]> {
    const url = (environment === 'sandbox' ? c.sandboxUrl : c.productionUrl) ?? APPLE[environment];
    const again: PushDevice[] = [];
    let client: http2.ClientHttp2Session;
    try {
      client = http2.connect(url);
      client.on('error', (err) => console.warn(`[apns] ${environment} connection: ${err}`));
    } catch (err) {
      console.warn(`[apns] cannot connect to ${environment}: ${err}`);
      return group;
    }
    try {
      for (const device of group) {
        let authorization: string;
        try {
          authorization = `bearer ${this.token(c)}`;
        } catch (err) {
          console.warn(`[apns] cannot sign with ${c.keyFile}: ${err instanceof Error ? err.message : err}`);
          result.failed++;
          continue;
        }
        const headers = { authorization, 'apns-topic': c.bundleId, ...push.headers };
        try {
          const answer = await post(client, `/3/device/${device.token}`, headers, push.body);
          if (answer.status === 200) {
            result.sent++;
          } else if (this.isDead(answer, device)) {
            this.devices.remove(device.token);
            result.dropped++;
            console.log(`[apns] dropped …${device.token.slice(-8)}: ${answer.reason ?? answer.status}`);
          } else if (TRANSIENT.has(answer.status) || answer.reason === 'ExpiredProviderToken') {
            if (answer.reason === 'ExpiredProviderToken') this.jwt = undefined;
            again.push(device);
          } else {
            result.failed++;
            console.warn(`[apns] ${push.label} …${device.token.slice(-8)}: ${answer.status} ${answer.reason ?? ''}`);
          }
        } catch (err) {
          again.push(device);
          console.warn(`[apns] ${push.label} …${device.token.slice(-8)}: ${err}`);
        }
      }
    } finally {
      client.close();
    }
    return again;
  }

  /**
   * DeviceTokenNotForTopic is not here: it means the bundle id in the config
   * is wrong, and dropping on it would wipe every device over one typo.
   */
  private isDead(a: ApnsAnswer, device: PushDevice): boolean {
    // Apple's date says when the token stopped being valid: a registration after it is a new token
    if (a.status === 410) return !(a.timestamp && device.registeredAt > a.timestamp);
    return a.status === 400 && a.reason === 'BadDeviceToken';
  }
}
