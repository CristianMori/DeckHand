import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { askingText } from './askDetect.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetAttention, NeedsYou, SentLedger, alertChannels, attentionEvent, sendAlert, sendToDiscord, type AttentionEvent, type SendChannel } from './needsYou.js';
import { HubSession } from './sessionManager.js';
import type { SessionManager } from './sessionManager.js';
import type { SessionInfo } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DELAY = 40;
const attn = (s: HubSession) => s.attention; // keeps assert.equal from narrowing the field for later reads

function rig(reply: { text?: string } = {}) {
  const manager = new EventEmitter() as unknown as SessionManager;
  const session = {
    hubId: 'abcd1234', agentType: 'claude', state: 'WORKING', stateSince: Date.now(), detail: undefined,
    proc: {}, autoYes: false,
  } as unknown as HubSession;
  const protect = { on: false };
  const needs = new NeedsYou(manager, {
    lastReply: async () => reply.text,
    isProtectedPrompt: () => protect.on,
    delayMs: () => DELAY,
    flushWaitsMs: [1, 1],
  });
  const set = (state: SessionInfo['state'], detail?: string) => {
    session.state = state;
    session.detail = detail;
    session.stateSince = Date.now();
    manager.emit('change', session);
  };
  return { session, needs, set, protect };
}

test('askingText: replies that end by asking', () => {
  for (const r of [
    'Done.\n\nWant me to deploy it?',
    'Which one do you want? Either is quick to do.',
    'It failed. **Did the text show up on the lens?**',
    'Whenever you have it: **A, B or none?** That tells us if it repeats.',
    'Which should I use?\n\n1. the first\n2. the second',
    'Two options here. Let me know which you prefer.',
    'Please confirm the path.',
  ]) assert.ok(askingText(r), r);
});

test('askingText: replies that do not', () => {
  for (const r of [
    undefined,
    '',
    'All done, tests pass.',
    'Why did it fail? The port was taken, so I moved the whole thing over to 5971 and it works now, on every machine that I tried it on today, including the two that had been failing all week.',
    'Run this:\n\n```\nwhat is this?\n```',
    'See `isThisOk?` for details.',
    'It is at https://example.com/a?b=1',
    'Tell me if you want it back.',
  ]) assert.equal(askingText(r), undefined, String(r));
});

test('a turn ending in a question flags at once, alerts after the delay, clears on the next prompt', async () => {
  const { session, needs, set } = rig({ text: 'Want me to go on?' });
  needs.turnStarted(session);
  set('IDLE', 'turn finished');
  await sleep(15);
  assert.equal(session.attention?.kind, 'question');
  assert.equal(session.attention?.alertedAt, undefined);
  await sleep(DELAY + 10);
  assert.ok(session.attention?.alertedAt);
  needs.turnStarted(session);
  assert.equal(attn(session), undefined);
});

test('a reply that does not ask is not flagged', async () => {
  const { session, needs, set } = rig({ text: 'All done.' });
  needs.turnStarted(session);
  set('IDLE', 'turn finished');
  await sleep(DELAY + 15);
  assert.equal(attn(session), undefined);
});

test("a prompt from another session, an agent or Mimir: not the user's to answer", async () => {
  for (const caller of ['session:abc/def@desktop', 'agent:abc@laptop', 'gateway:ron', 'mimir']) {
    const { session, needs, set } = rig({ text: 'Want me to go on?' });
    needs.promptFrom(session, caller, false);
    needs.turnStarted(session);
    set('IDLE', 'turn finished');
    await sleep(15);
    assert.equal(attn(session), undefined, caller);
    set('WAITING_PERMISSION', 'needs approval');
    assert.equal(attn(session), undefined, caller);
  }
});

test("a prompt from the dashboard, the API or the terminal is the user's", async () => {
  for (const caller of ['dashboard', 'api', undefined]) {
    const { session, needs, set } = rig({ text: 'Want me to go on?' });
    if (caller) needs.promptFrom(session, caller, false);
    needs.turnStarted(session);
    set('IDLE', 'turn finished');
    await sleep(15);
    assert.ok(session.attention, String(caller));
  }
});

test("after a session-sent turn, the user's next turn counts again", async () => {
  const reply = { text: 'All done.' };
  const { session, needs, set } = rig(reply);
  needs.promptFrom(session, 'session:x', false);
  needs.turnStarted(session);
  set('IDLE', 'turn finished');
  await sleep(10);
  assert.equal(attn(session), undefined);
  reply.text = 'Want me to go on?';
  needs.turnStarted(session); // typed in the terminal
  set('WORKING');
  set('IDLE', 'turn finished');
  await sleep(15);
  assert.equal(session.attention?.kind, 'question');
});

test('a restart or resume does not raise the old last reply again', async () => {
  const { session, needs, set } = rig({ text: 'Want me to go on?' });
  needs.turnStarted(session);
  set('STARTING');
  set('IDLE', 'turn finished'); // the sessions file reports a resumed session idle
  await sleep(15);
  assert.equal(attn(session), undefined);
});

test('a late transcript flush: the previous reply is not judged as this turn', async () => {
  const reply = { text: 'Want me to go on?' };
  const { session, needs, set } = rig(reply);
  needs.turnStarted(session);
  set('IDLE', 'turn finished');
  await sleep(15);
  assert.ok(session.attention);
  needs.turnStarted(session);
  set('WORKING');
  set('IDLE', 'turn finished'); // the transcript still ends with the old question
  await sleep(15);
  assert.equal(attn(session), undefined);
});

test('permission and ask count, and clear when the session moves on', () => {
  const { session, set } = rig();
  set('WAITING_PERMISSION', 'needs approval');
  assert.equal(session.attention?.kind, 'permission');
  set('WORKING');
  assert.equal(attn(session), undefined);
  set('WAITING_QUESTION', 'pick one');
  assert.equal(session.attention?.kind, 'ask');
  assert.equal(session.attention?.text, 'pick one');
  set('EXITED');
  assert.equal(attn(session), undefined);
});

test('auto-yes: permission is not flagged, unless it is the prompt auto-yes refuses', () => {
  const { session, set, protect } = rig();
  session.autoYes = true;
  set('WAITING_PERMISSION', 'needs approval');
  assert.equal(attn(session), undefined);
  set('WORKING');
  protect.on = true;
  set('WAITING_PERMISSION', 'exit plan mode?');
  assert.equal(session.attention?.kind, 'permission');
});

test('answered within the delay: no alert, and the next wait is a new episode', async () => {
  const { session, set } = rig();
  set('WAITING_PERMISSION', 'needs approval');
  const first = session.attention!.episode;
  set('WORKING');
  await sleep(DELAY + 10);
  assert.equal(attn(session), undefined);
  set('WAITING_PERMISSION', 'needs approval');
  assert.notEqual(session.attention!.episode, first);
  assert.equal(session.attention!.alertedAt, undefined);
});

test('one alert per episode, even when the question changes kind', async () => {
  const { session, set } = rig();
  let alerts = 0;
  let was: number | undefined;
  const count = () => {
    if (session.attention?.alertedAt && session.attention.alertedAt !== was) {
      was = session.attention.alertedAt;
      alerts++;
    }
  };
  const timer = setInterval(count, 2);
  set('WAITING_QUESTION', 'pick one');
  const episode = session.attention!.episode;
  set('WAITING_PERMISSION', 'needs approval');
  assert.equal(session.attention!.episode, episode);
  await sleep(DELAY + 25);
  clearInterval(timer);
  assert.equal(alerts, 1);
});

const card = (over: Partial<SessionInfo>): SessionInfo =>
  ({ hubId: 'abcd1234', claudeSessionId: 'conv', name: 'Proj', machine: 'mac', state: 'IDLE', ...over }) as SessionInfo;

test('fleet: one announcement per episode, one clear, nothing before alertedAt', () => {
  const said: AttentionEvent[] = [];
  const cleared: string[] = [];
  const fleet = new FleetAttention({ announce: (e) => said.push(e), cleared: (e) => cleared.push(e.episode) });
  const now = Date.now();
  const a = { episode: 'e1', kind: 'question' as const, text: 'Which?', since: now };
  fleet.scan([card({ attention: a })], now);
  assert.equal(said.length, 0);
  const alerted = card({ attention: { ...a, alertedAt: now } });
  fleet.scan([alerted], now);
  fleet.scan([alerted], now);
  assert.equal(said.length, 1);
  assert.deepEqual(said[0], {
    type: 'attention', episode: 'e1', hubId: 'abcd1234', conversationId: 'conv', name: 'Proj', machine: 'mac',
    state: 'IDLE', kind: 'question', text: 'Which?', since: now, alertedAt: now,
  });
  fleet.scan([card({})], now);
  assert.deepEqual(cleared, ['e1']);
});

test('fleet: an old alert seen after a restart is not announced again, but its end is', () => {
  const said: unknown[] = [];
  const cleared: unknown[] = [];
  const fleet = new FleetAttention({ announce: (e) => said.push(e), cleared: (e) => cleared.push(e) });
  const now = Date.now();
  fleet.scan([card({ attention: { episode: 'old', kind: 'ask', text: 'x', since: now - 3_600_000, alertedAt: now - 3_500_000 } })], now);
  assert.equal(said.length, 0);
  fleet.scan([card({})], now);
  assert.deepEqual(cleared, [{ type: 'attention-cleared', episode: 'old', hubId: 'abcd1234', conversationId: 'conv', machine: 'mac' }]);
});

const event = attentionEvent(card({ attention: { episode: 'e1', kind: 'question', text: 'Which?', since: 1, alertedAt: 2 } }))!;

test('discord: off without a key, and nothing is sent', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response('{}');
  }) as typeof fetch;
  assert.equal(await sendToDiscord(event, {}, fetcher), false);
  assert.equal(await sendToDiscord(event, { hermod: { url: 'http://h' } }, fetcher), false);
  assert.equal(calls, 0);
});

test("discord: follows Hermod's notify contract", async () => {
  let url = '';
  let init: RequestInit = {};
  const fetcher = (async (u: string, i: RequestInit) => {
    url = u;
    init = i;
    return new Response(JSON.stringify({ delivered: true, channel: 'discord' }));
  }) as unknown as typeof fetch;
  assert.equal(await sendToDiscord(event, { hermod: { url: 'http://h:5103/', key: 'hm_test' } }, fetcher), true);
  assert.equal(url, 'http://h:5103/api/v1/notify');
  assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer hm_test');
  assert.deepEqual(JSON.parse(String(init.body)), {
    person: 'cristian', channel: 'discord', subject: 'Proj on mac has a question', message: 'Which?',
    operation: 'deckhand-attention', correlationId: 'e1',
  });
});

test('discord: a failure or an undeliverable answer is reported, not thrown', async () => {
  const cfg = { hermod: { url: 'http://h', key: 'hm_test' } };
  const down = (async () => {
    throw new Error('refused');
  }) as typeof fetch;
  assert.equal(await sendToDiscord(event, cfg, down), false);
  const undelivered = (async () => new Response(JSON.stringify({ delivered: false, deferred: false, reason: 'no channel' }))) as typeof fetch;
  assert.equal(await sendToDiscord(event, cfg, undelivered), false);
  const deferred = (async () => new Response(JSON.stringify({ delivered: false, deferred: true }))) as typeof fetch;
  assert.equal(await sendToDiscord(event, cfg, deferred), true);
});

test('alert channels: only exactly true is on', () => {
  for (const bad of [undefined, null, 'yes', 1, [], {}, { discord: 'true', text: 1 }]) {
    assert.deepEqual(alertChannels(bad), { discord: false, text: false }, JSON.stringify(bad));
  }
  assert.deepEqual(alertChannels({ discord: true }), { discord: true, text: false });
});

function sendRig(file = join(mkdtempSync(join(tmpdir(), 'alerts-')), 'sent.json')) {
  const went: SendChannel[] = [];
  const send = { push: () => went.push('push'), discord: () => went.push('discord'), text: () => went.push('text') };
  return { file, went, send, ledger: new SentLedger(file) };
}

test('a session with nothing chosen sends push only', () => {
  for (const alerts of [undefined, { discord: false, text: false }]) {
    const { went, send, ledger } = sendRig();
    sendAlert(event, { alerts }, ledger, send);
    assert.deepEqual(went, ['push']);
  }
});

test('each channel follows its own setting', () => {
  const a = sendRig();
  sendAlert(event, { alerts: { discord: true, text: false } }, a.ledger, a.send);
  assert.deepEqual(a.went, ['push', 'discord']);
  const b = sendRig();
  sendAlert(event, { alerts: { discord: false, text: true } }, b.ledger, b.send);
  assert.deepEqual(b.went, ['push', 'text']);
});

test('a channel that was off is not marked sent; one that was on is not sent twice, across a restart', () => {
  const first = sendRig();
  sendAlert(event, { alerts: { discord: true, text: false } }, first.ledger, first.send);
  assert.deepEqual(JSON.parse(readFileSync(first.file, 'utf8')), ['push:e1', 'discord:e1']);
  const again = sendRig(first.file);
  sendAlert(event, { alerts: { discord: true, text: true } }, again.ledger, again.send);
  assert.deepEqual(again.went, ['text']);
});

test('an episode in the old ledger format went out everywhere: nothing goes again', () => {
  const { file, went, send } = sendRig();
  writeFileSync(file, JSON.stringify(['e1']));
  const ledger = new SentLedger(file);
  sendAlert(event, { alerts: { discord: true, text: true } }, ledger, send);
  assert.deepEqual(went, []);
  assert.equal(ledger.has('e1'), true, 'its clear still goes out');
});

test('the sender goes by the card as the owner published it with the alert', () => {
  const asked = { episode: 'e9', kind: 'question' as const, text: 'Which?', since: 1, alertedAt: Date.now() };
  const { went, send, ledger } = sendRig();
  const fleet = new FleetAttention({ announce: (e, c) => sendAlert(e, c, ledger, send), cleared: () => {} });
  // waiting, not alerted yet, while the setting is off: nothing goes
  fleet.scan([card({ machine: 'peer', alerts: { discord: false, text: false }, attention: { ...asked, alertedAt: undefined } })]);
  assert.deepEqual(went, []);
  // turned on during the wait: the card with alertedAt carries it
  const on = card({ machine: 'peer', alerts: { discord: false, text: true }, attention: asked });
  fleet.scan([on]);
  fleet.scan([on]);
  assert.deepEqual(went, ['push', 'text']);
});

test('a new card is off; a card moved here takes the choice it is given', () => {
  assert.deepEqual(new HubSession({ cwd: '/x', agentType: 'claude' }).info().alerts, { discord: false, text: false });
  assert.deepEqual(new HubSession({ cwd: '/x', agentType: 'claude', alerts: { discord: true, text: false } }).info().alerts, { discord: true, text: false });
});
