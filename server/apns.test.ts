import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApnsSender, PushDevices, attentionPayload, providerToken, validDeviceToken, type ApnsConfig } from './apns.js';
import { SentLedger, type AttentionCleared, type AttentionEvent } from './needsYou.js';

const dir = mkdtempSync(join(tmpdir(), 'apns-test-'));
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const keyFile = join(dir, 'AuthKey_TEST.p8');
writeFileSync(keyFile, keyPem);

const TOK = (c: string) => c.repeat(64);
let files = 0;
const devicesFile = () => join(dir, `devices-${files++}.json`);

interface Seen {
  path: string;
  headers: http2.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

type Answer = { status: number; reason?: string; timestamp?: number };

/** A fake APNs: HTTP/2 without TLS, answering each request from a script. */
async function fakeApns(answer: (seen: Seen, nth: number) => Answer = () => ({ status: 200 })) {
  const seen: Seen[] = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (d: string) => (text += d));
    stream.on('end', () => {
      const entry = { path: String(headers[':path']), headers, body: JSON.parse(text) };
      seen.push(entry);
      const a = answer(entry, seen.length);
      stream.respond({ ':status': a.status });
      stream.end(a.reason ? JSON.stringify({ reason: a.reason, timestamp: a.timestamp }) : undefined);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, url, close: () => new Promise((r) => server.close(r)) };
}

const config = (over: Partial<ApnsConfig>): ApnsConfig => ({ keyFile, keyId: 'KEY1234567', teamId: 'TEAM123456', bundleId: 'com.example.deckhand', ...over });

const event: AttentionEvent = {
  type: 'attention', episode: 'abcd1234-1793000000000', kind: 'question', text: 'Which one?', since: 1, alertedAt: 2,
  hubId: 'abcd1234', conversationId: 'conv-1', name: 'Proj', machine: 'mac', state: 'IDLE',
};
const cleared: AttentionCleared = { type: 'attention-cleared', episode: event.episode, hubId: 'abcd1234', conversationId: 'conv-1', machine: 'mac' };

test('device token shape', () => {
  assert.ok(validDeviceToken(TOK('a')));
  for (const bad of ['', 'abc', 'zz'.repeat(32), 42, undefined, `${TOK('a')}/../x`]) assert.equal(validDeviceToken(bad), false, String(bad));
});

test('devices: one entry per token, survives a reload, removable', () => {
  const file = devicesFile();
  const d = new PushDevices(file);
  d.add(TOK('A'), 'sandbox', 'phone');
  d.add(TOK('a'), 'production', 'phone');
  assert.deepEqual(new PushDevices(file).list().map((x) => [x.token, x.environment]), [[TOK('a'), 'production']]);
  d.remove(TOK('A'));
  assert.deepEqual(d.list(), []);
});

test('off when unconfigured: nothing connects, nothing throws', async () => {
  const apns = await fakeApns();
  const devices = new PushDevices(devicesFile());
  devices.add(TOK('a'), 'sandbox');
  for (const c of [undefined, {}, config({ sandboxUrl: apns.url, teamId: undefined }), config({ sandboxUrl: apns.url, keyFile: join(dir, 'missing.p8') })]) {
    const sender = new ApnsSender(devices, () => c);
    assert.equal(sender.enabled(), false);
    assert.deepEqual(await sender.sendAttention(event), { sent: 0, dropped: 0, failed: 0 });
  }
  assert.equal(apns.seen.length, 0);
  await apns.close();
});

test('alert push: the headers and payload APNs and the app need, with a valid provider token', async () => {
  const apns = await fakeApns();
  const devices = new PushDevices(devicesFile());
  devices.add(TOK('a'), 'production');
  const sender = new ApnsSender(devices, () => config({ productionUrl: apns.url }));
  assert.equal(sender.enabled(), true);
  assert.deepEqual(await sender.sendAttention(event), { sent: 1, dropped: 0, failed: 0 });
  const [req] = apns.seen;
  assert.equal(req.path, `/3/device/${TOK('a')}`);
  assert.equal(req.headers['apns-topic'], 'com.example.deckhand');
  assert.equal(req.headers['apns-push-type'], 'alert');
  assert.equal(req.headers['apns-priority'], '10');
  assert.equal(req.headers['apns-collapse-id'], event.episode);
  assert.deepEqual(req.body, {
    aps: { alert: { title: 'Proj on mac', subtitle: 'has a question', body: 'Which one?' }, sound: 'default', 'thread-id': 'conv-1' },
    type: 'attention', conversationId: 'conv-1', episode: event.episode, kind: 'question', name: 'Proj', text: 'Which one?',
    machine: 'mac', hubId: 'abcd1234', state: 'IDLE',
  });
  const [scheme, jwt] = String(req.headers.authorization).split(' ');
  assert.equal(scheme, 'bearer');
  const [head, claims, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), { alg: 'ES256', kid: 'KEY1234567' });
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url').toString()).iss, 'TEAM123456');
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  await apns.close();
});

test('the payload stays under the 4 KB limit with a full-length text, and the alert is shortened', () => {
  const p = attentionPayload({ ...event, text: 'é'.repeat(600) });
  assert.ok(Buffer.byteLength(JSON.stringify(p)) < 4096);
  assert.ok(p.aps.alert.body.length <= 301);
  assert.equal(p.text.length, 600);
});

test('each token goes to its own environment', async () => {
  const [sandbox, production] = [await fakeApns(), await fakeApns()];
  const devices = new PushDevices(devicesFile());
  devices.add(TOK('a'), 'sandbox');
  devices.add(TOK('b'), 'production');
  const sender = new ApnsSender(devices, () => config({ sandboxUrl: sandbox.url, productionUrl: production.url }));
  assert.equal((await sender.sendAttention(event)).sent, 2);
  assert.deepEqual(sandbox.seen.map((s) => s.path), [`/3/device/${TOK('a')}`]);
  assert.deepEqual(production.seen.map((s) => s.path), [`/3/device/${TOK('b')}`]);
  await Promise.all([sandbox.close(), production.close()]);
});

test('dead tokens are dropped; the live one and a config mistake are not', async () => {
  const answers: Record<string, Answer> = {
    [TOK('a')]: { status: 410, reason: 'Unregistered', timestamp: Date.now() },
    [TOK('b')]: { status: 400, reason: 'BadDeviceToken' },
    [TOK('c')]: { status: 400, reason: 'DeviceTokenNotForTopic' },
    [TOK('d')]: { status: 200 },
  };
  const apns = await fakeApns((s) => answers[s.path.slice('/3/device/'.length)]);
  const devices = new PushDevices(devicesFile());
  for (const c of 'abcd') devices.add(TOK(c), 'sandbox', undefined, Date.now() - 60_000);
  const sender = new ApnsSender(devices, () => config({ sandboxUrl: apns.url }));
  assert.deepEqual(await sender.sendAttention(event), { sent: 1, dropped: 2, failed: 1 });
  assert.deepEqual(devices.list().map((d) => d.token), [TOK('c'), TOK('d')]);
  await apns.close();
});

test('410 dated before the registration: a newer token stays', async () => {
  const apns = await fakeApns(() => ({ status: 410, reason: 'Unregistered', timestamp: Date.now() - 60_000 }));
  const devices = new PushDevices(devicesFile());
  devices.add(TOK('a'), 'sandbox');
  const sender = new ApnsSender(devices, () => config({ sandboxUrl: apns.url }));
  assert.deepEqual(await sender.sendAttention(event), { sent: 0, dropped: 0, failed: 1 });
  assert.equal(devices.list().length, 1);
  await apns.close();
});

test('a busy APNs is tried once more, then given up on', async () => {
  const apns = await fakeApns((_s, nth) => (nth === 1 ? { status: 503, reason: 'ServiceUnavailable' } : { status: 200 }));
  const devices = new PushDevices(devicesFile());
  devices.add(TOK('a'), 'sandbox');
  const sender = new ApnsSender(devices, () => config({ sandboxUrl: apns.url }), { retryAfterMs: 1 });
  assert.deepEqual(await sender.sendAttention(event), { sent: 1, dropped: 0, failed: 0 });
  await apns.close();

  const down = await fakeApns(() => ({ status: 429, reason: 'TooManyRequests' }));
  const sender2 = new ApnsSender(devices, () => config({ sandboxUrl: down.url }), { retryAfterMs: 1 });
  assert.deepEqual(await sender2.sendAttention(event), { sent: 0, dropped: 0, failed: 1 });
  assert.equal(down.seen.length, 2);
  assert.equal(devices.list().length, 1, 'a busy server says nothing about the token');
  await down.close();
});

test('APNs unreachable: reported, not thrown', async () => {
  const apns = await fakeApns();
  const url = apns.url;
  await apns.close();
  const devices = new PushDevices(devicesFile());
  devices.add(TOK('a'), 'sandbox');
  const sender = new ApnsSender(devices, () => config({ sandboxUrl: url }), { retryAfterMs: 1 });
  assert.deepEqual(await sender.sendAttention(event), { sent: 0, dropped: 0, failed: 1 });
});

test('a bad key is reported, not thrown', async () => {
  const bad = join(dir, 'bad.p8');
  writeFileSync(bad, 'not a key');
  const apns = await fakeApns();
  const devices = new PushDevices(devicesFile());
  devices.add(TOK('a'), 'sandbox');
  const sender = new ApnsSender(devices, () => config({ sandboxUrl: apns.url, keyFile: bad }));
  assert.deepEqual(await sender.sendAttention(event), { sent: 0, dropped: 0, failed: 1 });
  assert.equal(apns.seen.length, 0);
  await apns.close();
});

test('provider token: reused between sends, replaced when APNs says it expired', async () => {
  let expireNext = false;
  const apns = await fakeApns(() => {
    if (!expireNext) return { status: 200 };
    expireNext = false;
    return { status: 403, reason: 'ExpiredProviderToken' };
  });
  const devices = new PushDevices(devicesFile());
  devices.add(TOK('a'), 'sandbox');
  const sender = new ApnsSender(devices, () => config({ sandboxUrl: apns.url }), { retryAfterMs: 1100 });
  await sender.sendAttention(event);
  await sender.sendAttention(event);
  assert.equal(apns.seen[0].headers.authorization, apns.seen[1].headers.authorization);
  expireNext = true;
  assert.equal((await sender.sendAttention(event)).sent, 1);
  assert.equal(apns.seen.length, 4);
  assert.notEqual(apns.seen[3].headers.authorization, apns.seen[2].headers.authorization);
  await apns.close();
});

test('cleared: a silent background push the app can act on', async () => {
  const apns = await fakeApns();
  const devices = new PushDevices(devicesFile());
  devices.add(TOK('a'), 'sandbox');
  const sender = new ApnsSender(devices, () => config({ sandboxUrl: apns.url }));
  assert.equal((await sender.sendCleared(cleared)).sent, 1);
  const [req] = apns.seen;
  assert.equal(req.headers['apns-push-type'], 'background');
  assert.equal(req.headers['apns-priority'], '5');
  assert.equal(req.headers['apns-collapse-id'], undefined);
  assert.deepEqual(req.body, { aps: { 'content-available': 1 }, type: 'attention-cleared', episode: event.episode, conversationId: 'conv-1', hubId: 'abcd1234' });
  await apns.close();
});

test('provider token helper signs what it is given', () => {
  const t = providerToken(readFileSync(keyFile, 'utf8'), 'K', 'T', 5000);
  assert.equal(JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).iat, 5);
});

test('sent ledger: an episode goes out once, across a hub restart', () => {
  const file = join(dir, 'sent.json');
  const first = new SentLedger(file);
  assert.equal(first.claim('e1'), true);
  assert.equal(first.claim('e1'), false);
  const after = new SentLedger(file);
  assert.equal(after.claim('e1'), false);
  assert.equal(after.has('e1'), true);
  assert.equal(after.has('e2'), false);
  for (let i = 0; i < 600; i++) after.claim(`x${i}`);
  assert.equal(new SentLedger(file).has('e1'), false, 'kept short');
  assert.equal(new SentLedger(file).has('x599'), true);
});
