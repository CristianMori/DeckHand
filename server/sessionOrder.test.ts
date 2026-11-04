import { test } from 'node:test';
import assert from 'node:assert';
import { sortSessions, orderSessions } from '../web/src/sessionOrder.js';
import type { SessionInfo, WorkerLink } from '../web/src/types.js';

const NOW = 1_700_000_000_000;

const sess = (name: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  hubId: name,
  claudeSessionId: `${name}-conv`,
  name,
  cwd: '/w',
  state: 'IDLE',
  stateSince: NOW - 60_000,
  createdAt: NOW - 600_000,
  alive: true,
  ...over,
});

const order = (sessions: SessionInfo[]) => sortSessions(sessions).map((s) => s.name);

test('architects sit above every state band, even a waiting session', () => {
  const list = [
    sess('waiting', { state: 'WAITING_QUESTION' }),
    sess('working', { state: 'WORKING' }),
    sess('arch', { role: 'architect', state: 'IDLE', lastOutputAt: NOW - 300_000 }),
  ];
  assert.deepEqual(order(list), ['arch', 'waiting', 'working']);
});

test('architects order by last active, not state rank: a waiting one does not jump a busier one', () => {
  const list = [
    sess('stale', { role: 'architect', state: 'WAITING_QUESTION', lastOutputAt: NOW - 120_000 }),
    sess('fresh', { role: 'architect', state: 'IDLE', lastOutputAt: NOW - 5_000 }),
  ];
  assert.deepEqual(order(list), ['fresh', 'stale']);
});

test('an architect from an older hub falls back to stateSince, then createdAt', () => {
  const list = [
    sess('noOutput', { role: 'architect', stateSince: NOW - 10_000 }),
    sess('hasOutput', { role: 'architect', lastOutputAt: NOW - 60_000, stateSince: NOW - 1_000 }),
    sess('bare', { role: 'architect', stateSince: 0, createdAt: NOW - 30_000 }),
  ];
  assert.deepEqual(order(list), ['noOutput', 'bare', 'hasOutput']);
});

test('everyone else keeps the state bands: waiting, working, idle, exited, unreachable', () => {
  const list = [
    sess('exited', { state: 'EXITED', alive: false }),
    sess('idle', { state: 'IDLE' }),
    sess('unreachable', { state: 'WORKING', unreachable: true }),
    sess('working', { state: 'WORKING' }),
    sess('waiting', { state: 'WAITING_PERMISSION' }),
  ];
  assert.deepEqual(order(list), ['waiting', 'working', 'idle', 'exited', 'unreachable']);
});

test('workers and sub-architects stay in their bands below the architects', () => {
  const list = [
    sess('sub', { role: 'subarchitect', state: 'WAITING_QUESTION' }),
    sess('worker', { role: 'worker', state: 'WORKING' }),
    sess('arch', { role: 'architect', state: 'IDLE', lastOutputAt: NOW - 400_000 }),
  ];
  assert.deepEqual(order(list), ['arch', 'sub', 'worker']);
});

// ── the card list: families placed by their root only, children stable ──

const link = (architect: string, startedAt: number, over: Partial<WorkerLink> = {}): WorkerLink => ({
  architect: `${architect}-conv`,
  architectName: architect,
  task: 't',
  baseFolder: '/w',
  status: 'working',
  startedAt,
  ...over,
});

const worker = (name: string, lead: string, startedAt: number, over: Partial<SessionInfo> = {}) =>
  sess(name, { role: 'worker', state: 'WORKING', worker: link(lead, startedAt), ...over });

const flat = (sessions: SessionInfo[], filter = '') =>
  orderSessions(sessions, filter).map((e) => `${e.session.name}:${e.depth}`);

test('families stay together: children sit under their lead whatever their state', () => {
  const list = [
    worker('w-exited', 'archB', NOW - 500_000, { state: 'EXITED', alive: false }),
    sess('archA', { role: 'architect', lastOutputAt: NOW - 1_000 }),
    worker('w-waiting', 'archA', NOW - 400_000, { state: 'WAITING_QUESTION' }),
    sess('archB', { role: 'architect', lastOutputAt: NOW - 60_000 }),
    sess('plain', { state: 'WORKING' }),
  ];
  assert.deepEqual(flat(list), ['archA:0', 'w-waiting:1', 'archB:0', 'w-exited:1', 'plain:0']);
});

test("a child's status change moves neither its family nor its siblings", () => {
  const family = (w2state: SessionInfo['state'], w2alive = true) => [
    sess('archA', { role: 'architect', lastOutputAt: NOW - 1_000 }),
    sess('archB', { role: 'architect', lastOutputAt: NOW - 60_000 }),
    worker('w1', 'archA', NOW - 300_000),
    worker('w2', 'archA', NOW - 200_000, { state: w2state, alive: w2alive, stateSince: NOW - 1 }),
    worker('w3', 'archA', NOW - 100_000),
  ];
  const before = flat(family('WORKING'));
  assert.deepEqual(before, ['archA:0', 'w1:1', 'w2:1', 'w3:1', 'archB:0']);
  // whatever w2 does — waits, idles, exits — nothing moves
  for (const state of ['WAITING_QUESTION', 'IDLE', 'EXITED'] as const) {
    assert.deepEqual(flat(family(state, state !== 'EXITED')), before);
  }
});

test('siblings order by start time, never by state or activity', () => {
  const list = [
    sess('arch', { role: 'architect' }),
    worker('late-waiting', 'arch', NOW - 100, { state: 'WAITING_QUESTION', stateSince: NOW - 90_000 }),
    worker('early-idle', 'arch', NOW - 500_000, { state: 'IDLE', lastOutputAt: NOW }),
  ];
  assert.deepEqual(flat(list), ['arch:0', 'early-idle:1', 'late-waiting:1']);
});

test('a sub-architect nests its own workers, two levels deep at most', () => {
  const list = [
    sess('arch', { role: 'architect' }),
    sess('sub', { role: 'subarchitect', worker: link('arch', NOW - 400_000) }),
    worker('w', 'sub', NOW - 300_000),
  ];
  assert.deepEqual(flat(list), ['arch:0', 'sub:1', 'w:2']);
});

test('a finished worker leaves the list; a finished sub-architect stays while its own crew goes on', () => {
  const list = [
    sess('arch', { role: 'architect' }),
    worker('done', 'arch', NOW - 400_000, { state: 'EXITED', alive: false, worker: link('arch', NOW - 400_000, { status: 'reported' }) }),
    sess('sub', { role: 'subarchitect', alive: false, state: 'EXITED', worker: link('arch', NOW - 300_000, { status: 'reported' }) }),
    worker('w', 'sub', NOW - 200_000),
  ];
  assert.deepEqual(flat(list), ['arch:0', 'sub:1', 'w:2']);
});

test('the filter matches name, cwd, machine and role, case-insensitively', () => {
  const list = [
    sess('Alpha', { machine: 'box-one' }),
    sess('beta', { cwd: '/projects/deckhand' }),
    sess('gamma', { role: 'worker', worker: link('nobody', NOW - 100_000) }),
  ];
  assert.deepEqual(flat(list, 'BOX-ONE'), ['Alpha:0']);
  assert.deepEqual(flat(list, 'deckhand'), ['beta:0']);
  assert.deepEqual(flat(list, 'worker'), ['gamma:0']);
  assert.equal(flat(list, '').length, 3); // no filter: everyone shows
});

test('a matching child keeps its parent in the list; non-matching families drop out', () => {
  const list = [
    sess('archA', { role: 'architect', lastOutputAt: NOW - 1_000 }),
    worker('needle-w', 'archA', NOW - 200_000),
    sess('archB', { role: 'architect', lastOutputAt: NOW - 60_000 }),
    worker('other-w', 'archB', NOW - 200_000),
  ];
  assert.deepEqual(flat(list, 'needle'), ['archA:0', 'needle-w:1']);
  // a matching root keeps its whole family readable
  assert.deepEqual(flat(list, 'archb'), ['archB:0', 'other-w:1']);
});
