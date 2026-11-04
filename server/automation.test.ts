import { test } from 'node:test';
import assert from 'node:assert';
import {
  jsonEscaped,
  MAX_PROMPT_BYTES,
  probesPresent,
  promptProbes,
  typePrompt,
  verifyPromptDelivery,
} from './automation.js';
import type { HubSession, SessionManager } from './sessionManager.js';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** A manager that records every write; `on`/`off` satisfy waitUntil. */
function fakeManager() {
  const writes: string[] = [];
  const manager = {
    write: (_id: string, data: string) => writes.push(data),
    on: () => manager,
    off: () => manager,
  } as unknown as SessionManager;
  return { manager, writes };
}

const fakeSession = (over: Record<string, unknown> = {}) =>
  ({
    hubId: 's1',
    claudeSessionId: 's1-conv',
    name: 's1',
    agentType: 'claude',
    cwd: 'C:/nowhere/at-all',
    // WORKING skips typePrompt's did-the-agent-start wait — the unit under
    // test here is what gets written, not the state machine
    state: 'WORKING',
    proc: {},
    screenText: () => '',
    ...over,
  }) as unknown as HubSession;

// ---------------------------------------------------------------- probes

test('promptProbes: multi-line text gives head, middle and tail lines', () => {
  const lines = Array.from({ length: 99 }, (_, i) => `line number ${String(i).padStart(4, '0')} with some words`);
  const probes = promptProbes(lines.join('\n'));
  assert.equal(probes.length, 3);
  assert.ok(probes[0].startsWith('line number 0000'));
  assert.ok(probes[1].startsWith('line number 0049'));
  assert.ok(probes[2].startsWith('line number 0098'));
});

test('promptProbes: probes are cut to 60 chars and deduplicated', () => {
  const one = promptProbes('just one line, short');
  assert.deepEqual(one, ['just one line, short']);
  const long = promptProbes('x'.repeat(500));
  assert.deepEqual(long, ['x'.repeat(60)]);
});

test('promptProbes: skips blank and tiny lines (a trailing newline breaks nothing)', () => {
  const probes = promptProbes('a real first line here\n\n-\n\na real last line here\n');
  assert.equal(probes[0], 'a real first line here');
  assert.equal(probes[probes.length - 1], 'a real last line here');
});

test('probesPresent: finds probes in JSONL transcripts (escaped) and on screens (plain)', () => {
  const probes = promptProbes('say "hello"\nmiddle line of text\npath C:\\tmp\\x');
  const jsonl = `{"type":"user","message":{"content":${JSON.stringify('say "hello"\nmiddle line of text\npath C:\\tmp\\x')}}}`;
  assert.ok(probesPresent(jsonl, probes));
  const screen = 'say "hello"\nmiddle line of text\npath C:\\tmp\\x';
  assert.ok(probesPresent(screen, probes));
  assert.ok(!probesPresent('something else entirely', probes));
});

test('jsonEscaped matches what JSON.stringify writes into a transcript line', () => {
  assert.equal(jsonEscaped('a "b" c\\d'), 'a \\"b\\" c\\\\d');
});

// ---------------------------------------------------------------- typePrompt

test('typePrompt wraps a TUI prompt in one bracketed paste, CR in its own write', async () => {
  const { manager, writes } = fakeManager();
  const text = 'first line\nsecond line\nthird line';
  const ok = await typePrompt(manager, fakeSession(), text);
  assert.equal(ok, true);
  assert.equal(writes[0], PASTE_START);
  assert.equal(writes[writes.length - 2], PASTE_END);
  assert.equal(writes[writes.length - 1], '\r');
  assert.equal(writes.slice(1, -2).join(''), text);
});

test('typePrompt writes long text in pieces no bigger than 1 KiB', async () => {
  const { manager, writes } = fakeManager();
  const text = 'HEAD-MARK ' + 'y'.repeat(5000) + ' TAIL-MARK';
  // screen already shows the text so the delivery guard settles immediately
  await typePrompt(manager, fakeSession({ screenText: () => text }), text);
  const pieces = writes.slice(1, -2);
  assert.ok(pieces.length >= 5, `expected several pieces, got ${pieces.length}`);
  assert.ok(pieces.every((p) => p.length <= 1024));
  assert.equal(pieces.join(''), text);
});

test('typePrompt types a shell prompt raw — no paste markers a shell would echo as junk', async () => {
  const { manager, writes } = fakeManager();
  const text = 'echo hello';
  await typePrompt(manager, fakeSession({ agentType: 'shell' }), text);
  assert.deepEqual(writes, [text, '\r']);
});

test('typePrompt refuses an oversized prompt instead of silently cutting it', async () => {
  const { manager, writes } = fakeManager();
  const text = 'z'.repeat(MAX_PROMPT_BYTES + 1);
  await assert.rejects(() => typePrompt(manager, fakeSession(), text), /refuses prompts over/);
  assert.equal(writes.length, 0);
});

test('typePrompt holds the CR when mayEnter says no', async () => {
  const { manager, writes } = fakeManager();
  await typePrompt(manager, fakeSession(), 'short text', () => false);
  assert.ok(!writes.includes('\r'));
});

// ---------------------------------------------------------------- the guard

test('verifyPromptDelivery passes when the screen shows the whole text', async () => {
  const text = 'alpha first line\nbeta middle line\ngamma last line';
  const session = fakeSession({ agentType: 'shell', screenText: () => text });
  assert.equal(await verifyPromptDelivery(session, text, { attempts: 2, delayMs: 1 }), true);
});

test('verifyPromptDelivery fails loudly when part of the text is gone', async () => {
  const text = 'alpha first line\nbeta middle line\ngamma last line';
  // the screen kept head and tail but lost the middle — the real 64 KB shape
  const session = fakeSession({ agentType: 'shell', screenText: () => 'alpha first line\ngamma last line' });
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(' '));
  try {
    assert.equal(await verifyPromptDelivery(session, text, { attempts: 2, delayMs: 1 }), false);
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /LOST PROMPT/);
  assert.match(errors[0], /beta middle line/);
});
