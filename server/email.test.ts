import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { EmailReplies, EmailWatches, closeEmailWatch, emailRecipients, emailReplyPrompt, emailSubject, sendEmail, stripQuotedEmail, type EmailConfig, type HermodReply } from './email.js';
import type { AttentionEvent } from './needsYou.js';
import type { DeliverResult } from './sms.js';
import type { SessionInfo } from './types.js';

const dir = mkdtempSync(join(tmpdir(), 'deckhand-email-'));
const keyFile = join(dir, 'hermod.key');
writeFileSync(keyFile, 'hm_test\n');
const mailboxKeyFile = join(dir, 'raven.mailbox.key');
writeFileSync(mailboxKeyFile, 'hmb_test\n');
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

/** The last console.warn lines a run produced, with the console put back after. */
async function warnsOf(run: () => Promise<void>): Promise<string[]> {
  const warned: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => warned.push(args.join(' '));
  try {
    await run();
  } finally {
    console.warn = real;
  }
  return warned;
}

/** A stand-in for Hermod, keeping the notify, replies and close contract its source documents. */
async function fakeHermod(answer: { status?: number; body?: unknown } = {}) {
  const calls: { method?: string; path?: string; auth?: string; body?: Record<string, unknown> }[] = [];
  const state = { replies: [] as HermodReply[] };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
      const url = new URL(req.url!, 'http://x');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/v1/replies') {
        const since = Number(url.searchParams.get('since'));
        const limit = Number(url.searchParams.get('limit'));
        const page = state.replies.filter((r) => r.inboundId > since).slice(0, limit);
        return res.end(JSON.stringify({ replies: page, latestId: page.at(-1)?.inboundId ?? since }));
      }
      if (/^\/api\/v1\/sends\/\d+\/close$/.test(url.pathname)) {
        return res.end(JSON.stringify({ ledgerId: Number(url.pathname.split('/')[4]), replyState: 'closed' }));
      }
      res.statusCode = answer.status ?? 200;
      res.end(JSON.stringify(answer.body ?? { delivered: true, deferred: false, channel: 'email', ledgerId: 41 }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const config: EmailConfig = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, keyFile, mailboxKeyFile, person: 'cristian' };
  return { calls, state, config };
}

let watchFiles = 0;
const watches = () => new EmailWatches(join(dir, `watches-${watchFiles++}.json`));

const event = (over: Partial<AttentionEvent> = {}) =>
  ({ type: 'attention', episode: 'abcd1234-1', kind: 'question', text: 'Which one?', since: 1, name: 'RavenAgents', machine: 'mac', hubId: 'abcd1234', conversationId: 'c', state: 'IDLE', ...over }) as AttentionEvent;

test('subject: short, the session name and what it needs', () => {
  assert.equal(emailSubject(event()), 'RavenAgents on mac has a question');
  assert.equal(emailSubject(event({ kind: 'permission', machine: undefined })), 'RavenAgents wants approval');
});

test("send: follows Hermod's notify contract — the mailbox key chooses email, the episode is the correlationId, no reply deadline", async () => {
  const { calls, config } = await fakeHermod();
  assert.equal(await sendEmail(event(), config), true);
  assert.deepEqual(calls, [{
    method: 'POST', path: '/api/v1/notify', auth: 'Bearer hm_test',
    body: {
      person: 'cristian', subject: 'RavenAgents on mac has a question',
      message: 'Which one?', operation: 'deckhand-alert', correlationId: 'abcd1234-1', mailboxKey: 'hmb_test',
    },
  }]);
  for (const absent of ['channel', 'replyDeadlineSeconds', 'expectReply']) assert.ok(!(absent in calls[0].body!), absent);
});

test('send: expectReply goes out only when replies are on, and the watch is remembered by its ledgerId', async () => {
  const { calls, config } = await fakeHermod();
  const w = watches();
  assert.equal(await sendEmail(event(), { ...config, replies: true }, fetch, undefined, w), true);
  assert.equal(calls[0].body!.expectReply, true);
  assert.ok(!('replyDeadlineSeconds' in calls[0].body!));
  assert.equal(w.take('abcd1234-1'), 41);
  assert.equal(w.take('abcd1234-1'), undefined, 'taken is forgotten');
});

test('send: off without a complete block or either key file, and nothing is called', async () => {
  const { calls, config } = await fakeHermod();
  for (const off of [undefined, {}, { ...config, url: undefined }, { ...config, person: undefined }, { ...config, keyFile: undefined }, { ...config, mailboxKeyFile: undefined }, { ...config, keyFile: join(dir, 'none') }, { ...config, mailboxKeyFile: join(dir, 'none') }]) {
    assert.equal(await sendEmail(event(), off), false);
  }
  assert.equal(calls.length, 0);
});

test('send: a refusal, an undelivered answer or a dead Hermod is reported, not thrown', async () => {
  const refused = await fakeHermod({ status: 404, body: { error: "Unknown person 'x'." } });
  assert.equal(await sendEmail(event(), refused.config), false);
  assert.equal(refused.calls.length, 1);
  const undelivered = await fakeHermod({ body: { delivered: false, deferred: false, reason: 'no address' } });
  assert.equal(await sendEmail(event(), undelivered.config), false);
  const deferred = await fakeHermod({ body: { delivered: false, deferred: true } });
  assert.equal(await sendEmail(event(), deferred.config), true);
  assert.equal(await sendEmail(event(), { ...deferred.config, url: 'http://127.0.0.1:9' }), false);
});

test('send: a 403 names the API key file, an unknown mailbox key its file, and no warning carries a secret', async () => {
  const flagless = await fakeHermod({ status: 403, body: { error: "This key lacks the 'mailbox' flag — a mailbox key alone opens nothing." } });
  const rotated = await fakeHermod({ status: 400, body: { error: 'Unknown mailbox key.' } });
  const warned = await warnsOf(async () => {
    assert.equal(await sendEmail(event(), flagless.config), false);
    assert.equal(await sendEmail(event(), rotated.config), false);
  });
  assert.equal(warned.length, 2);
  assert.ok(warned[0].includes(keyFile) && /mailbox flag/.test(warned[0]), warned[0]);
  assert.ok(warned[1].includes(mailboxKeyFile) && /wrong or was rotated/.test(warned[1]), warned[1]);
  for (const line of warned) assert.ok(!line.includes('hm_test') && !line.includes('hmb_test'), 'no secret in a log line');
});

test('watches: an episode that ends unanswered closes its watch once; an answered or unknown one closes nothing', async () => {
  const hm = await fakeHermod();
  const w = watches();
  w.remember('ep1', 41);
  await closeEmailWatch('ep1', hm.config, w);
  await closeEmailWatch('ep1', hm.config, w);
  await closeEmailWatch('never-sent', hm.config, w);
  assert.deepEqual(hm.calls.map((c) => `${c.method} ${c.path}`), ['POST /api/v1/sends/41/close']);
  assert.equal(hm.calls[0].auth, 'Bearer hm_test');
});

test('send: the email goes to the person the session chose', async () => {
  const { calls, config } = await fakeHermod();
  assert.equal(await sendEmail(event(), config, fetch, 'sara'), true);
  assert.equal((calls[0].body as { person: string }).person, 'sara');
});

test('recipients: only people Hermod can mail; the configured person when it cannot say', async () => {
  const { config } = await fakeHermod();
  const people = (async () => new Response(JSON.stringify({ people: [{ slug: 'cristian', email: 'c@x.io' }, { slug: 'violet', email: null }] }))) as unknown as typeof fetch;
  assert.deepEqual(await emailRecipients(config, people), ['cristian']);
  const down = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
  assert.deepEqual(await emailRecipients(config, down), ['cristian']);
  assert.deepEqual(await emailRecipients({}, people), [], 'no sender here');
});

test('quoted history and the signature come out; only the new words stay', () => {
  const body = 'Take the blue one.\nAnd rerun the tests.\n\nOn Mon, Nov 3, 2026 at 9:12 AM Raven <raven@mori.guru> wrote:\n> RavenAgents: Which one?\n> something quoted';
  assert.equal(stripQuotedEmail(body), 'Take the blue one.\nAnd rerun the tests.');
  assert.equal(stripQuotedEmail('yes\r\n-- \r\nCristian\r\nSent from my phone'), 'yes');
  assert.equal(stripQuotedEmail('> only quotes\n>and this'), '');
  assert.equal(stripQuotedEmail('top\n> quoted\nbottom'), 'top\nbottom');
});

test('what the session reads: marked as email, one line, data, and never a slash command', () => {
  const out = emailReplyPrompt('/clear\x1b[2J\nyes\r‮all');
  assert.equal(out.split('\n').length, 1);
  assert.ok(out.startsWith('[Email from Cristian'));
  assert.match(out, /approves no tool use and no permission prompt/);
  assert.ok(out.endsWith('"/clear [2J yes all"'));
  assert.ok(emailReplyPrompt('x'.repeat(5000)).length < 700);
});

const card = (over: Partial<SessionInfo> = {}) =>
  ({ hubId: 'abcd1234', machine: 'mac', state: 'IDLE', attention: { episode: 'ep1', kind: 'question', text: 'Which?', since: 1, alertedAt: 2 }, ...over }) as unknown as SessionInfo;
const reply = (inboundId: number, over: Partial<HermodReply> = {}): HermodReply =>
  ({ inboundId, atUtc: new Date().toISOString(), channel: 'email', person: 'cristian', text: 'the blue one', ledgerId: 41, correlationId: 'ep1', matchedAskId: null, replyState: 'waiting', ...over });

let files = 0;
function poller(config: EmailConfig, sessions: SessionInfo[], result: () => DeliverResult = () => ({ delivered: true }), file = join(dir, `cursor-${files++}.json`), now?: () => number, w?: EmailWatches) {
  const delivered: { episode: string; text: string }[] = [];
  const replies = new EmailReplies({
    config: () => config,
    sessions: () => sessions,
    deliver: async (_c, a) => {
      const out = result();
      if ('delivered' in out) delivered.push(a);
      return out;
    },
    watches: w,
    file,
    now,
  });
  return { replies, delivered, file };
}

test('replies: off by default, Hermod is not even asked', async () => {
  const hm = await fakeHermod();
  hm.state.replies.push(reply(1));
  const { replies, delivered } = poller(hm.config, [card()]);
  await replies.poll();
  assert.equal(hm.calls.length, 0);
  assert.equal(delivered.length, 0);
});

test('replies: the waiting episode gets the stripped words, its watch needs no close, and the cursor survives a restart', async () => {
  const hm = await fakeHermod();
  hm.state.replies.push(reply(7, { text: 'the blue one\n\nOn Mon, Raven wrote:\n> Which one?' }));
  const config = { ...hm.config, replies: true };
  const w = watches();
  w.remember('ep1', 41);
  const first = poller(config, [card()], undefined, undefined, undefined, w);
  await first.replies.poll();
  assert.deepEqual(first.delivered, [{ episode: 'ep1', text: 'the blue one' }]);
  assert.equal(w.take('ep1'), undefined, 'the reply answered: the watch was taken, so an episode end closes nothing');
  assert.equal(hm.calls[0].path, '/api/v1/replies?since=0&limit=50');
  assert.equal(hm.calls[0].auth, 'Bearer hm_test');
  const second = poller(config, [card()], undefined, first.file);
  await second.replies.poll();
  assert.equal(second.delivered.length, 0);
  assert.equal(hm.calls[1].path, '/api/v1/replies?since=7&limit=50');
});

test('replies: another channel, someone else, no episode or no words are dropped and not retried', async () => {
  const hm = await fakeHermod();
  hm.state.replies.push(
    reply(1, { channel: 'discord' }),
    reply(2, { person: 'sara' }),
    reply(3, { correlationId: null }),
    reply(4, { text: '> nothing but quotes' }),
  );
  const { replies, delivered } = poller({ ...hm.config, replies: true }, [card()]);
  await replies.poll();
  assert.equal(delivered.length, 0);
  await replies.poll();
  assert.match(hm.calls.at(-1)!.path!, /since=4&/);
});

test('replies: late, another episode, a permission or an ask are dropped; a repeat cannot answer twice', async () => {
  const hm = await fakeHermod();
  hm.state.replies.push(reply(1, { correlationId: 'old-episode' }), reply(2));
  const config = { ...hm.config, replies: true };
  for (const sessions of [[], [card({ attention: { episode: 'ep1', kind: 'permission', text: 'x', since: 1 } })], [card({ attention: { episode: 'ep1', kind: 'ask', text: 'x', since: 1 } })]]) {
    const { replies, delivered } = poller(config, sessions);
    await replies.poll();
    assert.equal(delivered.length, 0);
  }
  const { replies, delivered, file } = poller(config, [card()]);
  await replies.poll();
  assert.equal(delivered.length, 1);
  hm.state.replies.push(reply(3, { text: 'no wait, red' }));
  const again = poller(config, [card()], undefined, file);
  await again.replies.poll();
  assert.equal(again.delivered.length, 0); // what was answered is saved with the cursor
});

test('replies: an unreachable hub holds the cursor, in order, until the reply is too old', async () => {
  const hm = await fakeHermod();
  const atUtc = new Date().toISOString();
  hm.state.replies.push(reply(1, { atUtc }));
  const sessions = [card({ unreachable: true })];
  let clock = Date.parse(atUtc);
  const { replies, delivered } = poller({ ...hm.config, replies: true }, sessions, undefined, undefined, () => clock);
  await replies.poll();
  await replies.poll();
  assert.equal(delivered.length, 0);
  assert.match(hm.calls.at(-1)!.path!, /since=0&/);
  sessions[0] = card();
  await replies.poll();
  assert.equal(delivered.length, 1);

  hm.state.replies.push(reply(9, { atUtc, correlationId: 'ep2' }));
  sessions[0] = card({ unreachable: true, attention: { episode: 'ep2', kind: 'question', text: 'x', since: 1 } });
  clock += 31 * 60_000;
  await replies.poll();
  await replies.poll();
  assert.match(hm.calls.at(-1)!.path!, /since=9&/);
});

test('replies: a hub that fails to deliver is tried again, one that refuses is not', async () => {
  const hm = await fakeHermod();
  hm.state.replies.push(reply(1));
  let out: DeliverResult = { retry: '502' };
  const { replies, delivered } = poller({ ...hm.config, replies: true }, [card()], () => out);
  await replies.poll();
  await replies.poll();
  assert.match(hm.calls.at(-1)!.path!, /since=0&/);
  out = { refused: 'gone' };
  await replies.poll();
  await replies.poll();
  assert.match(hm.calls.at(-1)!.path!, /since=1&/);
  assert.equal(delivered.length, 0);
});

test('replies: a Hermod that is down changes nothing', async () => {
  const hm = await fakeHermod();
  const { replies } = poller({ ...hm.config, url: 'http://127.0.0.1:9', replies: true }, [card()]);
  await replies.poll();
});
