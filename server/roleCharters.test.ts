import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MAX_CHARTER_BYTES,
  deleteFleetRole,
  fleetRolesSnapshot,
  fleetRolesVersion,
  initRoleCharters,
  listCharters,
  matchesPaths,
  parseCharter,
  putFleetRole,
  resolveCharter,
  syncRoles,
  type RoleCharter,
} from './roleCharters.js';

/** Fresh builtin + fleet dirs, wired as the authority unless told otherwise. */
function rig(opts: { authority?: boolean; callAuthority?: Parameters<typeof initRoleCharters>[0]['callAuthority'] } = {}) {
  const builtinDir = mkdtempSync(join(tmpdir(), 'roles-builtin-'));
  const fleetDir = mkdtempSync(join(tmpdir(), 'roles-fleet-'));
  initRoleCharters({
    selfName: () => 'here',
    authorityName: opts.authority === false ? 'elsewhere' : 'here',
    callAuthority: opts.callAuthority ?? (async () => undefined),
    builtinDir,
    fleetDir,
  });
  const builtin = (name: string, text: string) => writeFileSync(join(builtinDir, `${name}.md`), text);
  const fleet = (name: string, text: string) => writeFileSync(join(fleetDir, `${name}.md`), text);
  return { builtinDir, fleetDir, builtin, fleet };
}

const charter = (over: Partial<RoleCharter> = {}): RoleCharter => ({
  name: 'x', title: 'x', on: 'merge', paths: [], platforms: 'any', skip: {}, enabled: true, body: 'b', layers: ['builtin'],
  ...over,
});

// ---- front matter

test('front matter: scalars, booleans, numbers, inline lists and the skip map', () => {
  const { fields, body } = parseCharter(
    `---\ntitle: The Tester\non: merge\nplatforms: [win32, darwin]\nmodel: sonnet\nenabled: false\nskip:\n  underLines: 10\n  docsOnly: true\n---\nDo the thing.\n\nCarefully.`,
  );
  assert.equal(fields.title, 'The Tester');
  assert.equal(fields.on, 'merge');
  assert.deepEqual(fields.platforms, ['win32', 'darwin']);
  assert.equal(fields.model, 'sonnet');
  assert.equal(fields.enabled, false);
  assert.deepEqual(fields.skip, { underLines: 10, docsOnly: true });
  assert.equal(body, 'Do the thing.\n\nCarefully.');
});

test('front matter: quotes strip, empty lists parse, unknown fields are kept, comments and blanks skipped', () => {
  const { fields } = parseCharter(`---\ntitle: "Quoted title"\npaths: []\n\n# a comment\nfancy-new-field: 7\n---\nbody`);
  assert.equal(fields.title, 'Quoted title');
  assert.deepEqual(fields.paths, []);
  assert.equal(fields['fancy-new-field'], 7);
});

test('a file with no front matter is all body; malformed front matter throws', () => {
  const plain = parseCharter('Just prose, no fences.');
  assert.deepEqual(plain.fields, {});
  assert.equal(plain.body, 'Just prose, no fences.');
  assert.throws(() => parseCharter('---\ntitle: x\nno closing fence'), /never closes/);
  assert.throws(() => parseCharter('---\nnot a key value line\n---\nbody'), /not "key: value"/);
  assert.throws(() => parseCharter('---\n  orphan: 1\n---\nbody'), /indented under nothing/);
});

// ---- layering

test('layers merge per field, and the body comes whole from the most specific non-empty layer', () => {
  const { builtin, fleet } = rig();
  builtin('tester', `---\ntitle: Tester\nplatforms: all\nmodel: sonnet\nskip:\n  underLines: 10\n  docsOnly: true\n---\nBuilt-in body.`);
  fleet('tester', `---\nmodel: opus\nskip:\n  underLines: 3\n---\n`);
  const c = resolveCharter('tester')!;
  assert.equal(c.title, 'Tester'); // builtin, untouched by fleet
  assert.equal(c.model, 'opus'); // fleet wins
  assert.deepEqual(c.skip, { underLines: 3 }); // skip is one field: the fleet map replaces the builtin one
  assert.equal(c.platforms, 'all');
  assert.equal(c.body, 'Built-in body.'); // fleet body is empty: builtin's stays
  assert.deepEqual(c.layers, ['builtin', 'fleet']);

  const p = resolveCharter('tester', `---\npaths: [server/**]\n---\nProject body.`)!;
  assert.equal(p.body, 'Project body.'); // most specific non-empty body
  assert.deepEqual(p.paths, ['server/**']);
  assert.equal(p.model, 'opus'); // fleet still beats builtin under the project layer
  assert.deepEqual(p.layers, ['builtin', 'fleet', 'project']);
});

test('enabled: false at any layer switches the role off, whatever the other layers say', () => {
  const { builtin, fleet } = rig();
  builtin('tester', `---\nenabled: true\n---\nbody`);
  fleet('tester', `---\nenabled: false\n---\n`);
  assert.equal(resolveCharter('tester')!.enabled, false);
  // a more specific true does not bring it back
  assert.equal(resolveCharter('tester', `---\nenabled: true\n---\n`)!.enabled, false);
  // and a project-layer false alone switches it off too
  assert.equal(resolveCharter('tester', `---\nenabled: false\n---\n`)!.enabled, false);
  fleet('tester', `---\nmodel: opus\n---\n`);
  assert.equal(resolveCharter('tester')!.enabled, true);
});

test('the docs flag defaults off, and the most specific layer that sets it wins', () => {
  const { builtin, fleet } = rig();
  builtin('keeper', `---\ndocs: true\n---\nkeeper body`);
  builtin('plain', 'just a body');
  assert.ok(!resolveCharter('plain')!.docs); // unset: the role does not need the lead's documents
  assert.equal(resolveCharter('keeper')!.docs, true);
  fleet('keeper', `---\ndocs: false\n---\n`);
  assert.equal(resolveCharter('keeper')!.docs, false); // fleet beats builtin
  assert.equal(resolveCharter('keeper', `---\ndocs: true\n---\n`)!.docs, true); // project beats fleet
});

test('a fleet or project file with no builtin creates a new role with defaults', () => {
  const { fleet } = rig();
  fleet('linter', 'Run the linter and report.');
  const c = resolveCharter('linter')!;
  assert.equal(c.title, 'linter');
  assert.equal(c.on, 'merge');
  assert.deepEqual(c.paths, []);
  assert.equal(c.platforms, 'any');
  assert.deepEqual(c.skip, {});
  assert.equal(c.enabled, true);
  assert.equal(c.body, 'Run the linter and report.');
  assert.deepEqual(c.layers, ['fleet']);
  assert.equal(resolveCharter('nobody-home'), undefined);
});

test('listCharters unions the layers and resolves each name once', () => {
  const { builtin, fleet } = rig();
  builtin('tester', `---\ntitle: Tester\n---\nt`);
  fleet('tester', `---\nmodel: opus\n---\n`);
  fleet('linter', 'lint body');
  const all = listCharters(new Map([['ux', `---\ntitle: UX\n---\nux body`]]));
  assert.deepEqual(all.map((c) => c.name), ['linter', 'tester', 'ux']);
  assert.equal(all.find((c) => c.name === 'tester')!.model, 'opus');
  assert.deepEqual(all.find((c) => c.name === 'ux')!.layers, ['project']);
});

test('a layer whose front matter is broken is skipped, not fatal', () => {
  const { builtin, fleet } = rig();
  builtin('tester', `---\ntitle: Tester\n---\ngood body`);
  fleet('tester', `---\nbroken without close`);
  const c = resolveCharter('tester')!;
  assert.equal(c.title, 'Tester');
  assert.deepEqual(c.layers, ['builtin']);
});

// ---- path globs

test('matchesPaths: empty paths match every merge', () => {
  assert.ok(matchesPaths(charter({ paths: [] }), ['anything.ts']));
  assert.ok(matchesPaths(charter({ paths: [] }), []));
});

test('matchesPaths: * stays within one segment, ** crosses segments', () => {
  const star = charter({ paths: ['server/*.ts'] });
  assert.ok(matchesPaths(star, ['server/index.ts']));
  assert.ok(!matchesPaths(star, ['server/agents/claude.ts']));
  assert.ok(!matchesPaths(star, ['web/index.ts']));

  const deep = charter({ paths: ['web/**'] });
  assert.ok(matchesPaths(deep, ['web/src/api.ts']));
  assert.ok(!matchesPaths(deep, ['server/index.ts']));

  const suffix = charter({ paths: ['**/*.css'] });
  assert.ok(matchesPaths(suffix, ['web/src/styles.css']));
  assert.ok(matchesPaths(suffix, ['top.css'])); // '**/' may match no directory at all
  assert.ok(!matchesPaths(suffix, ['web/src/styles.ts']));

  // one matching file among many is enough; backslashes are normalized
  assert.ok(matchesPaths(deep, ['README.md', 'web\\src\\main.ts']));
});

test('matchesPaths: dot-files are ordinary names and regex characters stay literal', () => {
  assert.ok(matchesPaths(charter({ paths: ['*'] }), ['.gitignore']));
  assert.ok(matchesPaths(charter({ paths: ['.github/**'] }), ['.github/workflows/ci.yml']));
  assert.ok(!matchesPaths(charter({ paths: ['a.ts'] }), ['axts'])); // the dot is a dot
});

// ---- the fleet store on the authority

test('fleet put and delete bump the version, and the snapshot carries the set', async () => {
  rig();
  assert.equal(fleetRolesVersion(), 0);
  const put = await putFleetRole('tester', `---\nmodel: opus\n---\nfleet body`);
  assert.equal(put.version, 1);
  assert.equal(resolveCharter('tester')!.body, 'fleet body');
  await putFleetRole('linter', 'lint it');
  assert.equal(fleetRolesVersion(), 2);
  assert.deepEqual(fleetRolesSnapshot(), {
    version: 2,
    files: { linter: 'lint it', tester: `---\nmodel: opus\n---\nfleet body` },
  });
  const del = await deleteFleetRole('linter');
  assert.deepEqual(del, { name: 'linter', deleted: true, version: 3 });
  assert.equal(resolveCharter('linter'), undefined);
  // deleting what is not there changes nothing
  assert.equal((await deleteFleetRole('linter')).version, 3);
});

test('fleet writes are validated: slug, size, parsable front matter', async () => {
  rig();
  await assert.rejects(putFleetRole('Not A Slug', 'x'), /slug/);
  await assert.rejects(putFleetRole('x'.repeat(31), 'x'), /slug/);
  await assert.rejects(putFleetRole('big', 'x'.repeat(MAX_CHARTER_BYTES + 1)), /16 KB/);
  await assert.rejects(putFleetRole('bad', '---\nno close'), /never closes/);
  await assert.rejects(putFleetRole('empty', '   '), /empty/);
  assert.equal(fleetRolesVersion(), 0); // nothing landed
});

test('a replica refuses the edit when the authority is unreachable — no queue', async () => {
  rig({ authority: false, callAuthority: async () => undefined });
  await assert.rejects(putFleetRole('tester', 'body'), /unreachable.*not queued/s);
  await assert.rejects(deleteFleetRole('tester'), /unreachable.*not queued/s);
  assert.equal(fleetRolesVersion(), 0);
});

test('a replica forwards the edit and pulls the authority set when the version moved', async () => {
  const authority: { version: number; files: Record<string, string> } = {
    version: 4,
    files: { tester: `---\nmodel: opus\n---\nsynced body` },
  };
  const calls: string[] = [];
  rig({
    authority: false,
    callAuthority: async (path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/roles/sync') return { status: 200, body: authority };
      if (init?.method === 'PUT') return { status: 200, body: { name: 'tester', version: 4 } };
      return undefined;
    },
  });
  const out = await putFleetRole('tester', `---\nmodel: opus\n---\nsynced body`);
  assert.deepEqual(out, { name: 'tester', version: 4 });
  assert.deepEqual(calls, ['PUT /api/roles/tester', 'GET /api/roles/sync']);
  assert.equal(fleetRolesVersion(), 4);
  assert.equal(resolveCharter('tester')!.body, 'synced body');

  // a later pull with the same version is a no-op; a moved version replaces the set
  await syncRoles();
  authority.version = 5;
  authority.files = { 'doc-keeper': 'keep docs' };
  await syncRoles();
  assert.equal(fleetRolesVersion(), 5);
  assert.equal(resolveCharter('tester'), undefined); // the stale file went with the pull
  assert.equal(resolveCharter('doc-keeper')!.body, 'keep docs');
});

// ---- the shipped charters

test('the built-in tester and doc keeper parse to what the design says', () => {
  const read = (n: string) => readFileSync(join(import.meta.dirname, 'roles', `${n}.md`), 'utf8');
  assert.ok(existsSync(join(import.meta.dirname, 'roles')));
  const tester = parseCharter(read('tester'));
  assert.equal(tester.fields.platforms, 'all');
  assert.equal(tester.fields.model, 'sonnet');
  assert.deepEqual(tester.fields.skip, { underLines: 10, docsOnly: true });
  assert.match(tester.body, /report only/i);
  assert.match(tester.body, /never fix|never commit|never push/i);
  const keeper = parseCharter(read('doc-keeper'));
  assert.equal(keeper.fields.platforms, 'any');
  assert.equal(keeper.fields.model, 'sonnet');
  assert.equal(keeper.fields.docs, true); // it needs the lead's working documents
  assert.deepEqual(keeper.fields.skip, { underLines: 5 });
  assert.match(keeper.body, /docs\/architect\//);
  assert.match(keeper.body, /lead's working files/);
  assert.match(keeper.body, /what they should say/);
  assert.match(keeper.body, /⎇ branch markers/);
  assert.match(keeper.body, /In flight list/);
  assert.match(keeper.body, /never edit/i);
});
