import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import {
  ARCHITECTURE_FILE,
  CREATE_DOCS_PROMPT,
  DOCS_RETRY_WINDOW_MS,
  REFEED_CAP,
  architectureInCommit,
  composeDocsRefeed,
  docsBehindCount,
  docsChangedSince,
  docsMergeDecision,
  docsMissing,
  inFlightLine,
  readDocsRefeed,
} from './architectDocs.js';
import { ARCHITECT_RULES, fleetBriefing } from './etiquette.js';
import { makeHookHandler } from './hooksReceiver.js';
import type { HubSession, SessionManager } from './sessionManager.js';
import type { StatusEngine } from './statusEngine.js';
import type { WorkerLink } from './types.js';

function repo(withDocs = true) {
  const dir = mkdtempSync(join(tmpdir(), 'docs-test-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  if (withDocs) {
    mkdirSync(join(dir, 'docs', 'architect', 'notes'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'architect', 'architecture.md'), '# arch\n');
    writeFileSync(join(dir, 'docs', 'architect', 'notes', '2026-11-01.md'), 'note\n');
  }
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  return { dir, git };
}

// ---- the rules text

test('the briefings carry the documentation convention', () => {
  assert.match(ARCHITECT_RULES, /docs\/architect\//);
  assert.match(ARCHITECT_RULES, /architecture\.md/);
  assert.match(ARCHITECT_RULES, /notes\/YYYY-MM-DD\.md/);
  assert.match(ARCHITECT_RULES, /In flight/);
  assert.match(ARCHITECT_RULES, /⎇ <branch> \(not merged\)/);
  assert.match(ARCHITECT_RULES, /same commit/);
  assert.match(ARCHITECT_RULES, /quoted verbatim/);
  assert.match(ARCHITECT_RULES, /create it at once/);
  assert.match(ARCHITECT_RULES, /machines and people as roles/);
  assert.match(ARCHITECT_RULES, /Obsidian/);

  const id = { hubId: 'h', conversationId: 'c', machine: 'm', engine: 'claude', cwd: 'D:/p/x', hubUrl: 'u' };
  const w: WorkerLink = { architect: 'a', architectName: 'lead', task: 't', baseFolder: 'D:/p/x', status: 'working', startedAt: 0 };
  const worker = fleetBriefing({ ...id, role: 'worker', worker: w });
  assert.match(worker, /docs\/architect\/architecture\.md/);
  assert.match(worker, /"Docs: updated" or "Docs: no change, because …"/);
  const sub = fleetBriefing({ ...id, role: 'subarchitect', worker: { ...w, worktree: '/w', branch: 'worker/x' } });
  assert.match(sub, /docs\/architect\/architecture\.md/);
  assert.match(sub, /docs\/architect\/notes\//);
  assert.match(CREATE_DOCS_PROMPT, /architecture\.md/);
  assert.match(CREATE_DOCS_PROMPT, /README\.md/);
});

// ---- git facts

test('architecture.md is found in the commit it is in, at the lead\'s own subfolder', async () => {
  const { dir, git } = repo(false);
  try {
    const first = git('rev-parse', 'HEAD').trim();
    assert.equal(await architectureInCommit(dir, first), false);
    mkdirSync(join(dir, 'docs', 'architect'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'architect', 'architecture.md'), '# arch\n');
    mkdirSync(join(dir, 'pkg', 'docs', 'architect'), { recursive: true });
    writeFileSync(join(dir, 'pkg', 'docs', 'architect', 'architecture.md'), '# pkg arch\n');
    git('add', '.');
    git('commit', '-qm', 'docs');
    const second = git('rev-parse', 'HEAD').trim();
    assert.equal(await architectureInCommit(dir, first), false); // only the commit asked about counts
    assert.equal(await architectureInCommit(dir, second), true);
    assert.equal(await architectureInCommit(dir, second, 'pkg'), true);
    assert.equal(await architectureInCommit(dir, second, 'elsewhere'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('whether docs changed between a base and HEAD, and how far a branch is behind them', async () => {
  const { dir, git } = repo();
  try {
    const base = git('rev-parse', 'HEAD').trim();
    assert.equal(await docsBehindCount(dir), 0);
    assert.equal(await docsChangedSince(dir, base), false);
    for (const n of ['b', 'c']) {
      writeFileSync(join(dir, `${n}.txt`), n);
      git('add', '.');
      git('commit', '-qm', n);
    }
    assert.equal(await docsChangedSince(dir, base), false);
    assert.equal(await docsBehindCount(dir), 2);
    writeFileSync(join(dir, 'docs', 'architect', 'notes', '2026-11-04.md'), 'today\n');
    git('add', '.');
    git('commit', '-qm', 'note');
    assert.equal(await docsChangedSince(dir, base), true);
    assert.equal(await docsBehindCount(dir), 0);
    // a change outside architecture.md and notes/ does not count as documentation
    writeFileSync(join(dir, 'docs', 'architect', 'README.md'), 'readme\n');
    git('add', '.');
    git('commit', '-qm', 'readme');
    const beforeReadme = git('rev-parse', 'HEAD~1').trim();
    assert.equal(await docsChangedSince(dir, beforeReadme), false);
    assert.equal(await docsBehindCount(dir), 0); // but it does reset the behind count: the folder moved
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repository that never touched docs/architect is behind by its whole branch', async () => {
  const { dir } = repo(false);
  const plain = mkdtempSync(join(tmpdir(), 'docs-plain-'));
  try {
    assert.equal(await docsBehindCount(dir), 1);
    assert.equal(await docsBehindCount(plain), undefined); // not a repository: nothing to count
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test('docsMissing looks for the file, not the folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-miss-'));
  try {
    assert.equal(docsMissing(dir), true);
    mkdirSync(join(dir, 'docs', 'architect'), { recursive: true });
    assert.equal(docsMissing(dir), true);
    writeFileSync(join(dir, 'docs', 'architect', 'architecture.md'), '# arch\n');
    assert.equal(docsMissing(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the refuse-once decision

test('a merged worker with unchanged docs is refused once, then goes through', () => {
  const reminded = new Map<string, number>();
  const NOW = 1_000_000;
  const refusal = docsMergeDecision(reminded, 'w1', { merged: true, docsChanged: false, report: 'done' }, NOW);
  assert.match(refusal ?? '', /refused this removal once/);
  assert.match(refusal ?? '', /architecture\.md/);
  // the deliberate second call inside the window goes through
  assert.equal(docsMergeDecision(reminded, 'w1', { merged: true, docsChanged: false, report: 'done' }, NOW + 60_000), null);
  // another worker gets its own refusal
  assert.match(docsMergeDecision(reminded, 'w2', { merged: true, docsChanged: false }, NOW + 60_000) ?? '', /refused/);
  // past the window the reminder is forgotten and it is refused again
  const late = NOW + DOCS_RETRY_WINDOW_MS + 61_000;
  assert.match(docsMergeDecision(reminded, 'w1', { merged: true, docsChanged: false }, late) ?? '', /refused/);
});

test('docs changed, a "Docs: no change" report, an unmerged branch or an unknowable check all pass', () => {
  const reminded = new Map<string, number>();
  assert.equal(docsMergeDecision(reminded, 'w', { merged: true, docsChanged: true }), null);
  assert.equal(docsMergeDecision(reminded, 'w', { merged: true, docsChanged: false, report: 'All built.\nDocs: no change, because nothing user-visible moved' }), null);
  assert.equal(docsMergeDecision(reminded, 'w', { merged: true, docsChanged: false, report: 'docs: NO CHANGE, trivial' }), null);
  assert.equal(docsMergeDecision(reminded, 'w', { merged: false, docsChanged: false }), null);
  assert.equal(docsMergeDecision(reminded, 'w', { merged: true, docsChanged: undefined }), null); // an older hub answered without it
  assert.equal(reminded.size, 0); // none of those count as a reminder
});

// ---- the start reply's "In flight" line

test('the in-flight line names the worker, its branch and the task\'s first line', () => {
  assert.equal(inFlightLine('adder', 'worker/adder-ab12cd', 'add b\nand details'), '- ⚙ adder — ⎇ worker/adder-ab12cd: add b');
  assert.equal(inFlightLine('x', undefined, '\n  first real line  \nmore'), '- ⚙ x: first real line');
  assert.ok(inFlightLine('x', 'b', 'y'.repeat(500)).length < 160);
});

// ---- the post-compaction refeed

test('the refeed carries architecture.md and the newest notes, under Claude\'s additionalContext cap', () => {
  assert.equal(composeDocsRefeed(undefined, []), undefined);
  const small = composeDocsRefeed('# arch\nbody', [{ name: '2026-11-04.md', text: 'today' }]);
  assert.match(small ?? '', /--- docs\/architect\/architecture\.md ---\n# arch\nbody/);
  assert.match(small ?? '', /--- docs\/architect\/notes\/2026-11-04\.md ---\ntoday/);
  assert.match(small ?? '', /compacted or resumed/);

  const big = composeDocsRefeed('A'.repeat(50_000), [
    { name: 'n1.md', text: 'B'.repeat(50_000) },
    { name: 'n2.md', text: 'C'.repeat(50_000) },
  ]);
  assert.ok((big?.length ?? 0) <= 10_000, `${big?.length} > 10000`);
  assert.match(big ?? '', /cut by Deckhand: \d+ more characters — read docs\/architect\/architecture\.md/);
  assert.match(big ?? '', /read docs\/architect\/notes\/n1\.md/);
  assert.ok(REFEED_CAP < 10_000);
});

test('the refeed is read from the folder, newest two notes only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-refeed-'));
  try {
    assert.equal(readDocsRefeed(dir), undefined);
    const docs = join(dir, 'docs', 'architect');
    mkdirSync(join(docs, 'notes'), { recursive: true });
    writeFileSync(join(docs, 'architecture.md'), '# the architecture\n');
    for (const d of ['2026-11-01', '2026-11-02', '2026-11-03']) writeFileSync(join(docs, 'notes', `${d}.md`), `note ${d}\n`);
    writeFileSync(join(docs, 'notes', 'scratch.txt'), 'not a note');
    const out = readDocsRefeed(dir);
    assert.match(out ?? '', /# the architecture/);
    assert.match(out ?? '', /note 2026-11-02/);
    assert.match(out ?? '', /note 2026-11-03/);
    assert.doesNotMatch(out ?? '', /note 2026-11-01/);
    assert.doesNotMatch(out ?? '', /not a note/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the SessionStart hook answer

function hookCall(session: Partial<HubSession>, event: string, body: Record<string, unknown>) {
  const manager = {
    sessions: new Map(),
    byClaudeSessionId: (id: string) => (id === session.claudeSessionId ? (session as HubSession) : undefined),
  } as unknown as SessionManager;
  const engine = { signal() {} } as unknown as StatusEngine;
  const handler = makeHookHandler(manager, engine, () => []);
  const res = {
    code: 0,
    payload: undefined as unknown,
    status(n: number) {
      this.code = n;
      return this;
    },
    end() {},
    json(p: unknown) {
      this.payload = p;
      return this;
    },
  };
  handler({ query: { event }, body: { session_id: session.claudeSessionId, ...body } } as unknown as Request, res as unknown as Response);
  return res;
}

test('an architect compacted or resumed is handed its documentation as additionalContext', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-hook-'));
  try {
    const docs = join(dir, 'docs', 'architect');
    mkdirSync(join(docs, 'notes'), { recursive: true });
    writeFileSync(join(docs, 'architecture.md'), '# the architecture\n');
    writeFileSync(join(docs, 'notes', '2026-11-04.md'), 'today\n');
    const session = { claudeSessionId: 'arch-conv', name: 'lead', cwd: dir, role: 'architect', agentType: 'claude' } as Partial<HubSession>;

    for (const source of ['compact', 'resume']) {
      const res = hookCall(session, 'SessionStart', { source, cwd: dir });
      const out = res.payload as { hookSpecificOutput?: { hookEventName: string; additionalContext: string } };
      assert.equal(out?.hookSpecificOutput?.hookEventName, 'SessionStart', source);
      assert.match(out?.hookSpecificOutput?.additionalContext ?? '', /# the architecture/);
      assert.match(out?.hookSpecificOutput?.additionalContext ?? '', /today/);
    }
    // a fresh startup, a plain session, and a folder without documents all stay silent
    assert.equal(hookCall(session, 'SessionStart', { source: 'startup', cwd: dir }).payload, undefined);
    assert.equal(hookCall({ ...session, role: undefined }, 'SessionStart', { source: 'compact', cwd: dir }).payload, undefined);
    assert.equal(hookCall({ ...session, cwd: tmpdir() }, 'SessionStart', { source: 'compact' }).payload, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the hooks template registers SessionStart for compaction and resume', async () => {
  const { readFileSync } = await import('node:fs');
  const template = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'hooks', 'hub-hooks.template.json'), 'utf8'));
  const [group] = template.hooks.SessionStart;
  assert.equal(group.matcher, 'compact|resume');
  assert.match(group.hooks[0].command, /event=SessionStart/);
  assert.ok(ARCHITECTURE_FILE.endsWith('architecture.md'));
});
