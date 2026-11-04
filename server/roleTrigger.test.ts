import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listCharters, matchesPaths, resolveCharter, type RoleCharter } from './roleCharters.js';
import {
  fanOutPlatforms, onMerge, reportAcked, ROLE_COOLDOWN_MS, RoleLedger, roleRunDecision, skipReason,
  type PlatformSeat, type RoleTriggerDeps,
} from './roleTrigger.js';
import type { RoleStart } from './swarm.js';

const NOW = 1_000_000_000;
const charter = (over: Partial<RoleCharter> = {}): RoleCharter => ({
  name: 'tester',
  title: 'Tester',
  on: 'merge',
  paths: [],
  platforms: 'any',
  skip: {},
  enabled: true,
  body: 'Check it.',
  layers: ['builtin'],
  ...over,
});
const diff = (files: string[], insertions = 100, deletions = 0) => ({ files, insertions, deletions });

// ---- the skip rules

test('underLines skips small diffs, docsOnly skips documentation-only ones', () => {
  assert.match(skipReason({ underLines: 10 }, diff(['a.ts'], 4, 5)) ?? '', /under 10 lines/);
  assert.equal(skipReason({ underLines: 10 }, diff(['a.ts'], 6, 4)), undefined); // 10 is not under 10
  assert.match(skipReason({ docsOnly: true }, diff(['docs/x.html', 'README.md'])) ?? '', /only documentation/);
  assert.equal(skipReason({ docsOnly: true }, diff(['docs/x.md', 'server/a.ts'])), undefined);
  assert.equal(skipReason({}, diff([], 0, 0)), undefined); // no rules, nothing skips
});

// ---- the run decision, pure

test('a head that already ran is skipped; a disabled charter always is', () => {
  const t = { head: 'h1', ...diff(['a.ts']) };
  assert.deepEqual(roleRunDecision(charter(), t, { live: false }, NOW), { do: 'run' });
  assert.deepEqual(roleRunDecision(charter(), t, { last: { head: 'h1', at: 0 }, live: false }, NOW), { do: 'skip', reason: 'already ran on this head' });
  assert.equal(roleRunDecision(charter({ enabled: false }), t, { live: false }, NOW).do, 'skip');
});

test('a manual run bypasses the skip rules and the ledger, but not a disabled charter', () => {
  const tiny = { head: 'h1', manual: true, ...diff(['a.md'], 1, 0) };
  assert.deepEqual(roleRunDecision(charter({ skip: { underLines: 10, docsOnly: true } }), tiny, { last: { head: 'h1', at: NOW - 1 }, live: true }, NOW), { do: 'run' });
  assert.equal(roleRunDecision(charter({ enabled: false }), tiny, { live: false }, NOW).do, 'skip');
});

test('a live instance turns a new head into a pending one', () => {
  const t = { head: 'h2', ...diff(['a.ts']) };
  assert.deepEqual(roleRunDecision(charter(), t, { last: { head: 'h1', at: 0 }, live: true }, NOW), { do: 'pending' });
});

test('within the cooldown only an incremental diff that itself earns a run runs', () => {
  const c = charter({ skip: { underLines: 10 } });
  const t = { head: 'h2', ...diff(['a.ts'], 100, 0) };
  const recent = { last: { head: 'h1', at: NOW - ROLE_COOLDOWN_MS + 1000 }, live: false };
  // first the caller is asked for the diff since the last run's head
  assert.deepEqual(roleRunDecision(c, t, recent, NOW), { do: 'need-incremental', since: 'h1' });
  // a docs-sized increment (the refuse-once docs commit) is skipped
  assert.equal(roleRunDecision(c, t, recent, NOW, diff(['docs/a.md'], 3, 0)).do, 'skip');
  // a real increment runs
  assert.equal(roleRunDecision(c, t, recent, NOW, diff(['b.ts'], 40, 2)).do, 'run');
  // past the cooldown no incremental diff is needed
  assert.deepEqual(roleRunDecision(c, t, { last: { head: 'h1', at: NOW - ROLE_COOLDOWN_MS - 1 }, live: false }, NOW), { do: 'run' });
});

// ---- the ledger

test('the ledger remembers runs, holds one pending head, and survives a reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'role-ledger-'));
  const file = join(dir, 'role-runs.json');
  try {
    const ledger = new RoleLedger(file);
    ledger.ran('p|tester|win32', 'h1', NOW);
    assert.deepEqual(ledger.get('p|tester|win32'), { head: 'h1', at: NOW });
    assert.equal(ledger.takePending('p|tester|win32'), undefined);
    // two merges while an instance runs: only the newest head waits
    ledger.pend('p|tester|win32', 'h2');
    ledger.pend('p|tester|win32', 'h3');
    assert.deepEqual(ledger.takePending('p|tester|win32'), { head: 'h3', base: 'h1' });
    assert.equal(ledger.takePending('p|tester|win32'), undefined); // taking clears it
    // a pending head with no prior run has no base
    ledger.pend('p|doc-keeper|win32', 'h2');
    assert.deepEqual(ledger.takePending('p|doc-keeper|win32'), { head: 'h2', base: undefined });
    // written through: a new ledger on the same file knows it all
    ledger.pend('p|tester|win32', 'h4');
    const again = new RoleLedger(file);
    assert.equal(again.get('p|tester|win32')?.head, 'h1');
    assert.deepEqual(again.takePending('p|tester|win32'), { head: 'h4', base: 'h1' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the ledger is capped, oldest slots falling off first', () => {
  const ledger = new RoleLedger();
  for (let i = 0; i < 205; i++) ledger.ran(`p|r|${i}`, 'h', NOW + i);
  assert.equal(ledger.get('p|r|0'), undefined);
  assert.equal(ledger.get('p|r|4'), undefined);
  assert.ok(ledger.get('p|r|5'));
  assert.ok(ledger.get('p|r|204'));
});

// ---- platform fan-out

test('platforms any, all, or a list claim the seats that are actually reachable', () => {
  const seats: PlatformSeat[] = [
    { platform: 'win32', self: true },
    { platform: 'linux', machine: 'vps' },
    { platform: 'linux', machine: 'vps2' },
    { platform: 'darwin', machine: 'mac' },
  ];
  assert.deepEqual(fanOutPlatforms('any', seats), [{ platform: 'win32' }]);
  // 'all': one per distinct OS; its own platform runs locally, labels name the OS
  assert.deepEqual(fanOutPlatforms('all', seats), [
    { platform: 'win32', machine: undefined, label: 'win32' },
    { platform: 'linux', machine: 'vps', label: 'linux' },
    { platform: 'darwin', machine: 'mac', label: 'darwin' },
  ]);
  // an explicit list runs only what is reachable
  assert.deepEqual(fanOutPlatforms(['linux', 'aix'], seats), [{ platform: 'linux', machine: 'vps', label: 'linux' }]);
  assert.deepEqual(fanOutPlatforms('any', [{ platform: 'linux', machine: 'vps' }]), []); // no self seat, nothing local
});

// ---- charters (the minimal resolution this branch ships; the full layer set is built in parallel)

test('the built-in tester and doc-keeper charters resolve with their shipped fields', () => {
  const tester = resolveCharter('tester')!;
  assert.equal(tester.title, 'Tester');
  assert.equal(tester.platforms, 'all');
  assert.deepEqual(tester.skip, { underLines: 10, docsOnly: true });
  assert.equal(tester.enabled, true);
  assert.deepEqual(tester.paths, []);
  assert.ok(tester.body.length > 20);
  assert.deepEqual(tester.layers, ['builtin']);
  const keeper = resolveCharter('doc-keeper')!;
  assert.equal(keeper.platforms, 'any');
  assert.deepEqual(keeper.skip, { underLines: 5 });
  assert.equal(resolveCharter('no-such-role'), undefined);
  assert.ok(listCharters().map((c) => c.name).includes('tester'));
  assert.ok(listCharters().map((c) => c.name).includes('doc-keeper'));
});

test('a project layer wins per field, and its body wholesale', () => {
  const text = '---\nenabled: false\nmodel: haiku\n---\nProject-specific checks.';
  const c = resolveCharter('tester', text)!;
  assert.equal(c.enabled, false);
  assert.equal(c.model, 'haiku');
  assert.deepEqual(c.skip, { underLines: 10, docsOnly: true }); // untouched fields keep the built-in layer
  assert.equal(c.body, 'Project-specific checks.');
  assert.deepEqual(c.layers, ['builtin', 'project']);
  // front matter only: the built-in body stays
  const fieldsOnly = resolveCharter('tester', '---\nplatforms: any\n---\n')!;
  assert.equal(fieldsOnly.platforms, 'any');
  assert.match(fieldsOnly.body, /test suite/);
});

test('paths gate a charter to its files', () => {
  const c = charter({ paths: ['server/**', '*.md'] });
  assert.equal(matchesPaths(c, ['server/swarm.ts']), true);
  assert.equal(matchesPaths(c, ['web/src/main.ts']), false);
  assert.equal(matchesPaths(c, ['README.md']), true);
  assert.equal(matchesPaths(c, ['docs/notes.md']), false); // * does not cross a slash
  assert.equal(matchesPaths(charter(), ['anything']), true); // no paths = every merge
  assert.equal(matchesPaths(c, []), false);
});

// ---- onMerge against a real repository, with the start stubbed

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'role-trig-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  return { dir, git };
}

function trigHarness(dir: string, c: RoleCharter, over: Partial<RoleTriggerDeps> = {}) {
  const started: { charter: string; trig: RoleStart }[] = [];
  let live = false;
  const deps: RoleTriggerDeps = {
    names: () => [c.name],
    resolve: (name, text) => (name === c.name ? (text ? { ...c, ...(/enabled:\s*false/.test(text) ? { enabled: false } : {}) } : c) : undefined),
    startRole: async (_lead, charter_, trig) => void started.push({ charter: charter_.name, trig }),
    seats: () => [{ platform: process.platform, self: true }],
    liveInstance: () => live,
    ledger: new RoleLedger(),
    ...over,
  };
  const lead = { cwd: dir, name: 'lead', proc: {} };
  return { deps, lead, started, setLive: (v: boolean) => void (live = v) };
}

test('a merge runs the matching charters once, with the diff computed at the trigger', async () => {
  const { dir, git } = repo();
  try {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'b.ts'), 'const b = 2;\n'.repeat(30));
    writeFileSync(join(dir, 'c.md'), 'notes\n');
    git('add', '.');
    git('commit', '-qm', 'merge');
    const head = git('rev-parse', 'HEAD');
    const { deps, lead, started } = trigHarness(dir, charter({ skip: { underLines: 5 } }));
    const out = await onMerge(lead, { project: 'p', folder: dir, base, head }, deps);
    assert.deepEqual(out.started, ['tester']);
    assert.deepEqual(started[0].trig.files.sort(), ['b.ts', 'c.md']);
    assert.equal(started[0].trig.insertions, 31);
    assert.equal(started[0].trig.base, base);
    // the same head a second time is one run: the docs-refusal retry hits the funnel twice
    const again = await onMerge(lead, { project: 'p', folder: dir, base, head }, deps);
    assert.deepEqual(again.started, []);
    assert.match(again.skipped[0].reason, /already ran/);
    // a dead lead has nobody to report to
    const gone = await onMerge({ ...lead, proc: null }, { project: 'p', folder: dir, base, head }, deps);
    assert.deepEqual(gone.started, []);
    assert.match(gone.skipped[0].reason, /not running/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the project layer is read from the merged commit itself', async () => {
  const { dir, git } = repo();
  try {
    const base = git('rev-parse', 'HEAD');
    mkdirSync(join(dir, 'docs', 'architect', 'roles'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'architect', 'roles', 'tester.md'), '---\nenabled: false\n---\n');
    writeFileSync(join(dir, 'd.ts'), 'const d = 4;\n'.repeat(20));
    git('add', '.');
    git('commit', '-qm', 'switch the tester off');
    const head = git('rev-parse', 'HEAD');
    const { deps, lead, started } = trigHarness(dir, charter());
    const out = await onMerge(lead, { project: 'p', folder: dir, base, head }, deps);
    assert.deepEqual(started, []);
    assert.deepEqual(out.skipped, [{ role: 'tester', reason: 'disabled' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a merge during a run waits as the pending head and fires once the report is acked', async () => {
  const { dir, git } = repo();
  try {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'b.ts'), 'const b = 2;\n'.repeat(30));
    git('add', '.');
    git('commit', '-qm', 'first merge');
    const h1 = git('rev-parse', 'HEAD');
    const { deps, lead, started, setLive } = trigHarness(dir, charter());
    await onMerge(lead, { project: 'p', folder: dir, base, head: h1 }, deps);
    assert.equal(started.length, 1);
    // the tester is still running when the next merge lands: recorded, not run
    setLive(true);
    writeFileSync(join(dir, 'c.ts'), 'const c = 3;\n'.repeat(30));
    git('add', '.');
    git('commit', '-qm', 'second merge');
    const h2 = git('rev-parse', 'HEAD');
    const out = await onMerge(lead, { project: 'p', folder: dir, base: h1, head: h2 }, deps);
    assert.deepEqual(out.started, []);
    assert.match(out.skipped[0].reason, /still running/);
    assert.equal(started.length, 1);
    // the report is acked: the pending head fires once, diffed from the last run's head
    setLive(false);
    await reportAcked(lead, { charter: 'tester', project: 'p', platform: process.platform }, deps);
    assert.equal(started.length, 2);
    assert.equal(started[1].trig.head, h2);
    assert.equal(started[1].trig.base, h1);
    // nothing pending any more: acking again fires nothing
    await reportAcked(lead, { charter: 'tester', project: 'p', platform: process.platform }, deps);
    assert.equal(started.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a manual run has no diff, bypasses the economies, and can name one role', async () => {
  const { dir, git } = repo();
  try {
    const head = git('rev-parse', 'HEAD');
    const { deps, lead, started } = trigHarness(dir, charter({ skip: { underLines: 1000 } }));
    const out = await onMerge(lead, { project: 'p', folder: dir, head, manual: true, role: 'tester' }, deps);
    assert.deepEqual(out.started, ['tester']);
    assert.equal(started[0].trig.manual, true);
    assert.deepEqual(started[0].trig.files, []);
    // naming an unknown role answers why nothing ran
    const unknown = await onMerge(lead, { project: 'p', folder: dir, head, manual: true, role: 'hacker' }, deps);
    assert.deepEqual(unknown.skipped, [{ role: 'hacker', reason: 'no such role' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('platform fan-out starts one instance per seat, each labelled and ledgered apart', async () => {
  const { dir, git } = repo();
  try {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'b.ts'), 'const b = 2;\n'.repeat(30));
    git('add', '.');
    git('commit', '-qm', 'merge');
    const head = git('rev-parse', 'HEAD');
    const other = process.platform === 'linux' ? 'darwin' : 'linux';
    const { deps, lead, started } = trigHarness(dir, charter({ platforms: 'all' }), {
      seats: () => [{ platform: process.platform, self: true }, { platform: other, machine: 'peer' }],
    });
    const out = await onMerge(lead, { project: 'p', folder: dir, base, head }, deps);
    assert.deepEqual(out.started.sort(), [`tester (${process.platform})`, `tester (${other})`].sort());
    const far = started.find((s) => s.trig.machine === 'peer')!;
    assert.equal(far.trig.platformLabel, other);
    const near = started.find((s) => !s.trig.machine)!;
    assert.equal(near.trig.platformLabel, process.platform);
    assert.ok(existsSync(dir)); // the trigger only reads the repo
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
