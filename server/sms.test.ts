import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { typePrompt } from './automation.js';
import type { AttentionEvent } from './needsYou.js';
import type { HubSession, SessionManager } from './sessionManager.js';
import { SmsReplies, sendText, smsText, textReplyPrompt, textReplyRefusal, type DeliverResult, type GatewayReply, type SmsConfig } from './sms.js';
import type { SessionInfo } from './types.js';

const dir = mkdtempSync(join(tmpdir(), 'deckhand-sms-'));
const tokenFile = join(dir, 'token');
writeFileSync(tokenFile, 'test-token\n');
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

/** A stand-in for hermod-gateway, keeping the contract it documents. */
async function fakeGateway(answer: { status?: number; body?: unknown } = {}) {
  const calls: { method?: string; path?: string; auth?: string; body?: Record<string, unknown> }[] = [];
  const state = { replies: [] as (GatewayReply & { id: number })[] };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
      const url = new URL(req.url!, 'http://x');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/v1/replies') {
        const since = Number(url.searchParams.get('since'));
        const limit = Number(url.searchParams.get('limit'));
        return res.end(JSON.stringify({ replies: state.replies.filter((r) => r.id > since).slice(0, limit) }));
      }
      res.statusCode = answer.status ?? 200;
      res.end(JSON.stringify(answer.body ?? { ok: true, textId: 't1', quotaRemaining: 9, replies: false }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const config: SmsConfig = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, tokenFile, to: 'cristian' };
  return { calls, state, config };
}

const event = (over: Partial<AttentionEvent> = {}) =>
  ({ type: 'attention', episode: 'abcd1234-1', kind: 'question', text: 'Which one?', since: 1, name: 'RavenAgents', hubId: 'abcd1234', conversationId: 'c', state: 'IDLE', ...over }) as AttentionEvent;

test('text: name and question', () => {
  assert.equal(smsText(event()), 'RavenAgents: Which one?');
});

test('text: a permission says so', () => {
  assert.equal(smsText(event({ kind: 'permission', text: 'Bash: ls' })), 'RavenAgents wants approval: Bash: ls');
});

test('text: URLs come out, so the gateway does not refuse it', () => {
  const out = smsText(event({ text: 'See https://x.io/a?b=1 or HTTP://y.io and www.z.io/q, ok?' }));
  assert.equal(out, 'RavenAgents: See or and ok?');
  assert.doesNotMatch(out, /(?:https?:\/\/|\bwww\.)/i); // the gateway's own test
});

test('text: new lines fold and a long one is trimmed to the limit', () => {
  assert.equal(smsText(event({ text: 'One\n\nTwo?' })), 'RavenAgents: One Two?');
  const out = smsText(event({ text: 'x'.repeat(600) }));
  assert.equal(out.length, 320);
  assert.ok(out.endsWith('...'));
});

test('send: the contract, with the episode as the session handle', async () => {
  const { calls, config } = await fakeGateway();
  assert.equal(await sendText(event(), config), true);
  assert.deepEqual(calls, [{
    method: 'POST', path: '/v1/send', auth: 'Bearer test-token',
    body: { to: 'cristian', message: 'RavenAgents: Which one?', session: 'abcd1234-1' },
  }]);
});

test('send: off without a complete block or a token file, and nothing is called', async () => {
  const { calls, config } = await fakeGateway();
  for (const off of [undefined, {}, { ...config, url: undefined }, { ...config, to: undefined }, { ...config, tokenFile: undefined }, { ...config, tokenFile: join(dir, 'none') }]) {
    assert.equal(await sendText(event(), off), false);
  }
  assert.equal(calls.length, 0);
});

test('send: a refusal or a dead gateway is reported, not thrown, and not retried', async () => {
  const { calls, config } = await fakeGateway({ status: 429, body: { error: 'out of quota' } });
  assert.equal(await sendText(event(), config), false);
  assert.equal(calls.length, 1);
  assert.equal(await sendText(event(), { ...config, url: 'http://127.0.0.1:9' }), false);
});

const card = (over: Partial<SessionInfo> = {}) =>
  ({ hubId: 'abcd1234', machine: 'mac', state: 'IDLE', attention: { episode: 'ep1', kind: 'question', text: 'Which?', since: 1, alertedAt: 2 }, ...over }) as unknown as SessionInfo;
const reply = (id: number, over: Partial<GatewayReply> = {}): GatewayReply & { id: number } =>
  ({ id, textId: 't', session: 'ep1', to: 'cristian', text: 'the blue one', at: new Date().toISOString(), seq: 1, repeat: false, kind: 'answer', ...over }) as GatewayReply & { id: number };

let files = 0;
function poller(config: SmsConfig, sessions: SessionInfo[], result: () => DeliverResult = () => ({ delivered: true }), file = join(dir, `cursor-${files++}.json`), now?: () => number) {
  const delivered: GatewayReply[] = [];
  const replies = new SmsReplies({
    config: () => config,
    sessions: () => sessions,
    deliver: async (_c, r) => {
      const out = result();
      if ('delivered' in out) delivered.push(r);
      return out;
    },
    file,
    now,
  });
  return { replies, delivered, file };
}

test('replies: off by default, the gateway is not even asked', async () => {
  const gw = await fakeGateway();
  gw.state.replies.push(reply(1));
  const { replies, delivered } = poller(gw.config, [card()]);
  await replies.poll();
  assert.equal(gw.calls.length, 0);
  assert.equal(delivered.length, 0);
});

test('replies: the waiting episode gets it, and the saved cursor survives a restart', async () => {
  const gw = await fakeGateway();
  gw.state.replies.push(reply(7));
  const config = { ...gw.config, replies: true };
  const first = poller(config, [card()]);
  await first.replies.poll();
  assert.equal(first.delivered.length, 1);
  assert.equal(gw.calls[0].path, '/v1/replies?since=0&limit=50');
  assert.equal(gw.calls[0].auth, 'Bearer test-token');
  const second = poller(config, [card()], undefined, first.file);
  await second.replies.poll();
  assert.equal(second.delivered.length, 0);
  assert.equal(gw.calls[1].path, '/v1/replies?since=7&limit=50');
});

test('replies: late, another episode, a permission or an ask are dropped and not retried', async () => {
  const gw = await fakeGateway();
  gw.state.replies.push(reply(1, { session: 'old-episode' }), reply(2));
  const config = { ...gw.config, replies: true };
  for (const sessions of [[], [card({ attention: { episode: 'ep1', kind: 'permission', text: 'x', since: 1 } })], [card({ attention: { episode: 'ep1', kind: 'ask', text: 'x', since: 1 } })]]) {
    const { replies, delivered } = poller(config, sessions);
    await replies.poll();
    assert.equal(delivered.length, 0);
    await replies.poll();
    assert.match(gw.calls.at(-1)!.path!, /since=2&/);
  }
});

test('replies: a repeat cannot answer twice, even while the card still looks like it is waiting', async () => {
  const gw = await fakeGateway();
  gw.state.replies.push(reply(1), reply(2, { seq: 2, repeat: true, text: 'no wait, red' }));
  const { replies, delivered, file } = poller({ ...gw.config, replies: true }, [card()]);
  await replies.poll();
  assert.deepEqual(delivered.map((r) => r.text), ['the blue one']);
  gw.state.replies.push(reply(3, { seq: 3, repeat: true }));
  const again = poller({ ...gw.config, replies: true }, [card()], undefined, file);
  await again.replies.poll();
  assert.equal(again.delivered.length, 0); // what was answered is saved with the cursor
});

test('replies: anything but an answer for this recipient, with words, is dropped', async () => {
  const gw = await fakeGateway();
  gw.state.replies.push(reply(1, { kind: 'approval' }), reply(2, { to: 'sara' }), reply(3, { text: ' \n ' }), reply(4, { session: null }));
  const { replies, delivered } = poller({ ...gw.config, replies: true }, [card()]);
  await replies.poll();
  assert.equal(delivered.length, 0);
});

test('replies: an unreachable hub holds the cursor, in order, until the reply is too old', async () => {
  const gw = await fakeGateway();
  const at = new Date().toISOString();
  gw.state.replies.push(reply(1, { at }), reply(2, { at, session: 'other' }));
  const sessions = [card({ unreachable: true })];
  let clock = Date.parse(at);
  const { replies, delivered } = poller({ ...gw.config, replies: true }, sessions, undefined, undefined, () => clock);
  await replies.poll();
  await replies.poll();
  assert.equal(delivered.length, 0);
  assert.match(gw.calls.at(-1)!.path!, /since=0&/);
  sessions[0] = card();
  await replies.poll();
  assert.equal(delivered.length, 1);
  assert.match(gw.calls.at(-1)!.path!, /since=0&/);

  gw.state.replies.length = 0;
  gw.state.replies.push(reply(9, { at, session: 'ep2' }));
  sessions[0] = card({ unreachable: true, attention: { episode: 'ep2', kind: 'question', text: 'x', since: 1 } });
  clock += 31 * 60_000;
  await replies.poll();
  await replies.poll();
  assert.match(gw.calls.at(-1)!.path!, /since=9&/);
});

test('replies: a hub that fails to deliver is tried again, one that refuses is not', async () => {
  const gw = await fakeGateway();
  gw.state.replies.push(reply(1));
  let out: DeliverResult = { retry: '502' };
  const { replies, delivered } = poller({ ...gw.config, replies: true }, [card()], () => out);
  await replies.poll();
  await replies.poll();
  assert.match(gw.calls.at(-1)!.path!, /since=0&/);
  out = { refused: 'gone' };
  await replies.poll();
  await replies.poll();
  assert.match(gw.calls.at(-1)!.path!, /since=1&/);
  assert.equal(delivered.length, 0);
});

test('replies: a gateway that is down changes nothing', async () => {
  const gw = await fakeGateway();
  const { replies } = poller({ ...gw.config, url: 'http://127.0.0.1:9', replies: true }, [card()]);
  await replies.poll();
});

test('the owning hub types only into that episode, a question, at its prompt', () => {
  const s = { proc: {}, state: 'IDLE', attention: { episode: 'ep1', kind: 'question', text: 'x', since: 1 } } as Parameters<typeof textReplyRefusal>[0];
  assert.equal(textReplyRefusal(s, 'ep1', false), undefined);
  assert.ok(textReplyRefusal(s, 'ep2', false));
  assert.ok(textReplyRefusal(s, 'ep1', true));
  assert.ok(textReplyRefusal({ ...s, proc: undefined }, 'ep1', false));
  assert.ok(textReplyRefusal({ ...s, attention: undefined }, 'ep1', false));
  assert.ok(textReplyRefusal({ ...s, state: 'WAITING_PERMISSION' }, 'ep1', false));
  assert.ok(textReplyRefusal({ ...s, state: 'WORKING' }, 'ep1', false));
  for (const kind of ['permission', 'ask'] as const) {
    assert.ok(textReplyRefusal({ ...s, attention: { ...s.attention!, kind } }, 'ep1', false));
  }
});

test('what the session reads: marked, one line, data, and never a slash command', () => {
  const out = textReplyPrompt('/clear\x1b[2J\nyes\r‮all');
  assert.equal(out.split('\n').length, 1);
  assert.ok(out.startsWith('[Text message from Cristian'));
  assert.match(out, /approves no tool use and no permission prompt/);
  assert.ok(out.endsWith('"/clear [2J yes all"'));
  assert.ok(textReplyPrompt('x'.repeat(5000)).length < 700);
});

test('typing: Enter is not pressed if the session moved on while the text went in', async () => {
  const written: string[] = [];
  const manager = { write: (_id: string, d: string) => written.push(d) } as unknown as SessionManager;
  const session = { hubId: 'h', state: 'IDLE' } as HubSession;
  assert.equal(await typePrompt(manager, session, 'hello', () => false), false);
  assert.deepEqual(written, ['hello']);
  assert.equal(await typePrompt(manager, session, 'hello', () => true), true);
  assert.deepEqual(written, ['hello', 'hello', '\r']);
});
