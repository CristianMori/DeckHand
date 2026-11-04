import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * scripts/check-secrets.mjs, exercised against throwaway git repositories.
 * Every planted "secret" is assembled at runtime, so this file itself never
 * contains anything the scanner (or GitHub's scanning) would match.
 */
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-secrets.mjs');

// fake values, assembled so no secret-shaped literal sits in this file
const fakeAnthropic = ['sk', 'ant', 'api03'].join('-') + '-Ab1'.repeat(12);
const fakeGithub = 'ghp' + '_' + 'A1b2C3d4'.repeat(5);
const fakePem = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
const fakeHermod = 'hm' + '_' + 'Zx9Yw8Vu7T6s5R4q';
const fakePhone = '+49' + '151' + '12345678';
const fakeIp = ['192', '168', '7', '23'].join('.');

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deckhand-secrets-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  return dir;
}

function scan(dir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

test('a clean tree passes', () => {
  const dir = repo();
  writeFileSync(join(dir, 'app.ts'), 'export const port = 5959;\n');
  const r = scan(dir, '--tree');
  assert.equal(r.status, 0, r.out);
});

test('a planted key fails the tree scan, redacted', () => {
  const dir = repo();
  writeFileSync(join(dir, 'config.ts'), `const key = '${fakeAnthropic}';\n`);
  const r = scan(dir, '--tree');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /anthropic-key/);
  assert.match(r.out, /config\.ts:1/);
  assert.ok(!r.out.includes(fakeAnthropic), 'the secret value must never be printed');
  assert.ok(r.out.includes(`(${fakeAnthropic.length})`), 'the fingerprint carries the length');
});

test('staged changes are scanned by the pre-commit mode', () => {
  const dir = repo();
  writeFileSync(join(dir, 'notes.md'), `token: ${fakeGithub}\n`);
  execFileSync('git', ['add', '.'], { cwd: dir });
  const r = scan(dir, '--staged');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /github-token/);
  assert.ok(!r.out.includes(fakeGithub));
  // nothing staged → clean
  execFileSync('git', ['rm', '--cached', '-q', 'notes.md'], { cwd: dir });
  assert.equal(scan(dir, '--staged').status, 0);
});

test('history and range scans see a secret that was committed and removed again', () => {
  const dir = repo();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'a.txt'), 'harmless\n');
  git('add', '.'); git('commit', '-q', '-m', 'one', '--no-verify');
  writeFileSync(join(dir, 'oops.txt'), `${fakePem}\n`);
  git('add', '.'); git('commit', '-q', '-m', 'two', '--no-verify');
  execFileSync('git', ['rm', '-q', 'oops.txt'], { cwd: dir });
  git('commit', '-q', '-m', 'three', '--no-verify');
  assert.equal(scan(dir, '--tree').status, 0, 'gone from the tree');
  const hist = scan(dir, '--history');
  assert.equal(hist.status, 1, hist.out);
  assert.match(hist.out, /private-key/);
  assert.match(hist.out, /oops\.txt/);
  const range = scan(dir, '--range', 'HEAD~2..HEAD~1');
  assert.equal(range.status, 1, range.out);
  const clean = scan(dir, '--range', 'HEAD~1..HEAD');
  assert.equal(clean.status, 0, clean.out);
});

test('the allowlist silences a named false positive, and only that one', () => {
  const dir = repo();
  writeFileSync(join(dir, 'fixture.ts'), `const k = '${fakeHermod}';\n`);
  assert.equal(scan(dir, '--tree').status, 1);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'check-secrets.allow'), `hermod-key fixture\\.ts hm_Zx9\n`);
  assert.equal(scan(dir, '--tree').status, 0, 'allowlisted');
  writeFileSync(join(dir, 'other.ts'), `const k = '${fakeHermod}X';\n`);
  assert.equal(scan(dir, '--tree').status, 1, 'a different file still fails');
});

test('exposures are reported: a phone number and a private address', () => {
  const dir = repo();
  writeFileSync(join(dir, 'contact.md'), `call ${fakePhone} or ${fakeIp}\n`);
  const r = scan(dir, '--tree');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /phone-number/);
  assert.match(r.out, /private-ip/);
  assert.ok(!r.out.includes(fakePhone.slice(1)), 'the number itself is never printed');
});
