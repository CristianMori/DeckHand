import { test } from 'node:test';
import assert from 'node:assert';
import { sortSessions } from '../web/src/sessionOrder.js';
import type { SessionInfo } from '../web/src/types.js';

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
