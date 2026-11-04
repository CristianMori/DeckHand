import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import {
  ARCHITECTURE_FILE,
  CREATE_DOCS_PROMPT,
  DOCS_RETRY_WINDOW_MS,
  REFEED_CAP,
  SUMMARY_CAP,
  composeDocsRefeed,
  docsBehindCount,
  docsFingerprint,
  docsMergeDecision,
  docsMissing,
  inFlightLine,
  readDocsRefeed,
  readLeadSummary,
  splitSummary,
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
    // untracked and ignored, as the convention asks: the docs never enter a commit
    mkdirSync(join(dir, 'docs', 'architect', 'notes'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'architect', 'architecture.md'), '# arch\n');
    writeFileSync(join(dir, 'docs', 'architect', 'notes', '2026-11-01.md'), 'note\n');
    writeFileSync(join(dir, '.gitignore'), 'docs/architect/\n');
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
  assert.match(ARCHITECT_RULES, /NOT tracked in git/);
  assert.match(ARCHITECT_RULES, /\.gitignore/);
  assert.match(ARCHITECT_RULES, /never committed/);
  assert.match(ARCHITECT_RULES, /at the same time as any decision or merge/);
  assert.match(ARCHITECT_RULES, /quoted verbatim/);
  assert.match(ARCHITECT_RULES, /create it at once/);
  assert.match(ARCHITECT_RULES, /machines and people as roles/);
  assert.match(ARCHITECT_RULES, /Obsidian/);
  assert.match(ARCHITECT_RULES, /## Summary/);
  assert.match(ARCHITECT_RULES, /3,000 characters/);
  assert.match(ARCHITECT_RULES, /summary first and always in full/);
  assert.match(ARCHITECT_RULES, /"Docs:" section/);
  assert.match(ARCHITECT_RULES, /docs\/architect-convention\.md/);

  const id = { hubId: 'h', conversationId: 'c', machine: 'm', engine: 'claude', cwd: 'D:/p/x', hubUrl: 'u' };
  const w: WorkerLink = { architect: 'a', architectName: 'lead', task: 't', baseFolder: 'D:/p/x', status: 'working', startedAt: 0 };
  const worker = fleetBriefing({ ...id, role: 'worker', worker: w });
  assert.match(worker, /never create or edit docs\/architect in your worktree/);
  assert.match(worker, /"Docs:" section/);
  assert.match(worker, /"Docs: no change, because …"/);
  const sub = fleetBriefing({ ...id, role: 'subarchitect', worker: { ...w, worktree: '/w', branch: 'worker/x' } });
  assert.match(sub, /never create or edit docs\/architect in your worktree/);
  assert.match(sub, /"Docs:" section/);
  assert.match(CREATE_DOCS_PROMPT, /architecture\.md/);
  assert.match(CREATE_DOCS_PROMPT, /README\.md/);
  assert.match(CREATE_DOCS_PROMPT, /\.gitignore/);
  assert.match(CREATE_DOCS_PROMPT, /never committed/);
  assert.match(CREATE_DOCS_PROMPT, /docs\/architect-convention\.md/);
});

// ---- the working folder's facts (the docs are untracked: git never sees them)

test('the docs fingerprint follows architecture.md and the notes\' names and sizes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-fp-'));
  try {
    assert.equal(docsFingerprint(dir), undefined); // nothing to fingerprint
    const docs = join(dir, 'docs', 'architect');
    mkdirSync(join(docs, 'notes'), { recursive: true });
    writeFileSync(join(docs, 'architecture.md'), '# arch\n');
    const bare = docsFingerprint(dir);
    assert.ok(bare);
    assert.equal(docsFingerprint(dir), bare); // stable while nothing moves
    writeFileSync(join(docs, 'notes', '2026-11-04.md'), 'today\n');
    const withNote = docsFingerprint(dir);
    assert.notEqual(withNote, bare); // a new note counts
    writeFileSync(join(docs, 'notes', '2026-11-04.md'), 'today, and more\n');
    assert.notEqual(docsFingerprint(dir), withNote); // a grown note counts (by size)
    writeFileSync(join(docs, 'architecture.md'), '# arch v2\n');
    assert.notEqual(docsFingerprint(dir), withNote); // the architecture's text counts
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lead\'s ## Summary is read from the working architecture.md, capped for a briefing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-sum-'));
  try {
    assert.equal(readLeadSummary(dir), undefined);
    const docs = join(dir, 'docs', 'architect');
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'architecture.md'), '# t\n\nno summary section');
    assert.equal(readLeadSummary(dir), undefined);
    writeFileSync(join(docs, 'architecture.md'), '# t\n\n## Summary\n\nthe essentials\n\n## Parts\n\ndetail');
    assert.equal(readLeadSummary(dir), '## Summary\n\nthe essentials');
    writeFileSync(join(docs, 'architecture.md'), `# t\n\n## Summary\n\n${'S'.repeat(2 * SUMMARY_CAP)}\n\n## Parts\n`);
    const capped = readLeadSummary(dir)!;
    assert.ok(capped.length < SUMMARY_CAP + 200, `${capped.length}`);
    assert.match(capped, /cut by Deckhand/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('how far a branch is behind: commits made after the untracked docs\' newest mtime', async () => {
  const { dir, git } = repo();
  const touchDocs = (when: Date) => {
    for (const f of [join(dir, 'docs', 'architect', 'architecture.md'), join(dir, 'docs', 'architect', 'notes', '2026-11-01.md')]) {
      utimesSync(f, when, when);
    }
  };
  try {
    // the docs were just written: nothing happened after them
    touchDocs(new Date(Date.now() + 60 * 60_000));
    assert.equal(await docsBehindCount(dir), 0);
    // the docs last moved an hour ago: every commit since counts
    touchDocs(new Date(Date.now() - 60 * 60_000));
    assert.equal(await docsBehindCount(dir), 1);
    for (const n of ['b', 'c']) {
      writeFileSync(join(dir, `${n}.txt`), n);
      git('add', '.');
      git('commit', '-qm', n);
    }
    assert.equal(await docsBehindCount(dir), 3);
    // any file in the folder counts as the docs moving, a note included
    writeFileSync(join(dir, 'docs', 'architect', 'notes', '2026-11-04.md'), 'today\n');
    utimesSync(join(dir, 'docs', 'architect', 'notes', '2026-11-04.md'), new Date(Date.now() + 60 * 60_000), new Date(Date.now() + 60 * 60_000));
    assert.equal(await docsBehindCount(dir), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repository with no docs/architect at all is behind by its whole branch', async () => {
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

test('architecture.md splits at its ## Summary section, when it has one', () => {
  assert.deepEqual(splitSummary('# t\n\nbody'), { rest: '# t\n\nbody' });
  const doc = '# title\n\n## Summary\n\nthe essentials\nmore of them\n\n## Parts\n\ndetail';
  const { summary, rest } = splitSummary(doc);
  assert.equal(summary, '## Summary\n\nthe essentials\nmore of them');
  assert.equal(rest, '# title\n\n## Parts\n\ndetail');
  // a summary that ends the file
  assert.equal(splitSummary('# t\n\n## summary\nlast').summary, '## summary\nlast');
});

test('the refeed sends the ## Summary first and in full, then clips the rest', () => {
  const summary = `## Summary\n\n${'S'.repeat(2_500)}`;
  const doc = `# title\n\n${summary}\n\n## Parts\n\n${'A'.repeat(50_000)}`;
  const out = composeDocsRefeed(doc, [{ name: 'n1.md', text: 'B'.repeat(50_000) }]);
  assert.ok((out?.length ?? 0) <= 10_000, `${out?.length} > 10000`);
  assert.match(out ?? '', /--- docs\/architect\/architecture\.md: ## Summary \(in full\) ---\n## Summary/);
  assert.ok(out!.includes('S'.repeat(2_500))); // the whole summary, never cut
  const summaryAt = out!.indexOf('## Summary');
  const restAt = out!.indexOf('--- docs/architect/architecture.md: the rest ---');
  const noteAt = out!.indexOf('--- docs/architect/notes/n1.md ---');
  assert.ok(summaryAt > 0 && summaryAt < restAt && restAt < noteAt); // summary, rest, notes — in that order
  assert.match(out ?? '', /cut by Deckhand: \d+ more characters — read docs\/architect\/architecture\.md/);
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
