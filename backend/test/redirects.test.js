'use strict';

// Tests for GET /api/net/redirects (lib/redirects-route.js). node:test, zero new deps.
//
// The handler is mounted on a throwaway express app on 127.0.0.1:0 — the real server
// file is never required (it would app.listen). Outbound requests go through the D7
// seam: createSafeFetcher({ classify, resolve }) allows ONLY the fixture's own port on
// 127.0.0.1; every other address goes through the real isPublicIp(). The resolver is
// fake, so nothing here touches real DNS or the internet.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const { isPublicIp, createSafeFetcher } = require('../lib/safe-fetch');
const { makeRedirectsHandler, MAX_INPUT } = require('../lib/redirects-route');

let F, P;                 // fixture port (allowed), "private" port (NOT allowed)
let srvF, srvP, srvApp, base;
const hitsP = { connections: 0 };
const hang = { open: 0, closed: 0 };

const classify = (ip, port) => (ip === '127.0.0.1' && port === F) || isPublicIp(ip);
const DNS = {
  'fixture.test':  [{ address: '127.0.0.1', family: 4 }],
  'internal.test': [{ address: '10.1.2.3', family: 4 }],
};
function fakeResolve(host, opts, cb) {
  const a = DNS[host];
  setImmediate(() => {
    if (!a) return cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    cb(null, opts && opts.all ? a.map(x => ({ ...x })) : a[0].address, a[0].family);
  });
}
const fetcher = createSafeFetcher({ classify, resolve: fakeResolve });

const main = makeRedirectsHandler({ fetcher });
const fast = makeRedirectsHandler({ fetcher, traceOpts: { hopTimeoutMs: 300 } });

function routeF(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  const redirect = (loc) => { res.writeHead(302, { Location: loc, Server: 'fixture' }); res.end(); };
  const m = /^\/chain\/(\d+)$/.exec(p);
  if (m) {
    const n = +m[1];
    if (n > 0) return redirect(`/chain/${n - 1}`);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<html><head><title>End</title></head><body>x</body></html>');
  }
  switch (p) {
    case '/to-private': return redirect(`http://127.0.0.1:${P}/secret`);
    case '/loop-a':     return redirect('/loop-b');
    case '/loop-b':     return redirect('/loop-a');
    case '/js':         return redirect('javascript:alert(1)');
    case '/slow':       return setTimeout(() => { res.writeHead(200); res.end('late'); }, 1500);
    case '/hang':
      hang.open++;
      res.on('close', () => hang.closed++);
      return;                                    // never answers
    default: res.writeHead(404); return res.end();
  }
}

function listen(srv) {
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
}

// One GET against the test app. Resolves { status, body } (body parsed when JSON).
function get(path, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + path, { agent: false, signal }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = text;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
  });
}
const q = u => '?url=' + encodeURIComponent(u);

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}

const logged = [];
const origConsole = {};

before(async () => {
  srvF = http.createServer(routeF);
  srvP = http.createServer((req, res) => { res.end('{"secret":true}'); });
  srvP.on('connection', () => hitsP.connections++);
  F = await listen(srvF);
  P = await listen(srvP);

  const app = express();
  app.get('/r', main);
  app.get('/r-fast', fast);
  srvApp = http.createServer(app);
  base = `http://127.0.0.1:${await listen(srvApp)}`;

  // No request URL may be logged: capture every console channel for the whole suite.
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    origConsole[k] = console[k];
    console[k] = (...a) => { logged.push(a.map(String).join(' ')); };
  }
});

after(async () => {
  for (const k of Object.keys(origConsole)) console[k] = origConsole[k];
  for (const s of [srvApp, srvF, srvP]) { s.closeAllConnections?.(); await new Promise(r => s.close(r)); }
});

// ── Contract ──────────────────────────────────────────────────

const KEYS = ['input', 'start', 'hops', 'final', 'stop', 'stopDetail', 'jsRedirectHint', 'totalMs'];
const HOP_KEYS = ['n', 'url', 'host', 'ip', 'status', 'kind', 'next', 'ms', 'server'];
const STOPS = ['final', 'max-hops', 'loop', 'blocked', 'non-web-scheme', 'timeout', 'error'];

function assertContract(b, stop) {
  assert.deepEqual(Object.keys(b), KEYS);
  assert.equal(typeof b.input, 'string');
  assert.equal(typeof b.start, 'string');
  assert.ok(Array.isArray(b.hops));
  assert.ok(STOPS.includes(b.stop));
  assert.equal(b.stop, stop);
  assert.equal(typeof b.totalMs, 'number');
  b.hops.forEach((h, i) => {
    assert.deepEqual(Object.keys(h), HOP_KEYS);
    assert.equal(h.n, i + 1);
    assert.equal(typeof h.url, 'string');
    assert.equal(typeof h.host, 'string');
    assert.equal(typeof h.status, 'number');
    assert.ok(['http', 'refresh-header', 'meta-refresh'].includes(h.kind));
    assert.equal(typeof h.next, 'string');
    assert.equal(typeof h.ms, 'number');
  });
  if (stop === 'final') {
    assert.equal(b.stopDetail, null);
    assert.deepEqual(Object.keys(b.final), ['url', 'status', 'contentType', 'title', 'ip', 'server']);
    assert.equal(typeof b.final.url, 'string');
    assert.equal(typeof b.final.status, 'number');
  } else {
    assert.equal(b.final, null);
    assert.equal(typeof b.stopDetail, 'string');
  }
  assert.ok(b.jsRedirectHint === null || typeof b.jsRedirectHint === 'object');
}

describe('contract per stop value', () => {
  test('final: 3-hop chain', async () => {
    const r = await get('/r' + q(`http://127.0.0.1:${F}/chain/3`));
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assertContract(r.body, 'final');
    assert.equal(r.body.hops.length, 3);
    assert.equal(r.body.final.title, 'End');
    assert.equal(r.body.final.url, `http://127.0.0.1:${F}/chain/0`);
  });

  test('input is the raw (trimmed) string; start is normalised', async () => {
    const r = await get('/r' + q(`   fixture.test:${F}/chain/0  `));
    assert.equal(r.status, 200);
    // Scheme-less input gets https://, and the fixture speaks plain http: a TLS error, not a hang.
    assertContract(r.body, 'error');
    assert.equal(r.body.input, `fixture.test:${F}/chain/0`);
    assert.equal(r.body.start, `https://fixture.test:${F}/chain/0`);
  });

  test('blocked: public URL → private redirect is a 200 with the hops, and the target is never contacted', async () => {
    const before = hitsP.connections;
    const r = await get('/r' + q(`http://127.0.0.1:${F}/to-private`));
    assert.equal(r.status, 200);
    assertContract(r.body, 'blocked');
    assert.equal(r.body.hops.length, 1);
    assert.equal(r.body.hops[0].next, `http://127.0.0.1:${P}/secret`);
    assert.match(r.body.stopDetail, /private \/ internal address, not fetched/);
    assert.equal(hitsP.connections, before);
  });

  test('loop', async () => {
    const r = await get('/r' + q(`http://127.0.0.1:${F}/loop-a`));
    assertContract(r.body, 'loop');
    assert.equal(r.body.hops.length, 2);
  });

  test('max-hops', async () => {
    const r = await get('/r' + q(`http://127.0.0.1:${F}/chain/15`));
    assertContract(r.body, 'max-hops');
    assert.equal(r.body.hops.length, 11);
  });

  test('non-web-scheme', async () => {
    const r = await get('/r' + q(`http://127.0.0.1:${F}/js`));
    assertContract(r.body, 'non-web-scheme');
    assert.equal(r.body.stopDetail, 'javascript:alert(1)');
  });

  test('timeout', async () => {
    const r = await get('/r-fast' + q(`http://127.0.0.1:${F}/slow`));
    assertContract(r.body, 'timeout');
  });

  test('error (connection refused on an allowed address)', async () => {
    // fixture.test resolves to 127.0.0.1; port F+0 is allowed, so use a closed allowed port:
    // close a throwaway server to get a port nobody holds, then allow it via a fresh fetcher.
    const tmp = http.createServer(); const port = await listen(tmp); await new Promise(r => tmp.close(r));
    const h = makeRedirectsHandler({ fetcher: createSafeFetcher({ classify: (ip, p) => (ip === '127.0.0.1' && p === port) || isPublicIp(ip), resolve: fakeResolve }) });
    const app = express(); app.get('/x', h);
    const s = http.createServer(app); const sp = await listen(s);
    try {
      const r = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${sp}/x` + q(`http://127.0.0.1:${port}/`), { agent: false }, (res) => {
          let t = ''; res.on('data', c => t += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(t) }));
        }).on('error', reject);
      });
      assert.equal(r.status, 200);
      assertContract(r.body, 'error');
      assert.equal(h.inFlight(), 0);
    } finally { s.closeAllConnections(); await new Promise(r => s.close(r)); }
  });
});

// ── Input errors ──────────────────────────────────────────────

describe('input errors', () => {
  for (const [name, path, re] of [
    ['missing',        '/r',                          /Missing url/],
    ['blank',          '/r?url=%20%20',               /Missing url/],
    ['repeated param', '/r?url=a.example&url=b.example', /one url/],
    ['ftp scheme',     '/r' + q('ftp://example.com/'), /Only http/],
    ['javascript',     '/r' + q('javascript:alert(1)'), /Only http/],
    ['no host',        '/r' + q('http://'),           /Invalid URL|Missing host/],
  ]) {
    test(`400 ${name}`, async () => {
      const r = await get(path);
      assert.equal(r.status, 400);
      assert.deepEqual(Object.keys(r.body), ['error']);
      assert.match(r.body.error, re);
    });
  }

  test(`input length: ${MAX_INPUT} accepted, ${MAX_INPUT + 1} → 400`, async () => {
    const head = `http://127.0.0.1:${F}/chain/0?p=`;
    const ok = head + 'a'.repeat(MAX_INPUT - head.length);
    assert.equal(ok.length, MAX_INPUT);
    const r1 = await get('/r' + q(ok));
    assert.equal(r1.status, 200);
    assert.equal(r1.body.stop, 'final');
    const r2 = await get('/r' + q(ok + 'a'));
    assert.equal(r2.status, 400);
    assert.match(r2.body.error, /too long/);
  });

  test('403 private literal input, nothing contacted', async () => {
    const before = hitsP.connections;
    const r = await get('/r' + q(`http://127.0.0.1:${P}/secret`));
    assert.equal(r.status, 403);
    assert.deepEqual(Object.keys(r.body), ['error', 'url']);
    assert.match(r.body.error, /Refusing to fetch a private/);
    assert.equal(hitsP.connections, before);
  });

  test('403 private literal spellings (decimal, mapped, metadata)', async () => {
    for (const u of ['http://2130706433/', 'http://[::ffff:7f00:1]/', 'http://169.254.169.254/latest/meta-data/']) {
      const r = await get('/r' + q(u));
      assert.equal(r.status, 403, u);
    }
  });

  test('403 hostname that resolves private', async () => {
    const r = await get('/r' + q('http://internal.test/'));
    assert.equal(r.status, 403);
    assert.match(r.body.error, /Host resolves to a private/);
  });
});

// ── In-flight cap + abort ─────────────────────────────────────

describe('global in-flight cap', () => {
  test('17th concurrent request → 503 busy; aborts release every slot and abort the trace', async () => {
    const acs = [];
    const pending = [];
    const startOpen = hang.open, startClosed = hang.closed;
    for (let i = 0; i < 16; i++) {
      const ac = new AbortController(); acs.push(ac);
      pending.push(get('/r' + q(`http://127.0.0.1:${F}/hang`), { signal: ac.signal }).catch(e => e));
    }
    await waitFor(() => main.inFlight() === 16 && hang.open - startOpen === 16);

    const r = await get('/r' + q(`http://127.0.0.1:${F}/chain/0`));
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: 'busy' });

    // Bad input is still answered as 400 while the server is full (no slot needed).
    assert.equal((await get('/r?url=')).status, 400);

    for (const ac of acs) ac.abort();
    const results = await Promise.all(pending);
    assert.ok(results.every(e => e instanceof Error));
    await waitFor(() => main.inFlight() === 0);
    // The client disconnect reached the outbound trace: every /hang socket was closed by us.
    await waitFor(() => hang.closed - startClosed === 16);

    // And the slots are really free.
    const r2 = await get('/r' + q(`http://127.0.0.1:${F}/chain/0`));
    assert.equal(r2.status, 200);
    assert.equal(main.inFlight(), 0);
  });

  test('slot count returns to 0 after blocked, error and 403 outcomes', async () => {
    await get('/r' + q(`http://127.0.0.1:${F}/to-private`));
    await get('/r' + q(`http://127.0.0.1:${P}/`));
    await get('/r' + q('http://nonexistent.test/'));
    await get('/r-fast' + q(`http://127.0.0.1:${F}/slow`));
    assert.equal(main.inFlight(), 0);
    assert.equal(fast.inFlight(), 0);
  });

  test('a small cap is honoured exactly', async () => {
    const h = makeRedirectsHandler({ fetcher, maxInFlight: 1 });
    const app = express(); app.get('/x', h);
    const s = http.createServer(app); const sp = await listen(s);
    const one = (u, signal) => new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${sp}/x` + q(u), { agent: false, signal }, (res) => {
        let t = ''; res.on('data', c => t += c); res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    try {
      const ac = new AbortController();
      const p1 = one(`http://127.0.0.1:${F}/hang`, ac.signal).catch(e => e);
      await waitFor(() => h.inFlight() === 1);
      assert.equal(await one(`http://127.0.0.1:${F}/chain/0`), 503);
      ac.abort(); await p1;
      await waitFor(() => h.inFlight() === 0);
      assert.equal(await one(`http://127.0.0.1:${F}/chain/0`), 200);
    } finally { s.closeAllConnections(); await new Promise(r => s.close(r)); }
  });
});

test('no request URL is ever logged', () => {
  assert.deepEqual(logged.filter(l => /127\.0\.0\.1|fixture\.test|internal\.test|chain|hang/.test(l)), []);
});
