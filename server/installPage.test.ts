import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * The /install page and its one-click installers: the generated scripts carry
 * the shelf URL the request implies (never a hard-coded machine name), the
 * page renders from the shelf's version.json, and the line endings fit each
 * OS. Pure-function tests first, then the real app over HTTP, the same
 * harness shape as hub.http.test.ts (env before any hub module loads).
 */

const dataDir = mkdtempSync(join(tmpdir(), 'hub-install-data-'));
const projectsRoot = mkdtempSync(join(tmpdir(), 'hub-install-projects-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.HUB_PROJECTS_ROOT = projectsRoot;
process.env.HUB_LISTEN = '0';
process.env.HUB_RESTORE = '0';
process.env.HUB_SOLO = '1';
process.env.HUB_EVEN_PORT = '0';

const { linuxOneLiner, macInstaller, renderInstallPage, validBase, windowsInstaller } = await import('./installPage.js');

// a local shelf: the routes must embed the host the request reached us by
mkdirSync(join(dataDir, 'releases'), { recursive: true });
writeFileSync(join(dataDir, 'releases', 'version.json'), JSON.stringify({ version: '0.0.0+999', build: 999, builtAt: new Date().toISOString() }));

// every test must be registered before the runner starts: the app import and
// listen() happen here, ahead of the first test()
const hub = await import('./index.js');
const port = await new Promise<number>((resolve, reject) => {
  hub.httpServer.once('error', reject);
  hub.httpServer.listen(0, '127.0.0.1', () => resolve((hub.httpServer.address() as AddressInfo).port));
});
const origin = `http://127.0.0.1:${port}`;

after(() => {
  hub.httpServer.close();
});

const BASE = 'http://hub-under-test:5959';

// ------------------------------------------------------------ pure functions

test('validBase accepts plain hosts and rejects anything that could escape a quote', () => {
  for (const good of [BASE, 'http://100.64.1.2:5959', 'https://box.tail1234.ts.net', 'http://[fd7a::1]:5959']) {
    assert.ok(validBase(good), good);
  }
  for (const bad of ['', 'http://a b', "http://x';calc", 'http://x"$(rm)', 'http://x/path', 'ftp://x', 'http://x:5959/releases']) {
    assert.ok(!validBase(bad), `must reject: ${bad}`);
  }
});

test('the Windows installer embeds the shelf URL, uses CRLF, and names no machine', () => {
  const out = windowsInstaller(BASE);
  assert.ok(out.includes(`$Base = '${BASE}'`), 'the base URL is embedded');
  assert.ok(!out.includes('__DECKHAND_BASE_URL__'), 'no placeholder left');
  assert.ok(!/[^\r]\n/.test(out) && !out.startsWith('\n'), 'every newline is CRLF (cmd needs it)');
  assert.ok(out.startsWith('@@echo off'), 'the cmd wrapper comes first');
  assert.ok(out.includes('install.ps1') && out.includes('-Mode service'), 'creates the service via install.ps1');
  assert.ok(out.includes('-DryRun') && out.includes('$DryRun'), 'supports a dry run');
  assert.ok(out.includes('New-NetFirewallRule'), 'adds the firewall rules');
  assert.ok(out.includes('hub-env.cmd'), 'writes hub-env.cmd');
  assert.ok(!out.includes('vps-node'), 'no machine name hard-coded');
});

test('the macOS installer embeds the shelf URL, uses LF, and names no machine', () => {
  const out = macInstaller(BASE);
  assert.ok(out.startsWith('#!/bin/bash'), 'a plain bash script');
  assert.ok(out.includes(`BASE="${BASE}"`), 'the base URL is embedded');
  assert.ok(!out.includes('__DECKHAND_BASE_URL__'), 'no placeholder left');
  assert.ok(!out.includes('\r'), 'no CR anywhere (bash chokes on CRLF)');
  assert.ok(out.includes('install-macos.sh'), 'runs the LaunchAgent installer');
  assert.ok(out.includes('--dry-run'), 'supports a dry run');
  assert.ok(!out.includes('vps-node'), 'no machine name hard-coded');
});

test('a base that could escape the quoting is refused outright', () => {
  for (const gen of [windowsInstaller, macInstaller, linuxOneLiner]) {
    assert.throws(() => gen("http://x' ; calc.exe ;'"), /not a usable shelf URL/);
    assert.throws(() => gen('http://x"; rm -rf /;"'), /not a usable shelf URL/);
  }
});

test('the page renders build, buttons, warnings and the Linux one-liner', () => {
  const html = renderInstallPage({ base: BASE, version: { build: 236, version: '0.3.0+236' } }, 'somehub');
  assert.ok(html.includes('build 236'), 'shows the shelf build');
  assert.ok(html.includes('/install/deckhand-install.cmd'), 'Windows download button');
  assert.ok(html.includes('/install/deckhand-install.command'), 'Mac download button');
  assert.ok(html.includes(linuxOneLiner(BASE).replace(/&/g, '&amp;')), 'Linux one-liner with the shelf URL');
  assert.ok(/Run anyway/.test(html), 'explains SmartScreen');
  assert.ok(/Gatekeeper/.test(html), 'explains Gatekeeper');
  assert.ok(html.includes('-Mode service -Account'), 'previews the run-as-user step');
  assert.ok(!html.includes('vps-node'), 'no machine name hard-coded');
});

test('without a reachable shelf the page still renders, with the buttons off', () => {
  const html = renderInstallPage(null, 'somehub');
  assert.ok(html.includes('release shelf not reachable'));
  assert.ok(!html.includes('/install/deckhand-install.cmd'), 'no live download link');
});

// -------------------------------------------------------- the real app, HTTP

test('GET /install serves the page with the local shelf build', async () => {
  const res = await fetch(`${origin}/install`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('build 999'), 'the shelf version.json build is shown');
  assert.ok(!html.includes('vps-node'), 'no machine name hard-coded in the served page');
});

test('the downloads embed the host the request was served from', async () => {
  const cmd = await fetch(`${origin}/install/deckhand-install.cmd`);
  assert.equal(cmd.status, 200);
  assert.match(cmd.headers.get('content-disposition') ?? '', /deckhand-install\.cmd/);
  const cmdBody = await cmd.text();
  assert.ok(cmdBody.includes(`$Base = '${origin}'`), 'the .cmd downloads from the host that served it');
  assert.ok(!cmdBody.includes('vps-node'), 'no machine name in the .cmd');

  const sh = await fetch(`${origin}/install/deckhand-install.command`);
  assert.equal(sh.status, 200);
  assert.match(sh.headers.get('content-disposition') ?? '', /deckhand-install\.command/);
  const shBody = await sh.text();
  assert.ok(shBody.includes(`BASE="${origin}"`), 'the .command downloads from the host that served it');
  assert.ok(!shBody.includes('\r'), 'LF only over the wire too');
  assert.ok(!shBody.includes('vps-node'), 'no machine name in the .command');
});

test('a hostile Host header cannot ride into the scripts', async () => {
  // fetch() refuses to forge Host, so speak raw http
  const { request } = await import('node:http');
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/install/deckhand-install.cmd', headers: { host: "x';calc;'" } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 503, 'an unusable host means no installer, never an injected one');
});
