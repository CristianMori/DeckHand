import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { claudeAdapter } from './agents/claude.js';
import { codexAdapter } from './agents/codex.js';
import { composerBusy, composerDraft, typePrompt } from './automation.js';
import type { HubSession, SessionManager } from './sessionManager.js';

/**
 * Bug 6 (2026-11-03): text the hub types into a session can merge with a draft
 * the user is typing. The fix reads the composer off the screen mirror first.
 * The screens here are real captures — see agents/screens/README.md.
 */

const screen = (name: string) => readFileSync(fileURLToPath(new URL(`./agents/screens/${name}.txt`, import.meta.url)), 'utf8');

test('claude: an empty composer reads as empty, placeholder hint and all', () => {
  assert.equal(claudeAdapter.composerText?.(screen('claude-empty')), ''); // "❯ Try \"…\"" hint
  assert.equal(claudeAdapter.composerText?.(screen('claude-hub-working')), ''); // bare "> " under a spinner
});

test('claude: typed text in the composer reads back as the draft', () => {
  assert.equal(claudeAdapter.composerText?.(screen('claude-draft')), 'draft the user is typing');
});

test('claude: a dialog cursor is not a composer, and the trust dialog is recognized', () => {
  // "❯ No, exit" is a menu cursor, not framed by the composer rules
  assert.equal(claudeAdapter.composerText?.(screen('claude-startup')), undefined);
  assert.match(claudeAdapter.startupDialog?.(screen('claude-startup')) ?? '', /folder trust dialog/);
});

test('codex: placeholder is empty, typed text is a draft, menus count as busy', () => {
  assert.equal(codexAdapter.composerText?.(screen('codex-empty')), ''); // "Ask Codex to do anything"
  assert.equal(codexAdapter.composerText?.(screen('codex-draft')), 'draft the user is typing');
  // the hooks-review menu reuses the composer character: typing would land in it
  assert.notEqual(codexAdapter.composerText?.(screen('codex-dialog')) ?? '', '');
  assert.match(codexAdapter.startupDialog?.(screen('codex-dialog')) ?? '', /hooks-review dialog/);
});

test('a signed-out engine is recognized from the screen, a working one is not', () => {
  // "Login expired · Please run /login" after a prompt (the 2026-11-04 incident), and the status line
  assert.match(claudeAdapter.loggedOut?.(screen('claude-logged-out')) ?? '', /login expired/i);
  assert.match(claudeAdapter.loggedOut?.(screen('claude-not-logged-in')) ?? '', /not logged in/i);
  assert.equal(claudeAdapter.loggedOut?.(screen('claude-empty')), undefined);
  assert.equal(claudeAdapter.loggedOut?.(screen('claude-draft')), undefined);
  assert.equal(claudeAdapter.loggedOut?.(screen('claude-hub-working')), undefined);
  assert.match(codexAdapter.loggedOut?.(screen('codex-logged-out')) ?? '', /not logged in/i);
  assert.equal(codexAdapter.loggedOut?.(screen('codex-empty')), undefined);
  assert.equal(codexAdapter.loggedOut?.(screen('codex-draft')), undefined);
});

function fake(screenBody: string | undefined, agentType = 'claude') {
  const writes: string[] = [];
  const session = {
    hubId: 's1',
    agentType,
    proc: {},
    state: 'IDLE',
    screenText: () => {
      if (screenBody === undefined) throw new Error('no mirror');
      return screenBody;
    },
  } as unknown as HubSession;
  const manager = { write: (_id: string, data: string) => void writes.push(data) } as unknown as SessionManager;
  return { session, manager, writes };
}

test('composerDraft and composerBusy read the session screen, and fail open', () => {
  assert.equal(composerDraft(fake(screen('claude-draft')).session), 'draft the user is typing');
  assert.equal(composerBusy(fake(screen('claude-draft')).session), true);
  assert.equal(composerBusy(fake(screen('claude-empty')).session), false);
  assert.equal(composerBusy(fake(undefined).session), false); // no mirror: never block typing
});

test('typePrompt refuses to type over a draft, and types into an empty composer', async () => {
  const busy = fake(screen('claude-draft'));
  assert.equal(await typePrompt(busy.manager, busy.session, 'hello'), false);
  assert.deepEqual(busy.writes, []);

  const free = fake(screen('claude-empty'));
  assert.equal(await typePrompt(free.manager, free.session, 'hello'), true);
  assert.deepEqual(free.writes, ['\x1b[200~', 'hello', '\x1b[201~', '\r']); // one bracketed paste, then Enter
});
