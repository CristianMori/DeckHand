import { test } from 'node:test';
import assert from 'node:assert';
import { recordSessionRename, takeRenameNotice, type PendingRename } from './renameNotice.js';

const rename = (from: string, to: string): PendingRename => ({
  from,
  to,
  fromCwd: `C:\\Projects\\${from}`,
  toCwd: `C:\\Projects\\${to}`,
});

test('the notice names old and new, folder paths included, and is given only once', () => {
  const card: { renamed?: PendingRename } = {};
  recordSessionRename(card, rename('shop', 'bakery'));
  const notice = takeRenameNotice(card)!;
  assert.match(notice, /^\[Deckhand\] This session was renamed from shop to bakery\./);
  assert.ok(notice.includes('from C:\\Projects\\shop to C:\\Projects\\bakery'));
  assert.ok(notice.includes('old absolute paths in your context are stale'));
  assert.equal(card.renamed, undefined);
  assert.equal(takeRenameNotice(card), undefined);
});

test('a card never renamed owes no notice', () => {
  assert.equal(takeRenameNotice({}), undefined);
});

test('two renames before the resume read as one, from the original name to the last', () => {
  const card: { renamed?: PendingRename } = {};
  recordSessionRename(card, rename('shop', 'bakery'));
  recordSessionRename(card, rename('bakery', 'cafe'));
  const notice = takeRenameNotice(card)!;
  assert.ok(notice.includes('renamed from shop to cafe'));
  assert.ok(notice.includes('from C:\\Projects\\shop to C:\\Projects\\cafe'));
});

test('renaming back before the resume cancels the notice', () => {
  const card: { renamed?: PendingRename } = {};
  recordSessionRename(card, rename('shop', 'bakery'));
  recordSessionRename(card, rename('bakery', 'shop'));
  assert.equal(card.renamed, undefined);
});
