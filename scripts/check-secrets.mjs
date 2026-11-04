#!/usr/bin/env node
/**
 * check-secrets — scan for secrets before they reach the public repository.
 *
 * Usage:
 *   node scripts/check-secrets.mjs                 staged changes (the pre-commit hook)
 *   node scripts/check-secrets.mjs --tree          every tracked + untracked (non-ignored) file (npm test)
 *   node scripts/check-secrets.mjs --range A..B    the patches of the commits in a range (publish)
 *   node scripts/check-secrets.mjs --history       every patch on every ref (full audit)
 *
 * Exit code 1 when anything is found, 0 when clean. A finding is printed as
 * kind, file, line, commit and a fingerprint (the first 4 characters plus the
 * length) — NEVER the matched value itself.
 *
 * False positives go in scripts/check-secrets.allow: one JavaScript regex per
 * line (# starts a comment), tested against the string "<kind> <file> <match>".
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The repository the current directory is in (hooks and npm run from its top). */
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
const ROOT = top.status === 0 ? top.stdout.trim() : process.cwd();
const ALLOW_FILE = join(ROOT, 'scripts', 'check-secrets.allow');
/** never scanned: they intentionally hold the patterns and the allowed matches */
const SELF = new Set(['scripts/check-secrets.mjs', 'scripts/check-secrets.allow']);
/** lock files: integrity hashes and registry URLs, no entropy/exposure scan */
const LOCK = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

// ---------------------------------------------------------------- the rules

const shannon = (s) => {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
};

/**
 * block: true → a secret, always refused. block: false → an exposure (phone
 * number, private address, e-mail) that must not land in a public repo either,
 * but is expected to need allowlist entries for legitimate mentions.
 * entropy: the match must additionally have at least this Shannon entropy.
 */
const RULES = [
  { kind: 'anthropic-key',   re: /\bsk-ant-[A-Za-z0-9_-]{12,}/g },
  { kind: 'openai-key',      re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/g, not: /^sk-ant-/ },
  { kind: 'github-token',    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { kind: 'discord-webhook', re: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{30,}/g },
  { kind: 'discord-bot',     re: /\b[MN][A-Za-z\d_-]{23}\.[\w-]{6}\.[\w-]{27,}\b/g },
  { kind: 'twilio',          re: /\b(?:AC|SK)[0-9a-f]{32}\b/g },
  { kind: 'aws-key-id',      re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { kind: 'aws-secret',      re: /\baws[\w.-]{0,20}['"‟][A-Za-z0-9/+=]{40}['"]/gi },
  { kind: 'google-key',      re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'slack-token',     re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { kind: 'slack-webhook',   re: /hooks\.slack\.com\/services\/T\w+\/B\w+\/\w{10,}/g },
  { kind: 'tailscale-key',   re: /\btskey-[A-Za-z0-9-]{12,}\b/g },
  { kind: 'hermod-key',      re: /\bhmb?_[A-Za-z0-9]{10,}\b/g },
  { kind: 'private-key',     re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP |)PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: 'jwt',             re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'bearer-literal',  re: /\bbearer\s+[A-Za-z0-9][A-Za-z0-9._~+/=-]{19,}\b/gi, entropy: 3.0 },
  { kind: 'url-credentials', re: /\b[a-z][a-z0-9+]{1,10}:\/\/[^\s:@'"`/\\]+:[^\s@'"`/\\]{4,}@/gi, not: /[$<{*]/ },
  { kind: 'password-assign', re: /\b(?:password|passwd|pwd)['"]?\s*[:=]\s*['"`][^'"`\s]{6,}['"`]/gi, not: /[$<{*]|passw|example|placeholder|changeme|dummy|test/i },
  { kind: 'secret-assign',   re: /\b(?:secret|token|api[_-]?key|apikey|auth[_-]?key|access[_-]?key|signing[_-]?key)['"]?\s*[:=]\s*['"`][A-Za-z0-9+/=_.-]{16,}['"`]/gi, entropy: 3.4, not: /[$<{*]/ },
  { kind: 'high-entropy',    re: /\b(?=[A-Za-z0-9+/=_-]*[A-Z])(?=[A-Za-z0-9+/=_-]*[a-z])(?=[A-Za-z0-9+/=_-]*[0-9])[A-Za-z0-9+/=_-]{36,}\b/g, entropy: 4.5, noLock: true },
  // not secrets, but they don't belong in a public repository either:
  { kind: 'phone-number',    re: /(?<![\w.+-])\+[1-9]\d{7,14}\b/g, block: false },
  { kind: 'private-ip',      re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g, block: false, noLock: true },
  { kind: 'email-address',   re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g, block: false, noLock: true,
    not: /@(?:example\.(?:com|org|net)|users\.noreply\.github\.com|localhost)$|^(?:user|someone|you|name|test|foo|bar)@/i },
];

// ------------------------------------------------------------ the allowlist

const allow = existsSync(ALLOW_FILE)
  ? readFileSync(ALLOW_FILE, 'utf8').split(/\r?\n/)
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((l) => new RegExp(l))
  : [];
const allowed = (kind, file, match) => allow.some((re) => re.test(`${kind} ${file} ${match}`));

// --------------------------------------------------------------- scanning

const findings = [];
const seen = new Set(); // one report per (kind, fingerprint, file)

function scanLine(text, where /* {file, line, commit} */) {
  const isLock = LOCK.test(where.file);
  for (const rule of RULES) {
    if (isLock && rule.noLock) continue;
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text))) {
      const match = m[0];
      if (rule.not && rule.not.test(match)) continue;
      if (rule.entropy && shannon(match) < rule.entropy) continue;
      if (allowed(rule.kind, where.file, match)) continue;
      const fp = `${match.slice(0, 4)}…(${match.length})`;
      const key = `${rule.kind}|${fp}|${where.file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ ...where, kind: rule.kind, fp, block: rule.block !== false });
    }
  }
}

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30, ...opts });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr || r.status}`);
  return r.stdout;
}

/** Scan a unified diff (added lines only), attributing to commit/file/line. */
function scanDiff(text, commitOfHunk = () => '') {
  let commit = '';
  let file = '';
  let line = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('@@COMMIT@@')) { commit = raw.slice(10).trim(); continue; }
    if (raw.startsWith('+++ b/')) { file = raw.slice(6); line = 0; continue; }
    if (raw.startsWith('+++')) { file = ''; continue; } // /dev/null
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) { line = Number(hunk[1]) - 1; continue; }
    if (raw.startsWith('+')) {
      line += 1;
      if (file && !SELF.has(file)) scanLine(raw.slice(1), { file, line, commit: commit || commitOfHunk() });
    }
  }
}

function scanTree() {
  const files = git(['ls-files', '-c', '-o', '--exclude-standard']).split('\n').filter(Boolean);
  for (const file of files) {
    if (SELF.has(file)) continue;
    const path = join(ROOT, file);
    let buf;
    try {
      if (!existsSync(path) || statSync(path).size > 10 * 1024 * 1024) continue;
      buf = readFileSync(path);
    } catch { continue; }
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) scanLine(lines[i], { file, line: i + 1, commit: '' });
  }
}

// ----------------------------------------------------------------- modes

const argv = process.argv.slice(2);
const mode = argv.find((a) => a.startsWith('--')) ?? '--staged';
try {
  if (mode === '--tree') {
    scanTree();
  } else if (mode === '--history') {
    scanDiff(git(['log', '--all', '-p', '-U0', '--no-color', '--format=@@COMMIT@@ %h %s']));
  } else if (mode === '--range') {
    const range = argv[argv.indexOf('--range') + 1];
    if (!range) { console.error('check-secrets: --range needs A..B'); process.exit(2); }
    scanDiff(git(['log', '-p', '-U0', '--no-color', '--format=@@COMMIT@@ %h %s', range]));
  } else if (mode === '--staged') {
    scanDiff(git(['diff', '--cached', '-U0', '--no-color']));
  } else {
    console.error(`check-secrets: unknown mode ${mode} (use --staged | --tree | --range A..B | --history)`);
    process.exit(2);
  }
} catch (err) {
  console.error(`check-secrets: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
}

// ----------------------------------------------------------------- report

if (!findings.length) {
  console.log(`check-secrets: clean (${mode.slice(2)})`);
  process.exit(0);
}
const blockers = findings.filter((f) => f.block);
const exposures = findings.filter((f) => !f.block);
const show = (f) =>
  console.error(`  ${f.kind.padEnd(16)} ${f.file}:${f.line}${f.commit ? `  [${f.commit}]` : ''}  ${f.fp}`);
if (blockers.length) { console.error(`check-secrets: ${blockers.length} possible secret(s) — values redacted:`); blockers.forEach(show); }
if (exposures.length) { console.error(`check-secrets: ${exposures.length} exposure(s) (phone / private IP / e-mail):`); exposures.forEach(show); }
console.error(`\nA false positive? Add a line to scripts/check-secrets.allow matching "<kind> <file> <match>".`);
process.exit(1);
