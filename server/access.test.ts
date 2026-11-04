import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { fromAnotherSite, isApiPath } from './access.js';

test('isApiPath claims the API prefix in any case, and nothing else', () => {
  for (const p of ['/api/sessions', '/API/sessions', '/Api/sessions', '/aPi/hook', '/api/']) {
    assert.equal(isApiPath(p), true, p);
  }
  for (const p of ['/', '/apix/sessions', '/releases/api/x', '/ws/control', '/apiary/x', '/api']) {
    assert.equal(isApiPath(p), false, p);
  }
});

// What index.ts hands fromAnotherSite: this hub's and its peers' machine names.
const fleetHost = (host: string) =>
  ['desktop-hub', 'laptop-hub'].some((name) => host === name || host.startsWith(`${name}.`));

test('cross-site: callers that are not browsers send no Origin and no Sec-Fetch headers, and pass', () => {
  // the iOS app, curl, the MCP server, hub-to-hub federation, the Even bridge and glasses
  assert.equal(fromAnotherSite({}, fleetHost), false);
  assert.equal(fromAnotherSite({ authorization: 'Bearer x', 'content-type': 'application/json' }, fleetHost), false);
});

test("cross-site: the hub's own origins pass, whatever the port", () => {
  for (const origin of [
    'http://localhost:5959',
    'http://localhost:5173', // the Vite dev server proxying to the hub
    'http://127.0.0.1:5959',
    'http://[::1]:5959',
    'http://100.70.1.2:5959', // a tailnet address: the fleet's trust boundary
    'http://desktop-hub:5959', // this hub by machine name
    'http://laptop-hub:5960', // a peer's dashboard: dashboards forward to peers
    'http://desktop-hub.tail1234.ts.net:5959', // MagicDNS fqdn
  ]) {
    assert.equal(fromAnotherSite({ origin }, fleetHost), false, origin);
    // a fleet origin on another hub is cross-site to the browser; the Origin decides
    assert.equal(fromAnotherSite({ origin, 'sec-fetch-site': 'cross-site' }, fleetHost), false, origin);
  }
});

test('cross-site: a foreign site is refused, by Origin or by Sec-Fetch-Site', () => {
  for (const origin of ['https://evil.example', 'http://evil.example:5959', 'null', 'not a url', 'http://localhost.evil.example']) {
    assert.equal(fromAnotherSite({ origin }, fleetHost), true, origin);
  }
  assert.equal(fromAnotherSite({ 'sec-fetch-site': 'cross-site' }, fleetHost), true, 'Sec-Fetch alone');
  assert.equal(fromAnotherSite({ 'sec-fetch-site': 'same-origin' }, fleetHost), false);
  assert.equal(fromAnotherSite({ 'sec-fetch-site': 'none' }, fleetHost), false, 'typed into the address bar');
});

/** The arrangement index.ts uses: case-sensitive routing under a deny-by-default path gate. */
async function rig() {
  const app = express();
  app.set('case sensitive routing', true);
  app.use((req, res, next) => {
    if (req.method === 'POST' && fromAnotherSite(req.headers, fleetHost)) {
      return res.status(403).json({ error: 'cross-site browser requests cannot change the hub' });
    }
    next();
  });
  // the shape of the agent gate: exact lowercase paths are allowed through, the rest denied
  app.use((req, res, next) => {
    if (!isApiPath(req.path)) return next();
    if (req.path === '/api/open') return next();
    res.status(403).json({ error: 'denied by the gate' });
  });
  app.get('/api/open', (_req, res) => res.json({ ok: true }));
  app.post('/api/open', (_req, res) => res.json({ ok: true }));
  app.get('/plain', (_req, res) => res.json({ ok: true })); // outside the gate: shows routing itself is case-sensitive
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { call: (path: string, init?: RequestInit) => fetch(`${base}${path}`, init), close: () => server.close() };
}

test('a mixed-case API path matches no route and cannot slip past the gate', async () => {
  const { call, close } = await rig();
  try {
    assert.equal((await call('/api/open')).status, 200, 'the real path works');
    for (const p of ['/API/open', '/Api/open', '/api/Open', '/API/OPEN']) {
      assert.equal((await call(p)).status, 403, p);
    }
    assert.equal((await call('/plain')).status, 200);
    assert.equal((await call('/Plain')).status, 404, 'routing itself is case-sensitive');
  } finally {
    close();
  }
});

test('state-changing requests: browser callers are gated by their origin, others untouched', async () => {
  const { call, close } = await rig();
  try {
    assert.equal((await call('/api/open', { method: 'POST' })).status, 200, 'no Origin: curl, apps, hubs');
    assert.equal((await call('/api/open', { method: 'POST', headers: { origin: 'http://desktop-hub:5959' } })).status, 200, 'own dashboard');
    assert.equal((await call('/api/open', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403, 'foreign site');
    assert.equal((await call('/api/open', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await call('/api/open', { headers: { origin: 'https://evil.example' } })).status, 200, 'reads stay open');
  } finally {
    close();
  }
});
