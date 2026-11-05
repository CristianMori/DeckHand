import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * The /install subtree: the page and its one-click installers. The base URL
 * the scripts download from follows the precedence HUB_INSTALL_PUBLIC_URL →
 * X-Forwarded-* from a loopback proxy → the request itself, is validated so
 * nothing can escape the scripts' quoting, and never hard-codes a machine
 * name. Pure-function tests first, then the real app over HTTP (the same
 * harness shape as hub.http.test.ts: env before any hub module loads).
 */

const dataDir = mkdtempSync(join(tmpdir(), 'hub-install-data-'));
const projectsRoot = mkdtempSync(join(tmpdir(), 'hub-install-projects-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.HUB_PROJECTS_ROOT = projectsRoot;
process.env.HUB_LISTEN = '0';
process.env.HUB_RESTORE = '0';
process.env.HUB_SOLO = '1';
process.env.HUB_EVEN_PORT = '0';
delete process.env.HUB_INSTALL_PUBLIC_URL;

const { installMeta, linuxInstaller, linuxOneLiner, macInstaller, renderInstallPage, resolveInstallBase, validInstallBase, validPrefix, windowsInstaller } =
  await import('./installPage.js');

// a local shelf: by default the routes embed the host the request reached us by
const releasesDir = join(dataDir, 'releases');
mkdirSync(releasesDir, { recursive: true });
writeFileSync(join(releasesDir, 'version.json'), JSON.stringify({ version: '0.0.0+999', build: 999, builtAt: new Date().toISOString() }));
writeFileSync(join(releasesDir, 'deckhand-release.tgz'), 'FAKE-TGZ-BYTES');

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

const BASE = 'http://hub-under-test:5959/install';

// ------------------------------------------------------------ pure functions

test('validInstallBase accepts host[:port][/path] and rejects anything that could escape a quote', () => {
  for (const good of [BASE, 'http://100.64.1.2:5959', 'https://box.tail1234.ts.net/deckhand', 'http://[fd7a::1]:5959/install', 'http://vps/a/b-c']) {
    assert.ok(validInstallBase(good), good);
  }
  for (const bad of ['', 'http://a b', "http://x';calc", 'http://x"$(rm)', 'ftp://x', 'http://x/', 'http://x//a', 'http://x/a/', 'http://x/a?b', 'http://x/a#b']) {
    assert.ok(!validInstallBase(bad), `must reject: ${bad}`);
  }
});

test('validPrefix takes plain absolute paths only', () => {
  for (const good of ['/deckhand', '/a/b', '/', '/deckhand/']) assert.ok(validPrefix(good), good);
  for (const bad of ['deckhand', '/a b', "/a';x", '/a//b', '/a?b', '/a$(x)']) assert.ok(!validPrefix(bad), `must reject: ${bad}`);
});

test('resolveInstallBase precedence: setting → loopback forwarded headers → the request', () => {
  const plain = { host: 'myhub:5959', loopback: false };
  assert.deepEqual(resolveInstallBase(plain), { base: 'http://myhub:5959/install', proxied: false });

  // forwarded headers are believed only from a loopback peer (the proxy)
  const fwd = { forwardedHost: 'vps-node', forwardedProto: 'http', forwardedPrefix: '/deckhand' };
  assert.deepEqual(resolveInstallBase({ ...plain, loopback: true, ...fwd }), { base: 'http://vps-node/deckhand', proxied: true });
  assert.deepEqual(resolveInstallBase({ ...plain, loopback: false, ...fwd }), { base: 'http://myhub:5959/install', proxied: false });

  // a forwarded host without a prefix: proxied look, but no Home link
  assert.deepEqual(resolveInstallBase({ host: 'x', loopback: true, forwardedHost: 'vps-node' }), { base: 'http://vps-node', proxied: false });

  // a bad prefix is refused, not silently dropped
  assert.equal(resolveInstallBase({ ...plain, loopback: true, forwardedHost: 'vps-node', forwardedPrefix: "/a';x" }), null);

  // the setting wins over everything
  process.env.HUB_INSTALL_PUBLIC_URL = 'http://public-name/deckhand/';
  try {
    assert.deepEqual(resolveInstallBase({ ...plain, loopback: true, ...fwd }), { base: 'http://public-name/deckhand', proxied: true });
  } finally {
    delete process.env.HUB_INSTALL_PUBLIC_URL;
  }
});

test('the Windows installer embeds the base, uses CRLF, and names no machine', () => {
  const out = windowsInstaller(BASE);
  assert.ok(out.includes(`$Base = '${BASE}'`), 'the base URL is embedded');
  assert.ok(!out.includes('__DECKHAND_BASE_URL__'), 'no placeholder left');
  assert.ok(!/[^\r]\n/.test(out) && !out.startsWith('\n'), 'every newline is CRLF (cmd needs it)');
  assert.ok(out.startsWith('@@echo off'), 'the cmd wrapper comes first');
  assert.ok(out.includes('install.ps1') && out.includes('-Mode service'), 'creates the service via install.ps1');
  assert.ok(out.includes('-DryRun') && out.includes('$DryRun'), 'supports a dry run');
  assert.ok(out.includes('New-NetFirewallRule'), 'adds the firewall rules');
  assert.ok(out.includes('hub-env.cmd'), 'writes hub-env.cmd');
  assert.ok(out.includes('$Base/release.tgz') && out.includes('$Base/version.json'), 'downloads stay inside the subtree');
  assert.ok(!out.includes('vps-node'), 'no machine name hard-coded');
});

test('the macOS and Linux installers embed the base, use LF, and name no machine', () => {
  for (const [gen, runs] of [
    [macInstaller, 'install-macos.sh'],
    [linuxInstaller, 'scripts/install.sh'],
  ] as const) {
    const out = gen(BASE);
    assert.ok(out.startsWith('#!/bin/bash'), 'a plain bash script');
    assert.ok(out.includes(`BASE="${BASE}"`), 'the base URL is embedded');
    assert.ok(!out.includes('__DECKHAND_BASE_URL__'), 'no placeholder left');
    assert.ok(!out.includes('\r'), 'no CR anywhere (bash chokes on CRLF)');
    assert.ok(out.includes(runs), `runs ${runs}`);
    assert.ok(out.includes('--dry-run'), 'supports a dry run');
    assert.ok(out.includes('$BASE/release.tgz') && out.includes('$BASE/version.json'), 'downloads stay inside the subtree');
    assert.ok(!out.includes('vps-node'), 'no machine name hard-coded');
  }
});

test('a base that could escape the quoting is refused outright', () => {
  for (const gen of [windowsInstaller, macInstaller, linuxInstaller, linuxOneLiner]) {
    assert.throws(() => gen("http://x' ; calc.exe ;'"), /not a usable install base/);
    assert.throws(() => gen('http://x"; rm -rf /;"'), /not a usable install base/);
  }
});

test('the page renders build, relative buttons, warnings and the Linux one-liner', () => {
  const html = renderInstallPage({ version: { build: 236, version: '0.3.0+236' }, downloads: true, base: BASE, homeLink: false, machine: 'somehub' });
  assert.ok(html.includes('build 236'), 'shows the shelf build');
  assert.ok(html.includes('href="windows.cmd"') && html.includes('href="mac.command"'), 'download links are relative');
  assert.ok(html.includes(linuxOneLiner(BASE).replace(/&/g, '&amp;')), 'Linux one-liner fetches linux.sh from the base');
  assert.ok(/Run anyway/.test(html), 'explains SmartScreen');
  assert.ok(/Gatekeeper/.test(html), 'explains Gatekeeper');
  assert.ok(html.includes('-Mode service -Account'), 'previews the run-as-user step');
  assert.ok(!html.includes('&larr; Home'), 'no Home link without a proxy');
  assert.ok(!html.includes('vps-node'), 'no machine name hard-coded');

  const proxied = renderInstallPage({ version: { build: 236 }, downloads: true, base: 'http://vps-node/deckhand', homeLink: true, machine: 'somehub' });
  assert.ok(proxied.includes('href="../"') && proxied.includes('&larr; Home'), 'proxied page links back to the landing page');
});

test('without a reachable shelf the page still renders, with the buttons off', () => {
  const html = renderInstallPage({ downloads: false, homeLink: false, machine: 'somehub' });
  assert.ok(html.includes('release shelf not reachable'));
  assert.ok(!html.includes('href="windows.cmd"'), 'no live download link');
});

test('installMeta is landing-page food: identity plus relative links', () => {
  const meta = installMeta({ build: 236, version: '0.3.0+236' });
  assert.equal(meta.name, 'Deckhand');
  assert.equal(meta.build, 236);
  assert.equal(meta.links.windows, 'windows.cmd');
  assert.equal(meta.links.release, 'release.tgz');
  assert.equal(installMeta(undefined).build, null);
});

// -------------------------------------------------------- the real app, HTTP

test('GET /install redirects to /install/ so relative links resolve', async () => {
  const res = await fetch(`${origin}/install`, { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/install/');
});

test('GET /install/ serves the page with the local shelf build and relative links', async () => {
  const res = await fetch(`${origin}/install/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('build 999'), "the shelf version.json's build is shown");
  assert.ok(html.includes('href="windows.cmd"'), 'relative download link');
  assert.ok(!html.includes('vps-node'), 'no machine name hard-coded in the served page');
});

test('the downloads embed the host the request was served from', async () => {
  const cmd = await fetch(`${origin}/install/windows.cmd`);
  assert.equal(cmd.status, 200);
  assert.match(cmd.headers.get('content-disposition') ?? '', /deckhand-install\.cmd/);
  const cmdBody = await cmd.text();
  assert.ok(cmdBody.includes(`$Base = '${origin}/install'`), 'the .cmd downloads from the subtree that served it');

  for (const [file, expect] of [
    ['mac.command', `BASE="${origin}/install"`],
    ['linux.sh', `BASE="${origin}/install"`],
    ['deckhand-install.cmd', `$Base = '${origin}/install'`], // first-version alias
    ['deckhand-install.command', `BASE="${origin}/install"`],
  ] as const) {
    const res = await fetch(`${origin}/install/${file}`);
    assert.equal(res.status, 200, file);
    assert.ok((await res.text()).includes(expect), `${file} embeds the serving subtree`);
  }
});

test('forwarded headers from a loopback proxy set the embedded base', async () => {
  const res = await fetch(`${origin}/install/linux.sh`, {
    headers: { 'x-forwarded-host': 'example-host', 'x-forwarded-proto': 'http', 'x-forwarded-prefix': '/deckhand' },
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('BASE="http://example-host/deckhand"'), 'the script downloads through the proxy path');

  const page = await (await fetch(`${origin}/install/`, { headers: { 'x-forwarded-host': 'example-host', 'x-forwarded-prefix': '/deckhand' } })).text();
  assert.ok(page.includes('href="../"') && page.includes('&larr; Home'), 'the proxied page shows the Home link');

  const bad = await fetch(`${origin}/install/linux.sh`, { headers: { 'x-forwarded-host': 'example-host', 'x-forwarded-prefix': "/a';x" } });
  assert.equal(bad.status, 503, 'a hostile prefix means no installer, never an injected one');
});

test('HUB_INSTALL_PUBLIC_URL wins over the request', async () => {
  process.env.HUB_INSTALL_PUBLIC_URL = 'http://public-name/deckhand';
  try {
    const body = await (await fetch(`${origin}/install/mac.command`)).text();
    assert.ok(body.includes('BASE="http://public-name/deckhand"'), 'the configured public URL is embedded');
  } finally {
    delete process.env.HUB_INSTALL_PUBLIC_URL;
  }
});

test('a hostile Host header cannot ride into the scripts', async () => {
  // fetch() refuses to forge Host, so speak raw http
  const { request } = await import('node:http');
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/install/windows.cmd', headers: { host: "x';calc;'" } },
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

test('meta.json answers with CORS for the landing page', async () => {
  const res = await fetch(`${origin}/install/meta.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const meta = (await res.json()) as { name: string; build: number; links: Record<string, string> };
  assert.equal(meta.name, 'Deckhand');
  assert.equal(meta.build, 999);
  assert.equal(meta.links.linux, 'linux.sh');
});

test('release.tgz and version.json are served from the local shelf', async () => {
  const tgz = await fetch(`${origin}/install/release.tgz`);
  assert.equal(tgz.status, 200);
  assert.equal(await tgz.text(), 'FAKE-TGZ-BYTES');
  const v = (await (await fetch(`${origin}/install/version.json`)).json()) as { build: number };
  assert.equal(v.build, 999);
});

test('without a local shelf, release.tgz redirects to the release machine', async () => {
  const parked = join(dataDir, 'releases-parked');
  renameSync(releasesDir, parked);
  const federation = hub.federation as unknown as { peerByMachine: (m: string) => unknown };
  const realPeerByMachine = federation.peerByMachine;
  federation.peerByMachine = () => ({ info: { url: 'http://shelf-peer:5959' } });
  try {
    const res = await fetch(`${origin}/install/release.tgz`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'http://shelf-peer:5959/releases/deckhand-release.tgz');
  } finally {
    federation.peerByMachine = realPeerByMachine;
    renameSync(parked, releasesDir);
  }
});
