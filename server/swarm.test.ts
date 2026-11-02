import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { architectEditWarning, fleetBriefing, isDocPath } from './etiquette.js';
import type { HubSession, SessionManager } from './sessionManager.js';
import { bundleBranch, bundleCommit, createWorktree, mirrorHeads, projectMirror, receiveBranch, receiveCommit, REPORT_MAX, Swarm, workerStep, worktreeFacts } from './swarm.js';
import type { WorkerLink } from './types.js';

const link = (over: Partial<WorkerLink> = {}): WorkerLink => ({
  architect: 'arch-conv',
  architectName: 'lead',
  task: 'do the thing',
  baseFolder: 'D:/p/lead',
  status: 'working',
  startedAt: 0,
  ...over,
});
const NOW = 1_000_000;
const live = (state: string, ago: number, over = {}) => ({ alive: true, state, stateSince: NOW - ago, ...over });

test('a worker that is busy needs nothing', () => {
  assert.equal(workerStep(link(), live('WORKING', 500_000), NOW), null);
});

test('a worker that went idle is reminded once, after a grace', () => {
  assert.equal(workerStep(link(), live('IDLE', 10_000), NOW), null);
  assert.deepEqual(workerStep(link(), live('IDLE', 60_000), NOW), { do: 'nudge' });
});

test('idle again after the reminder is reported as stalled', () => {
  // the reminder is typed while still idle: the state has not moved since, so wait
  assert.equal(workerStep(link({ nudgedAt: NOW - 50_000 }), live('IDLE', 60_000), NOW), null);
  // it took the reminder, worked, and stopped again
  assert.deepEqual(workerStep(link({ nudgedAt: NOW - 120_000 }), live('IDLE', 60_000), NOW), { do: 'stalled' });
});

test('a worker that died says so; a hub restart is not a death', () => {
  assert.deepEqual(workerStep(link(), { alive: false, state: 'EXITED', stateSince: NOW, detail: 'exit code 1' }, NOW), { do: 'stopped' });
  assert.equal(workerStep(link(), { alive: false, state: 'EXITED', stateSince: NOW, detail: 'hub restarted' }, NOW), null);
});

test('a finished worker is left alone, stopped or not', () => {
  for (const status of ['reported', 'failed'] as const) {
    assert.equal(workerStep(link({ status }), { alive: false, state: 'EXITED', stateSince: NOW, detail: 'exit code 0' }, NOW), null);
    assert.equal(workerStep(link({ status }), live('IDLE', 600_000), NOW), null);
  }
});

test('a worker at a prompt is passed to the architect once per prompt', () => {
  const s = live('WAITING_QUESTION', 1000);
  assert.deepEqual(workerStep(link(), s, NOW), { do: 'waiting' });
  assert.equal(workerStep(link({ forwardedWait: s.stateSince }), s, NOW), null);
});

test('auto-yes gets time to answer a permission prompt before anyone is told', () => {
  assert.equal(workerStep(link(), live('WAITING_PERMISSION', 1000, { autoYes: true }), NOW), null);
  assert.deepEqual(workerStep(link(), live('WAITING_PERMISSION', 60_000, { autoYes: true }), NOW), { do: 'waiting' });
});

test('an asking worker waits for its answer without being reminded', () => {
  assert.equal(workerStep(link({ status: 'asking', askedAt: NOW - 500_000 }), live('IDLE', 400_000), NOW), null);
  // the turn that asked is still running: not an answer yet
  assert.equal(workerStep(link({ status: 'asking', askedAt: NOW - 1000 }), live('WORKING', 60_000), NOW), null);
  assert.deepEqual(workerStep(link({ status: 'asking', askedAt: NOW - 60_000 }), live('WORKING', 1000), NOW), { do: 'resume-tracking' });
});

test('documentation is the architect\'s, code gets a warning, and elsewhere is not its business', () => {
  assert.ok(isDocPath('D:/p/lead/docs/ARCHITECTURE.md'));
  assert.ok(isDocPath('D:\\p\\lead\\README.md'));
  assert.ok(isDocPath('D:/p/lead/docs/diagram.svg'));
  assert.ok(!isDocPath('D:/p/lead/server/index.ts'));
  assert.equal(architectEditWarning('D:/p/lead', ['D:/p/lead/README.md']), null);
  assert.equal(architectEditWarning('D:/p/lead', ['D:/elsewhere/scratch.ts']), null);
  assert.match(architectEditWarning('D:/p/lead', ['D:/p/lead/server/index.ts']) ?? '', /dh_start_worker/);
});

test('each role is briefed with its own rules, a plain session with neither', () => {
  const id = { hubId: 'h', conversationId: 'c', machine: 'm', engine: 'claude', cwd: 'D:/p/lead', hubUrl: 'u' };
  const plain = fleetBriefing(id);
  assert.doesNotMatch(plain, /Your role:/);
  assert.match(fleetBriefing({ ...id, role: 'architect' }), /Your role: ARCHITECT/);
  const worker = fleetBriefing({ ...id, role: 'worker', worker: link({ followUps: ['and the other thing'] }) });
  assert.match(worker, /Your role: WORKER for the architect session "lead"/);
  assert.match(worker, /do the thing/);
  assert.match(worker, /and the other thing/);
});

// ---- against a real repository, with sessions faked

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-test-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  return { dir, git };
}

function harness() {
  const manager = Object.assign(new EventEmitter(), {
    sessions: new Map<string, HubSession>(),
    create(opts: { cwd: string; name: string; role: string; worker: WorkerLink; agentType: string }) {
      const s = { hubId: `w${manager.sessions.size}`, proc: {}, state: 'WORKING', stateSince: Date.now(), lastInputAt: 0, ...opts } as unknown as HubSession;
      manager.sessions.set(s.hubId, s);
      return s;
    },
    byClaudeSessionId: (id: string) => [...manager.sessions.values()].find((s) => s.claudeSessionId === id),
    kill() {},
    remove(hubId: string) {
      const s = manager.sessions.get(hubId);
      manager.sessions.delete(hubId);
      manager.emit('removed', s);
    },
  });
  const typed: { to: string; text: string }[] = [];
  const asked: string[] = [];
  const swarm = new Swarm(manager as unknown as SessionManager, {
    typePrompt: async (s, text) => void typed.push({ to: s.hubId, text }),
    promptFrom: (_s, caller) => void asked.push(caller),
    lastReply: async () => 'it said this',
    save() {},
  });
  return { manager, swarm, typed, asked };
}

test('the worker gets its own branch and checkout, and the main folder stays put', async () => {
  const { dir, git } = repo();
  const root = mkdtempSync(join(tmpdir(), 'swarm-trees-'));
  try {
    const t = await createWorktree(dir, 'Fix: the Login!', root);
    assert.ok(t);
    assert.match(t.branch, /^worker\/fix-the-login-[0-9a-f]{6}$/);
    assert.ok(existsSync(join(t.worktree, 'a.txt')));
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
    writeFileSync(join(t.worktree, 'b.txt'), 'b\n');
    assert.equal((await worktreeFacts(t)).dirty, true);
    execFileSync('git', ['-C', t.worktree, 'add', '.']);
    execFileSync('git', ['-C', t.worktree, 'commit', '-qm', 'b']);
    assert.deepEqual(await worktreeFacts(t), { branch: t.branch, commits: 1, files: 1, dirty: false });
    assert.equal(existsSync(join(dir, 'b.txt')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a folder that is not a git repo has no worktree to give', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-plain-'));
  try {
    assert.equal(await createWorktree(dir, 'x', join(dir, 'trees')), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('from task to report to merge to removal', async () => {
  const { dir, git } = repo();
  const { manager, swarm, typed, asked } = harness();
  const architect = { hubId: 'lead', claudeSessionId: 'arch-conv', name: 'lead', cwd: dir, agentType: 'claude', role: 'architect', proc: {}, state: 'WORKING', lastInputAt: 0 } as unknown as HubSession;
  manager.sessions.set('lead', architect);
  const started = await swarm.start(architect, { task: 'add b', name: 'adder' });
  const session = started.session!;
  const { isolated } = started;
  try {
    assert.equal(isolated, true);
    assert.equal(session.autoYes, true);
    assert.equal(session.role, 'worker');
    assert.equal(swarm.workersOf(architect).length, 1);
    const w = session.worker!;
    assert.match(asked[0], /^session:/); // its turns aren't the user's to answer

    writeFileSync(join(w.worktree!, 'b.txt'), 'b\n');
    await assert.rejects(swarm.report(session, 'done', false), /uncommitted/);
    assert.equal(w.status, 'working');
    await assert.rejects(swarm.report(session, 'x'.repeat(REPORT_MAX + 1), false), /too long/);
    execFileSync('git', ['-C', w.worktree!, 'add', '.']);
    execFileSync('git', ['-C', w.worktree!, 'commit', '-qm', 'b']);
    await swarm.report(session, 'b is added, tests pass', false);
    assert.equal(w.status, 'reported');
    assert.equal(w.commits, 1);

    // the architect is busy: the report waits
    await swarm.tick();
    assert.equal(typed.length, 0);
    assert.equal(w.outbox?.length, 1);

    // the user is typing to it: still waits
    Object.assign(architect, { state: 'IDLE', lastInputAt: Date.now() });
    await swarm.tick();
    assert.equal(typed.length, 0);

    // idle: delivered once, and not from a session, so a question it then asks reaches the user
    architect.lastInputAt = 0;
    await swarm.tick();
    assert.equal(typed.length, 1);
    assert.equal(typed[0].to, 'lead');
    assert.match(typed[0].text, /worker "adder".*finished/s);
    assert.match(typed[0].text, /b is added, tests pass/);
    assert.match(typed[0].text, new RegExp(`Branch ${w.branch}: 1 commit, 1 file`));
    assert.equal(asked.at(-1), 'swarm');
    await new Promise((r) => setTimeout(r, 10));
    await swarm.tick();
    assert.equal(typed.length, 1);

    // not merged yet: its work can't be lost by accident
    await assert.rejects(swarm.remove(session, false), /not merged/);
    git('merge', '-q', w.branch!);
    const { worktree, branch } = w;
    await swarm.remove(session, false);
    assert.equal(manager.sessions.has(session.hubId), false);
    assert.equal(existsSync(worktree!), false);
    assert.equal(git('branch', '--list', branch!).trim(), '');
    assert.ok(existsSync(join(dir, 'b.txt')));
  } finally {
    if (session.worker?.worktree) rmSync(session.worker.worktree, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reports from several workers reach the architect as one prompt', async () => {
  const { manager, swarm, typed } = harness();
  const architect = { hubId: 'lead', claudeSessionId: 'arch-conv', name: 'lead', proc: {}, state: 'IDLE', lastInputAt: 0 } as unknown as HubSession;
  manager.sessions.set('lead', architect);
  for (const hubId of ['w1', 'w2']) {
    manager.sessions.set(hubId, { hubId, name: hubId, proc: {}, state: 'WORKING', stateSince: Date.now(), worker: link({ outbox: [`from ${hubId}`] }) } as unknown as HubSession);
  }
  await swarm.tick();
  assert.equal(typed.length, 1);
  assert.match(typed[0].text, /from w1[\s\S]*from w2/);
});

test('with its architect stopped, a report stays until it is back', async () => {
  const { manager, swarm, typed } = harness();
  const architect = { hubId: 'lead', claudeSessionId: 'arch-conv', name: 'lead', proc: null, state: 'EXITED', lastInputAt: 0 } as unknown as HubSession;
  manager.sessions.set('lead', architect);
  const w = { hubId: 'w1', name: 'w1', proc: null, state: 'EXITED', stateSince: Date.now(), worker: link({ status: 'reported', outbox: ['done'] }) } as unknown as HubSession;
  manager.sessions.set('w1', w);
  await swarm.tick();
  assert.equal(typed.length, 0);
  assert.deepEqual(w.worker?.outbox, ['done']);
  Object.assign(architect, { proc: {}, state: 'IDLE' });
  await swarm.tick();
  assert.equal(typed.length, 1);
});

test('a stalled worker tells the architect what it last said', async () => {
  const { manager, swarm, typed } = harness();
  const architect = { hubId: 'lead', claudeSessionId: 'arch-conv', name: 'lead', proc: {}, state: 'IDLE', lastInputAt: 0 } as unknown as HubSession;
  manager.sessions.set('lead', architect);
  const now = Date.now();
  manager.sessions.set('w1', { hubId: 'w1', name: 'w1', proc: {}, state: 'IDLE', stateSince: now - 60_000, worker: link({ nudgedAt: now - 120_000 }) } as unknown as HubSession);
  await swarm.tick(now);
  assert.match(typed[0].text, /it said this/);
  assert.equal(manager.sessions.get('w1')?.worker?.status, 'stalled');
});

test('a commit travels to a mirror and a branch comes back, with nothing else shared', async () => {
  const { dir, git } = repo();
  const root = mkdtempSync(join(tmpdir(), 'swarm-far-'));
  try {
    const mirror = await projectMirror('demo', root);
    const first = git('rev-parse', 'HEAD').trim();
    assert.deepEqual(await mirrorHeads(mirror), []);
    const whole = await bundleCommit(dir, first, []);
    assert.ok(whole);
    await receiveCommit(mirror, whole);
    assert.deepEqual(await mirrorHeads(mirror), [first]);
    // nothing new to send, and nothing left behind on the sender
    assert.equal(await bundleCommit(dir, first, [first]), undefined);
    assert.equal(git('for-each-ref', 'refs/deckhand').trim(), '');

    // the next base goes as the difference, and unknown commits in the list do no harm
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(200_000));
    git('add', '.');
    git('commit', '-qm', 'second');
    const second = git('rev-parse', 'HEAD').trim();
    const diff = await bundleCommit(dir, second, [first, 'f'.repeat(40)]);
    assert.ok(diff);
    await receiveCommit(mirror, diff);
    assert.ok((await mirrorHeads(mirror)).includes(second));

    // a worker on that mirror commits, and its branch reaches the original repo
    const worktree = join(root, 'w1');
    execFileSync('git', ['-C', mirror, 'worktree', 'add', '-q', '-b', 'worker/w1', worktree, second]);
    writeFileSync(join(worktree, 'c.txt'), 'c\n');
    execFileSync('git', ['-C', worktree, 'add', '.']);
    execFileSync('git', ['-C', worktree, '-c', 'user.name=w', '-c', 'user.email=w@w', 'commit', '-qm', 'c']);
    await receiveBranch(dir, 'worker/w1', await bundleBranch(mirror, 'worker/w1', second));
    assert.equal(git('log', '--format=%s', '-1', 'worker/w1').trim(), 'c');
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');

    // a follow-up moves the branch on
    writeFileSync(join(worktree, 'd.txt'), 'd\n');
    execFileSync('git', ['-C', worktree, 'add', '.']);
    execFileSync('git', ['-C', worktree, '-c', 'user.name=w', '-c', 'user.email=w@w', 'commit', '-qm', 'd']);
    await receiveBranch(dir, 'worker/w1', await bundleBranch(mirror, 'worker/w1', second));
    assert.equal(git('log', '--format=%s', '-1', 'worker/w1').trim(), 'd');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

function fleetHarness(answer: (conv: string, path: string, body: any) => { status: number; body: any } | undefined) {
  const h = harness();
  const sent: { path: string; body: any }[] = [];
  const swarm = new Swarm(h.manager as unknown as SessionManager, {
    typePrompt: async () => {},
    promptFrom: () => {},
    lastReply: async () => undefined,
    save() {},
    fleet: {
      self: 'alpha',
      call: async () => ({ status: 200, body: {} }),
      upload: async () => ({ status: 200, body: {} }),
      callArchitect: async (conv, path, body) => {
        sent.push({ path, body });
        return answer(conv, path, body);
      },
      isFrozen: (folder) => folder === 'icebox',
    },
  });
  return { ...h, swarm, sent };
}

test('a message for an architect elsewhere stays until its hub has it', async () => {
  let up = false;
  const { manager, swarm, sent } = fleetHarness(() => (up ? { status: 200, body: {} } : undefined));
  const w = { hubId: 'w1', claudeSessionId: 'w-conv', name: 'w1', proc: null, state: 'EXITED', stateSince: Date.now(), worker: link({ architectMachine: 'alpha', status: 'reported', outbox: ['done'], branch: 'worker/w1', sendBranch: true }) } as unknown as HubSession;
  manager.sessions.set('w1', w);
  await swarm.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent.length, 1);
  assert.deepEqual(w.worker?.outbox, ['done']);
  assert.equal(w.worker?.sendBranch, true);
  // it isn't tried again straight away
  await swarm.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent.length, 1);
  up = true;
  await swarm.tick(Date.now() + 60_000);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent.at(-1)?.body.branch, 'worker/w1');
  assert.equal(sent.at(-1)?.body.worker, 'w-conv');
  assert.equal(w.worker?.outbox, undefined);
  assert.equal(w.worker?.sendBranch, false);
});

test('messages from elsewhere join the rest, and wait for the architect to be idle', async () => {
  const { manager, swarm, typed } = harness();
  const architect = { hubId: 'lead', claudeSessionId: 'arch-conv', name: 'lead', proc: {}, state: 'WORKING', lastInputAt: 0, inbox: undefined } as unknown as HubSession;
  manager.sessions.set('lead', architect);
  swarm.acceptMessage(architect, 'from beta');
  await swarm.tick();
  assert.equal(typed.length, 0);
  architect.state = 'IDLE';
  await swarm.tick();
  assert.match(typed[0].text, /from beta/);
  assert.equal(architect.inbox, undefined);
});

test('a frozen folder, or one with no repository, stays on its machine', async () => {
  const { swarm } = fleetHarness(() => undefined);
  const plain = mkdtempSync(join(tmpdir(), 'swarm-plain-'));
  try {
    const lead = (cwd: string) => ({ hubId: 'lead', claudeSessionId: 'c', name: 'lead', cwd, role: 'architect', agentType: 'claude' }) as unknown as HubSession;
    await assert.rejects(swarm.start(lead('D:/p/icebox'), { task: 't', machine: 'beta' }), /frozen/);
    await assert.rejects(swarm.start(lead(plain), { task: 't', machine: 'beta' }), /not a git repository/);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test('removing a worker elsewhere asks the architect\'s repo whether it was merged', async () => {
  const far = repo();
  let merged = false;
  const { manager, swarm, sent } = fleetHarness((_c, path) => (path === 'worker-merged' ? { status: 200, body: { merged } } : { status: 200, body: {} }));
  const root = mkdtempSync(join(tmpdir(), 'swarm-trees-'));
  try {
    const t = await createWorktree(far.dir, 'w', root);
    writeFileSync(join(t!.worktree, 'x.txt'), 'x');
    execFileSync('git', ['-C', t!.worktree, 'add', '.']);
    execFileSync('git', ['-C', t!.worktree, 'commit', '-qm', 'x']);
    const s = { hubId: 'w1', name: 'w1', proc: null, worker: link({ architectMachine: 'alpha', worktree: t!.worktree, repo: t!.repo, branch: t!.branch, baseCommit: t!.baseCommit }) } as unknown as HubSession;
    manager.sessions.set('w1', s);
    await assert.rejects(swarm.remove(s, false), /not merged/);
    merged = true;
    await swarm.remove(s, false);
    assert.equal(existsSync(t!.worktree), false);
    assert.ok(sent.some((x) => x.path === 'worker-branch-gone'));
  } finally {
    rmSync(far.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
