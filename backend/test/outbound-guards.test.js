'use strict';

// The outbound routes' guards: the server's-own-address refusal in lib/safe-fetch.js,
// fetchFollow's abort, and lib/outbound-guards.js (in-flight caps, probe semaphore,
// per-destination counting, daily budget, client-close watch, the proxy `self` check).
//
// Fixtures bind 127.0.0.1 on port 0. "The server's own address" is played by a fixture
// port through the isSelf seam, so a broken guard would hit a local fixture, never a real
// host. resolvePublicTarget tests use public literals with a fake resolver: that function
// only resolves, it never connects.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { EventEmitter } = require('events');

const sf = require('../lib/safe-fetch');
const { isPublicIp, canonicalIp, makeSelfAddresses, createSafeFetcher } = sf;
const { makeInFlight, makeSemaphore, watchClientClose, makeDailyBudget, takeMany, proxySelfBase } = require('../lib/outbound-guards');
const { makeRateLimiter } = require('../lib/rate-limit');
const { proxify, rewriteHtml } = require('../lib/proxy-rewrite');

// ── Own-address set ───────────────────────────────────────────

describe('server own addresses', () => {
  test('canonicalIp unwraps IPv4-mapped IPv6 and normalises IPv6 spelling', () => {
    assert.equal(canonicalIp('93.184.215.14'), '93.184.215.14');
    assert.equal(canonicalIp('::ffff:93.184.215.14'), '93.184.215.14');
    assert.equal(canonicalIp('[::FFFF:5db8:d70e]'), '93.184.215.14');
    assert.equal(canonicalIp('2606:4700:4700::1111'), canonicalIp('2606:4700:4700:0:0:0:0:1111'));
    assert.equal(canonicalIp('2606:4700:4700::1111'), canonicalIp('2606:4700:4700:0000::1111'));
    assert.equal(canonicalIp('example.com'), null);
  });

  test('the set holds public interface addresses + SELF_IPS, never loopback/private', () => {
    const self = makeSelfAddresses({
      interfaces: () => ({
        lo:   [{ address: '127.0.0.1' }, { address: '::1' }],
        eth0: [{ address: '93.184.215.14' }, { address: '10.1.2.3' }, { address: '2606:4700:4700::1111' }],
      }),
      extra: ' 1.1.1.1 , ,not-an-ip, 192.168.1.1',
      refreshMs: 0,
    });
    assert.ok(self.has('93.184.215.14'));
    assert.ok(self.has('::ffff:93.184.215.14'));
    assert.ok(self.has('2606:4700:4700:0:0:0:0:1111'));
    assert.ok(self.has('1.1.1.1'));                       // SELF_IPS (1:1 NAT)
    assert.ok(!self.has('127.0.0.1'));                    // loopback: isPublicIp's job
    assert.ok(!self.has('10.1.2.3'));
    assert.ok(!self.has('192.168.1.1'));
    assert.ok(!self.has('8.8.8.8'));
  });

  test('a failed interface read keeps the previous set', () => {
    let fail = false;
    const self = makeSelfAddresses({
      interfaces: () => { if (fail) throw new Error('boom'); return { eth0: [{ address: '93.184.215.14' }] }; },
      extra: '', refreshMs: 0,
    });
    fail = true;
    self.refresh();
    assert.ok(self.has('93.184.215.14'));
  });

  test('resolvePublicTarget refuses an own address: literal, mapped, and via DNS', async () => {
    const self = makeSelfAddresses({ interfaces: () => ({ eth0: [{ address: '93.184.215.14' }] }), extra: '', refreshMs: 0 });
    const DNS = {
      'own.test':   [{ address: '93.184.215.14', family: 4 }],
      'mixed.test': [{ address: '93.184.215.14', family: 4 }, { address: '1.1.1.1', family: 4 }],
    };
    const resolve = (h, o, cb) => setImmediate(() => DNS[h] ? cb(null, DNS[h]) : cb(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })));
    const fx = createSafeFetcher({ isSelf: ip => self.has(ip), resolve });
    await assert.rejects(fx.resolvePublicTarget('93.184.215.14'), { code: 'ERR_SSRF_BLOCKED', message: 'Target is a private or reserved address' });
    await assert.rejects(fx.resolvePublicTarget('::ffff:93.184.215.14'), { code: 'ERR_SSRF_BLOCKED' });
    await assert.rejects(fx.resolvePublicTarget('own.test'), { code: 'ERR_SSRF_BLOCKED', message: 'Host resolves only to private or reserved addresses' });
    assert.equal(await fx.resolvePublicTarget('mixed.test'), '1.1.1.1');
    assert.equal(await fx.resolvePublicTarget('1.1.1.1'), '1.1.1.1');
  });
});

// ── Own-address refusal over HTTP (fixture plays the own address) ──

describe('safe-fetch refuses the own address over HTTP', () => {
  let A, S, srvA, srvS;
  const hitsS = { connections: 0 };
  const DNS = {};
  const resolve = (h, o, cb) => setImmediate(() => DNS[h] ? cb(null, DNS[h]) : cb(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })));
  let fx;

  before(async () => {
    srvS = http.createServer((req, res) => res.end('secret'));
    srvS.on('connection', () => { hitsS.connections++; });
    await new Promise(r => srvS.listen(0, '127.0.0.1', r));
    S = srvS.address().port;
    srvA = http.createServer((req, res) => {
      if (req.url === '/to-self') { res.writeHead(302, { Location: `http://127.0.0.1:${S}/` }); return res.end(); }
      if (req.url === '/to-self-name') { res.writeHead(302, { Location: `http://own.test:${S}/` }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok');
    });
    await new Promise(r => srvA.listen(0, '127.0.0.1', r));
    A = srvA.address().port;
    DNS['own.test'] = [{ address: '127.0.0.1', family: 4 }];
    DNS['pub.test'] = [{ address: '127.0.0.1', family: 4 }];
    // Both fixture ports pass classify; isSelf names S as this server's own address.
    fx = createSafeFetcher({
      classify: (ip, port) => (ip === '127.0.0.1' && (port === A || port === S)) || isPublicIp(ip),
      isSelf: (ip, port) => canonicalIp(ip) === '127.0.0.1' && port === S,
      resolve,
    });
  });
  after(() => { srvA.close(); srvS.close(); });

  test('the fixture seam itself works (control)', async () => {
    const r = await fx.safeRequest(`http://127.0.0.1:${A}/`);
    assert.equal(r.status, 200);
  });

  test('literal URL → ERR_SSRF_BLOCKED, no connection', async () => {
    await assert.rejects(fx.safeRequest(`http://127.0.0.1:${S}/`), { code: 'ERR_SSRF_BLOCKED', message: 'Refusing to connect to a private / internal address' });
    await assert.rejects(fx.fetchFollow(`http://127.0.0.1:${S}/`), { code: 'ERR_SSRF_BLOCKED' });
    assert.equal(hitsS.connections, 0);
  });

  test('hostname resolving to it → ERR_SSRF_BLOCKED, no connection', async () => {
    await assert.rejects(fx.safeRequest(`http://own.test:${S}/`), { code: 'ERR_SSRF_BLOCKED' });
    assert.equal(hitsS.connections, 0);
  });

  test('redirect to it → blocked (fetchFollow and traceRedirects), no connection', async () => {
    await assert.rejects(fx.fetchFollow(`http://pub.test:${A}/to-self`), e => e.code === 'ERR_SSRF_BLOCKED' && e.redirects === 1);
    await assert.rejects(fx.fetchFollow(`http://pub.test:${A}/to-self-name`), e => e.code === 'ERR_SSRF_BLOCKED' && e.redirects === 1);
    const t = await fx.traceRedirects(`http://pub.test:${A}/to-self`);
    assert.equal(t.stop, 'blocked');
    assert.equal(hitsS.connections, 0);
  });

  test('certInfo never connects to it', async () => {
    assert.equal(await fx.certInfo(`https://own.test:${S}/`, '127.0.0.1'), null);
    assert.equal(hitsS.connections, 0);
  });
});

// ── fetchFollow abort ─────────────────────────────────────────

describe('fetchFollow honours an AbortSignal', () => {
  let P, srv;
  const closed = [];
  let connections = 0;
  before(async () => {
    srv = http.createServer((req, res) => {
      req.socket.on('close', () => closed.push(req.url));
      if (req.url === '/hop') { res.writeHead(302, { Location: '/hang' }); return res.end(); }
      // /hang: headers never sent
    });
    srv.on('connection', () => { connections++; });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    P = srv.address().port;
  });
  after(() => { srv.closeAllConnections?.(); srv.close(); });

  const fx = () => createSafeFetcher({ classify: (ip, port) => (ip === '127.0.0.1' && port === P) || isPublicIp(ip) });

  test('abort while waiting → ERR_ABORTED quickly, upstream socket closed', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(fx().fetchFollow(`http://127.0.0.1:${P}/hang`, { signal: ac.signal, totalTimeoutMs: 10_000 }), { code: 'ERR_ABORTED' });
    assert.ok(Date.now() - t0 < 3000);
    await new Promise(r => setTimeout(r, 100));
    assert.ok(closed.includes('/hang'));
  });

  test('abort after a redirect hop → ERR_ABORTED', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(fx().fetchFollow(`http://127.0.0.1:${P}/hop`, { signal: ac.signal, totalTimeoutMs: 10_000 }), { code: 'ERR_ABORTED' });
  });

  test('an already-aborted signal never connects', async () => {
    await new Promise(r => setTimeout(r, 100));
    const before = connections;
    await assert.rejects(fx().fetchFollow(`http://127.0.0.1:${P}/hang`, { signal: AbortSignal.abort() }), { code: 'ERR_ABORTED' });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(connections, before);
  });
});

// ── lib/outbound-guards.js ────────────────────────────────────

describe('in-flight counters', () => {
  test('makeInFlight: caps, idempotent release', () => {
    const f = makeInFlight(2);
    const a = f.tryAcquire(), b = f.tryAcquire();
    assert.ok(a && b);
    assert.equal(f.tryAcquire(), null);
    a(); a();                                  // double release counts once
    assert.equal(f.count(), 1);
    const c = f.tryAcquire();
    assert.ok(c);
    assert.equal(f.tryAcquire(), null);
    b(); c();
    assert.equal(f.count(), 0);
  });

  test('makeSemaphore: FIFO waiters, canQueue, release hands the slot on', async () => {
    const s = makeSemaphore({ max: 2, maxQueue: 3 });
    const r1 = await s.acquire(), r2 = await s.acquire();
    assert.equal(s.active(), 2);
    assert.ok(s.canQueue(3));
    assert.ok(!s.canQueue(4));
    const order = [];
    const p3 = s.acquire().then(r => { order.push(3); return r; });
    const p4 = s.acquire().then(r => { order.push(4); return r; });
    assert.equal(s.queued(), 2);
    assert.ok(s.canQueue(1));
    assert.ok(!s.canQueue(2));
    r1(); r1();
    const r3 = await p3;
    assert.deepEqual(order, [3]);
    assert.equal(s.active(), 2);
    r2();
    const r4 = await p4;
    assert.deepEqual(order, [3, 4]);
    r3(); r4();
    assert.equal(s.active(), 0);
    assert.equal(s.queued(), 0);
  });

  test('a batch of 60 always fits an idle 256/1024 semaphore; a flood is refused up front', () => {
    const s = makeSemaphore({ max: 256, maxQueue: 1024 });
    assert.ok(s.canQueue(60));
    assert.ok(s.canQueue(256 + 1024));
    assert.ok(!s.canQueue(256 + 1025));
  });

  test('makeDailyBudget resets at the UTC day boundary', () => {
    let now = Date.parse('2026-11-12T23:59:00Z');
    const b = makeDailyBudget(2, () => now);
    assert.ok(b.take()); assert.ok(b.take()); assert.ok(!b.take());
    now = Date.parse('2026-11-13T00:00:01Z');
    assert.equal(b.used(), 0);
    assert.ok(b.take());
  });
});

describe('per-destination probe limiter (takeMany over makeRateLimiter)', () => {
  test('counts each port; a refused batch does not keep counting', () => {
    const lim = makeRateLimiter({ windowMs: 600_000, max: 120 });
    assert.ok(takeMany(lim, '93.184.215.14', 60));
    assert.ok(takeMany(lim, '93.184.215.14', 60));
    assert.ok(!takeMany(lim, '93.184.215.14', 1));
    assert.equal(lim.map.get('93.184.215.14').count, 120);
    assert.ok(takeMany(lim, '1.1.1.1', 60));     // another destination is unaffected
  });

  test('a batch that would cross the limit is refused', () => {
    const lim = makeRateLimiter({ windowMs: 600_000, max: 100 });
    assert.ok(takeMany(lim, 'x', 60));
    assert.ok(!takeMany(lim, 'x', 60));
  });
});

describe('watchClientClose', () => {
  test('aborts only when closed before the response ended', () => {
    const res = new EventEmitter(); res.writableEnded = false;
    const g = watchClientClose(res);
    res.emit('close');
    assert.ok(g.closed());
    assert.ok(g.signal.aborted);

    const res2 = new EventEmitter(); res2.writableEnded = true;
    const g2 = watchClientClose(res2);
    res2.emit('close');
    assert.ok(!g2.closed());
    g2.dispose();
    assert.equal(res2.listenerCount('close'), 0);
  });
});

// ── /api/net/proxy `self` ─────────────────────────────────────

describe('proxySelfBase', () => {
  const ORIGINS = ['http://localhost:8080', 'https://tools.grin.money'];
  const req = (self, host = '127.0.0.1:3001', proto) => ({
    query: self === undefined ? {} : { self },
    headers: { host, ...(proto ? { 'x-forwarded-proto': proto } : {}) },
    protocol: 'http',
    get: h => (h === 'host' ? host : undefined),
  });
  const FALLBACK = 'http://127.0.0.1:3001/api/net/proxy';

  test('accepts what tools/web-proxy sends (a CORS origin + /api/net/proxy)', () => {
    assert.equal(proxySelfBase(req('https://tools.grin.money/tools-api/api/net/proxy'), ORIGINS),
      'https://tools.grin.money/tools-api/api/net/proxy');
  });
  test('accepts this request\'s own host (local dev: page on :8080, API on :3001)', () => {
    assert.equal(proxySelfBase(req('http://localhost:3001/api/net/proxy', 'localhost:3001'), ORIGINS),
      'http://localhost:3001/api/net/proxy');
  });
  test('falls back for any other host, shape or character', () => {
    for (const bad of [
      'https://evil.example/api/net/proxy',
      'https://tools.grin.money.evil.example/api/net/proxy',
      'https://tools.grin.money/api/net/proxy?x=1',
      'https://tools.grin.money/api/net/proxy#x',
      'https://user@tools.grin.money/api/net/proxy',
      'https://tools.grin.money/other',
      'https://tools.grin.money/a"onmouseover="x/api/net/proxy',
      "https://tools.grin.money/a'/api/net/proxy",
      'https://tools.grin.money/<b>/api/net/proxy',
      'https://tools.grin.money/a b/api/net/proxy',
      'javascript:alert(1)//api/net/proxy',
      'not a url',
      '',
    ]) assert.equal(proxySelfBase(req(bad), ORIGINS), FALLBACK, bad);
    assert.equal(proxySelfBase(req(['https://tools.grin.money/api/net/proxy']), ORIGINS), FALLBACK);
    assert.equal(proxySelfBase(req(undefined), ORIGINS), FALLBACK);
  });
  test('the fallback keeps x-forwarded-proto as before', () => {
    assert.equal(proxySelfBase(req(undefined, 'tools.grin.money', 'https'), ORIGINS), 'https://tools.grin.money/api/net/proxy');
  });
});

describe('proxy-rewrite keeps selfBase attribute-safe', () => {
  test('a hostile base cannot close the attribute or open markup', () => {
    const evil = 'http://h"><script>x()</script>\'/api/net/proxy';
    const out = rewriteHtml('<a href="/p">x</a><img src=\'/i.png\'>', 'https://site.example/', evil, false);
    assert.ok(!out.includes('<script>'));
    assert.ok(!/href="[^"]*"[^ >]/.test(out.replace(/<div[\s\S]*?<\/div>/, '')));
    assert.ok(!/src='[^']*'[^ >]/.test(out));
  });
  test('an ordinary base is unchanged', () => {
    const base = 'https://tools.grin.money/tools-api/api/net/proxy';
    assert.equal(proxify('https://a.example/x?y=1', base),
      `${base}?url=${encodeURIComponent('https://a.example/x?y=1')}&self=${encodeURIComponent(base)}`);
  });
});
