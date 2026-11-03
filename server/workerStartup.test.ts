import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter, leadMcpChoices, projectMcpServers } from './agents/claude.js';
import { codexAdapter } from './agents/codex.js';
import { keyData } from './automation.js';

/**
 * A worker's worktree is a new path, so Claude treats it as a new project and
 * would ask "N new MCP servers found. Select any you wish to enable" — a
 * startup dialog nobody is at the keyboard to answer. These tests cover the
 * three defenses: the lead's recorded choice is found and inherited, the
 * worker's settings decide every server up front, and a dialog that appears
 * anyway is recognized instead of read as a stall.
 */

function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

const write = (dir: string, name: string, doc: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(doc));
};

test('the lead\'s MCP choice is read from settings.local.json, settings.json and ~/.claude.json, merged', () => {
  const folder = tempDir('mcp-lead-');
  const home = tempDir('mcp-home-');
  try {
    write(join(folder, '.claude'), 'settings.local.json', { enabledMcpjsonServers: ['alpha'], disabledMcpjsonServers: ['beta'] });
    write(join(folder, '.claude'), 'settings.json', { enabledMcpjsonServers: ['beta', 'gamma'] });
    // Claude keys projects by forward-slash path; the lookup must match whatever the separators
    write(home, '.claude.json', { projects: { [folder.replace(/\\/g, '/')]: { enabledMcpjsonServers: ['delta'] } } });
    const choices = leadMcpChoices(folder, home);
    assert.equal(choices.enableAll, false);
    assert.deepEqual(choices.enabled.sort(), ['alpha', 'delta', 'gamma']); // beta is disabled somewhere, so it is out
  } finally {
    rmSync(folder, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('enableAllProjectMcpServers in any source means everything is enabled', () => {
  const folder = tempDir('mcp-all-');
  const home = tempDir('mcp-home-');
  try {
    write(join(folder, '.claude'), 'settings.local.json', { enableAllProjectMcpServers: true });
    assert.equal(leadMcpChoices(folder, home).enableAll, true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('a lead with nothing recorded has chosen nothing', () => {
  const folder = tempDir('mcp-none-');
  const home = tempDir('mcp-home-');
  try {
    assert.deepEqual(leadMcpChoices(folder, home), { enableAll: false, enabled: [] });
  } finally {
    rmSync(folder, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('the worktree\'s .mcp.json is found from a subfolder, and the search stops at the repo root', () => {
  const root = tempDir('mcp-tree-');
  try {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { above: {} } })); // outside the repo
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'pkg', 'core'), { recursive: true });
    assert.deepEqual(projectMcpServers(join(repo, 'pkg', 'core')), []); // nothing inside the repo
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { alpha: {}, beta: {} } }));
    assert.deepEqual(projectMcpServers(join(repo, 'pkg', 'core')), ['alpha', 'beta']);
    writeFileSync(join(repo, '.mcp.json'), 'not json');
    assert.deepEqual(projectMcpServers(repo), []); // malformed: Claude ignores it too
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a worker\'s settings decide every project MCP server, so the dialog has nothing to ask', () => {
  const repo = tempDir('mcp-args-');
  try {
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { alpha: {}, beta: {}, gamma: {} } }));
    const argsOf = (mcpChoices?: { enableAll: boolean; enabled: string[] }) =>
      claudeAdapter.buildArgs({ sessionId: `t-mcp-${Math.random().toString(36).slice(2)}`, resume: false, name: 'w', cwd: repo, mcpChoices });
    const settingsOf = (args: string[]) => args[args.indexOf('--settings') + 1];

    // no choices handed over (a plain session): the shared hooks file, untouched
    assert.match(settingsOf(argsOf()), /hub-hooks\.json$/);

    const written = JSON.parse(readFileSync(settingsOf(argsOf({ enableAll: false, enabled: ['alpha', 'gone'] })), 'utf8'));
    assert.deepEqual(written.enabledMcpjsonServers, ['alpha']); // 'gone' is not in this worktree's .mcp.json
    assert.deepEqual(written.disabledMcpjsonServers, ['beta', 'gamma']);

    const all = JSON.parse(readFileSync(settingsOf(argsOf({ enableAll: true, enabled: [] })), 'utf8'));
    assert.deepEqual(all.enabledMcpjsonServers, ['alpha', 'beta', 'gamma']);
    assert.deepEqual(all.disabledMcpjsonServers, []);

    // the lead recorded nothing: everything off, and the worker still starts
    const none = JSON.parse(readFileSync(settingsOf(argsOf({ enableAll: false, enabled: [] })), 'utf8'));
    assert.deepEqual(none.enabledMcpjsonServers, []);
    assert.deepEqual(none.disabledMcpjsonServers, ['alpha', 'beta', 'gamma']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('startup dialogs are recognized on screen, a working screen is not', () => {
  const name = (screen: string) => claudeAdapter.startupDialog?.(screen);
  assert.match(name('23 new MCP servers found in this project\n Select any you wish to enable') ?? '', /23 new MCP servers found/);
  assert.match(name(' 1 new MCP server found in .mcp.json') ?? '', /1 new MCP server found/);
  assert.match(name('New MCP server found in this project: beta') ?? '', /New MCP server found/); // one undecided server has no count
  assert.match(name('Do you trust the files in this folder?') ?? '', /trust dialog/);
  assert.match(name('Select login method') ?? '', /login/);
  assert.equal(name('✻ Kerfuffling… (3m · ↓ 7.9k tokens)'), undefined);
  assert.match(codexAdapter.startupDialog?.('Do you trust the contents of this directory?') ?? '', /trust dialog/);
  assert.equal(codexAdapter.startupDialog?.('Ask Codex to do anything'), undefined);
});

test('named keys answer whatever the caller calls them', () => {
  assert.equal(keyData('Escape'), '\x1b');
  assert.equal(keyData('esc'), '\x1b');
  assert.equal(keyData('Return'), '\r');
  assert.equal(keyData('ENTER'), '\r');
  assert.equal(keyData('Delete'), '\x1b[3~');
  assert.equal(keyData('del'), '\x1b[3~');
  assert.equal(keyData('Up'), '\x1b[A');
  assert.equal(keyData('y'), 'y'); // not a name: typed literally
});
