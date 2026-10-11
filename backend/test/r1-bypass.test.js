'use strict';

// R1 — cold review of url-expander P1 + P2: every attempt to make the server talk to a
// non-public address, or hang / run out of memory, written as a test.
//
// `T` is the INTERNAL target: a 127.0.0.1 listener that NO policy allows. Every bypass
// test asserts it saw ZERO connections, so a test cannot pass by the request merely
// failing for some other reason after the connection was made.
// `P` is the "public" fixture, allowed through the D7 seam only on its own port.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const zlib = require('zlib');

const sf = require('../lib/safe-fetch');
const { isPublicIp, normalizeUserUrl, createSafeFetcher, findMetaRefresh, findTitle, findJsRedirect } = sf;

let T, P, R;                       // internal target, public fixture, a closed port
let srvT, srvP, srvRaw, RAW;
const rawSockets = new Set();
const hitsT = { connections: 0 };
const churnHits = { n: 0 };

const DNS = {
  'public.test':     [{ address: '127.0.0.1', family: 4 }],   // allowed ONLY on port P
  'refused.test':    [{ address: '127.0.0.1', family: 4 }],   // allowed ONLY on port R (closed)
  'localhost':       [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }],
  'mixed.test':      [{ address: '93.184.215.14', family: 4 }, { address: '127.0.0.1', family: 4 }],
  'mixed-rev.test':  [{ address: '127.0.0.1', family: 4 }, { address: '93.184.215.14', family: 4 }],
  'v6priv.test':     [{ address: 'fd00::1', family: 6 }],
  'v6pub.test':      [{ address: '2606:4700:4700::1111', family: 6 }],
  'dual.test':       [{ address: '93.184.215.14', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }],
  'mapped.test':     [{ address: '::ffff:127.0.0.1', family: 6 }],
  'mappedhex.test':  [{ address: '::ffff:7f00:1', family: 6 }],
  'nat64.test':      [{ address: '64:ff9b::7f00:1', family: 6 }],
  'sixto4.test':     [{ address: '2002:7f00:1::1', family: 6 }],
  'teredo.test':     [{ address: '2001:0:4136:e378:8000:63bf:80ff:fffe', family: 6 }],
  'zero.test':       [{ address: '0.0.0.0', family: 4 }],
  'zone.test':       [{ address: 'fe80::1%1', family: 6 }],
  'meta.test':       [{ address: '169.254.169.254', family: 4 }],
};
const resolveCalls = [];
function fakeResolve(host, opts, cb) {
  resolveCalls.push(host);
  const a = DNS[host];
  setImmediate(() => {
    if (!a) return cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    cb(null, opts && opts.all ? a.map(x => ({ ...x })) : a[0].address, a[0].family);
  });
}
const classify = (ip, port) => (ip === '127.0.0.1' && (port === P || port === R)) || isPublicIp(ip);
const fx = createSafeFetcher({ classify, resolve: fakeResolve });

const html = s => `<!doctype html><html><head>${s}</head><body>x</body></html>`;
const BIG = 64 * 1024 * 1024;
let bombBr, bombDeflate, bombGz;

function routeP(req, res) {
  const u = new URL(req.url, 'http://x');
  const to = u.searchParams.get('to');
  switch (u.pathname) {
    case '/ok':      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html('<title>ok</title>'));
    case '/loc':     res.writeHead(302, { Location: to }); return res.end();
    case '/refresh': res.writeHead(200, { 'Content-Type': 'text/plain', Refresh: `0; url=${to}` }); return res.end('x');
    case '/meta':    res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html(`<meta http-equiv="refresh" content="0;url=${to}">`));
    case '/churn': {
      churnHits.n++;
      const n = Number(u.searchParams.get('n') || 0);
      res.writeHead(302, { Location: `/churn?n=${n + 1}&r=${Math.random()}` }); return res.end();
    }
    case '/hostile-meta': {
      // A FINAL page of 64 KiB of unclosed <meta and no '>' anywhere: the quadratic case
      // for the sniff (a '>' after the junk would close it in one match, so it must have none).
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<title>t</title>' + '<meta'.repeat(13100));
    }
    case '/bomb-br':      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'br' }); return res.end(bombBr);
    case '/bomb-deflate': res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'deflate' }); return res.end(bombDeflate);
    case '/bomb-gz':      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' }); return res.end(bombGz);
    default: res.writeHead(404); return res.end();
  }
}

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function close(server) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise(r => server.close(() => r()));
}
async function code(p) { try { await p; return 'resolved'; } catch (e) { return e.code; } }
function tcpSockets() { return process.getActiveResourcesInfo().filter(x => x === 'TCPSocketWrap').length; }
async function settleSockets(baseline, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end && tcpSockets() > baseline) await new Promise(r => setTimeout(r, 25));
  return tcpSockets();
}

before(async () => {
  bombBr = zlib.brotliCompressSync(Buffer.alloc(BIG), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 } });
  bombDeflate = zlib.deflateSync(Buffer.alloc(BIG), { level: 9 });
  bombGz = zlib.gzipSync(Buffer.alloc(BIG), { level: 9 });
  srvT = http.createServer((q, s) => s.end('{"internal":true}'));
  srvT.on('connection', () => { hitsT.connections++; });
  T = await listen(srvT);
  srvP = http.createServer(routeP);
  P = await listen(srvP);
  // A closed port: bind, read the number, close.
  const tmp = net.createServer(); R = await listen(tmp); await close(tmp);
  // Raw TCP: status line, then one header line every 200 ms, forever (slow-drip HEADERS).
  srvRaw = net.createServer(sock => {
    rawSockets.add(sock); sock.on('close', () => rawSockets.delete(sock));
    sock.on('error', () => {});
    sock.once('data', () => {
      sock.write('HTTP/1.1 200 OK\r\n');
      let i = 0;
      const t = setInterval(() => sock.write(`X-Drip-${i++}: y\r\n`), 200);
      sock.on('close', () => clearInterval(t));
    });
  });
  RAW = await listen(srvRaw);
});
after(async () => { for (const s of rawSockets) s.destroy(); await close(srvT); await close(srvP); await close(srvRaw); });

// ── (b) IP literal forms, through the REAL default policy ─────

describe('R1 (b) — every literal spelling of an internal address is refused before connecting', () => {
  const spellings = () => [
    `http://2130706433:${T}/`, `http://0x7f000001:${T}/`, `http://0x7f.1:${T}/`,
    `http://017700000001:${T}/`, `http://0177.0.0.1:${T}/`, `http://127.1:${T}/`, `http://127.0.1:${T}/`,
    `http://127.0.0.1.:${T}/`, `HTTP://127.0.0.1:${T}/`, `http:\\\\127.0.0.1:${T}\\x`, `http:/127.0.0.1:${T}/`,
    `127.0.0.1:${T}`, `//127.0.0.1:${T}/`,
    `http://[::1]:${T}/`, `http://[::ffff:127.0.0.1]:${T}/`, `http://[::ffff:7f00:1]:${T}/`,
    `http://[::FFFF:7F00:0001]:${T}/`, `http://[0:0:0:0:0:ffff:127.0.0.1]:${T}/`,
    `http://[64:ff9b::7f00:1]:${T}/`, `http://[64:ff9b::127.0.0.1]:${T}/`, `http://[2002:7f00:1::1]:${T}/`,
    `http://[2001:0:4136:e378:8000:63bf:80ff:fffe]:${T}/`, `http://[::]:${T}/`, `http://[::127.0.0.1]:${T}/`,
    `http://0.0.0.0:${T}/`, `http://0:${T}/`, `http://169.254.169.254/`, `http://[fd00::1]/`, `http://[fe80::1]/`,
  ];
  test('safeRequest (default fetcher): ERR_SSRF_BLOCKED, zero connections, no DNS', async () => {
    const before = hitsT.connections;
    for (const s of spellings()) {
      const { url } = normalizeUserUrl(s);
      assert.equal(await code(sf.safeRequest(url, { timeoutMs: 2000 })), 'ERR_SSRF_BLOCKED', s);
    }
    assert.equal(hitsT.connections - before, 0);
  });
  test('traceRedirects + fetchFollow (default fetcher) refuse the same set', async () => {
    const before = hitsT.connections;
    for (const s of spellings()) {
      const { url } = normalizeUserUrl(s);
      const t = await sf.traceRedirects(url, { hopTimeoutMs: 2000 });
      assert.equal(t.stop, 'blocked', s);
      assert.equal(await code(sf.fetchFollow(url, { totalTimeoutMs: 2000 })), 'ERR_SSRF_BLOCKED', s);
    }
    assert.equal(hitsT.connections - before, 0);
  });
  test('a zone id never parses as a URL host', () => {
    for (const s of ['http://[fe80::1%25eth0]/', 'http://[fe80::1%eth0]/', 'http://[::1%251]/']) {
      assert.throws(() => normalizeUserUrl(s), { code: 'ERR_BAD_URL' }, s);
    }
    assert.equal(isPublicIp('fe80::1%eth0'), false);
    assert.equal(isPublicIp('2606:4700::1%eth0'), false);
  });
  test('localhost, LOCALHOST and localhost. through the REAL resolver: refused, zero connections', async () => {
    const before = hitsT.connections;
    for (const h of ['localhost', 'LOCALHOST', 'localhost.']) {
      const c = await code(sf.safeRequest(`http://${h}:${T}/`, { timeoutMs: 3000 }));
      // Windows / some resolvers fail `localhost.` outright; either way nothing connects.
      assert.ok(c === 'ERR_SSRF_BLOCKED' || c === 'ENOTFOUND', `${h} → ${c}`);
    }
    assert.equal(hitsT.connections - before, 0);
  });
});

// ── (c) DNS answers ────────────────────────────────────────────

describe('R1 (c) — DNS answers', () => {
  test('every private-answer shape is refused at lookup, zero connections', async () => {
    const before = hitsT.connections;
    for (const h of ['localhost', 'mixed.test', 'mixed-rev.test', 'v6priv.test', 'mapped.test', 'mappedhex.test',
      'nat64.test', 'sixto4.test', 'teredo.test', 'zero.test', 'zone.test', 'meta.test']) {
      assert.equal(await code(fx.safeRequest(`http://${h}:${T}/`, { timeoutMs: 2000 })), 'ERR_SSRF_BLOCKED', h);
    }
    assert.equal(hitsT.connections - before, 0);
  });
  test('IPv6-only and dual-stack PUBLIC answers pass the guard in both callback shapes', async () => {
    for (const h of ['v6pub.test', 'dual.test']) {
      const all = await new Promise((res, rej) => fx.guardedLookup(h, { all: true }, (e, a) => e ? rej(e) : res(a)));
      assert.deepEqual(all.map(a => a.address), DNS[h].map(a => a.address));
      const one = await new Promise((res, rej) => fx.guardedLookup(h, {}, (e, a, f) => e ? rej(e) : res([a, f])));
      assert.deepEqual(one, [DNS[h][0].address, DNS[h][0].family]);
    }
  });
  test('rebinding: ONE resolution per request, and each request checks its own answer', async () => {
    let calls = 0;
    const rebind = (h, o, cb) => {
      calls++;
      const a = calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.1', family: 4 }];
      setImmediate(() => cb(null, a));
    };
    const rf = createSafeFetcher({ classify, resolve: rebind });
    const r = await rf.safeRequest(`http://rebind.test:${P}/ok`);
    assert.equal(r.status, 200);
    assert.equal(calls, 1, 'the connect used the answer that was checked — no second lookup');
    assert.equal(await code(rf.safeRequest(`http://rebind.test:${P}/ok`)), 'ERR_SSRF_BLOCKED');
    assert.equal(calls, 2);
  });
  test('the uptime flow (trace → certInfo) resolves once; certInfo never resolves', async () => {
    resolveCalls.length = 0;
    const t = await fx.traceRedirects(`http://public.test:${P}/ok`);
    assert.equal(t.stop, 'final');
    assert.deepEqual(resolveCalls, ['public.test']);
    await fx.certInfo(`https://public.test:${P}/`, t.final.ip, { timeoutMs: 1500 });
    assert.deepEqual(resolveCalls, ['public.test'], 'certInfo must use the pinned IP');
  });
});

// ── (d) Redirect targets ───────────────────────────────────────

describe('R1 (d) — Location / Refresh / meta-refresh variants pointing inward', () => {
  const inward = () => [
    `//127.0.0.1:${T}/x`, `\\\\127.0.0.1:${T}\\x`, `/\\127.0.0.1:${T}/x`, `\\/127.0.0.1:${T}/x`,
    `http://user@127.0.0.1:${T}/`, `http://user:pw@127.0.0.1:${T}/`, `https://127.0.0.1:${T}/`,
    `http://2130706433:${T}/`, `http://0x7f.1:${T}/`, `http://[::ffff:7f00:1]:${T}/`, `http://127.0.0.1.:${T}/`,
    `http://localhost:${T}/`, `http://mapped.test:${T}/`, `http://mixed.test:${T}/`,
    `http://169.254.169.254/latest/meta-data/`, `HtTp://127.0.0.1:${T}/`, ` http://127.0.0.1:${T}/`,
  ];
  const via = to => `http://public.test:${P}/loc?to=${encodeURIComponent(to)}`;
  test('traceRedirects: Location → blocked; fetchFollow: ERR_SSRF_BLOCKED; zero connections', async () => {
    const before = hitsT.connections;
    for (const to of inward()) {
      const t = await fx.traceRedirects(via(to), { hopTimeoutMs: 2000 });
      assert.equal(t.stop, 'blocked', to);
      assert.equal(t.final, null);
      assert.equal(await code(fx.fetchFollow(via(to), { totalTimeoutMs: 2000 })), 'ERR_SSRF_BLOCKED', to);
    }
    assert.equal(hitsT.connections - before, 0);
  });
  test('Refresh header and meta refresh pointing inward → blocked, zero connections', async () => {
    const before = hitsT.connections;
    for (const to of [`http://127.0.0.1:${T}/`, `//[::1]:${T}/`, `http://localhost:${T}/`]) {
      for (const kind of ['refresh', 'meta']) {
        const t = await fx.traceRedirects(`http://public.test:${P}/${kind}?to=${encodeURIComponent(to)}`);
        assert.equal(t.stop, 'blocked', `${kind} ${to}`);
      }
    }
    assert.equal(hitsT.connections - before, 0);
  });
  test('userinfo that LOOKS like an internal host is not the host', async () => {
    const before = hitsT.connections;
    const t = await fx.traceRedirects(via(`http://127.0.0.1:${T}@public.test:${P}/ok`));
    assert.equal(t.stop, 'final');
    assert.equal(t.final.url, `http://public.test:${P}/ok`);
    assert.equal(hitsT.connections - before, 0);
  });
  test('non-web schemes are never fetched (trace reports; fetchFollow refuses)', async () => {
    const before = hitsT.connections;
    for (const to of ['file:///etc/passwd', `gopher://127.0.0.1:${T}/_x`, `ftp://127.0.0.1:${T}/`,
      `ws://127.0.0.1:${T}/`, 'data:text/html,<b>x</b>', `dict://127.0.0.1:${T}/`]) {
      const t = await fx.traceRedirects(via(to));
      assert.equal(t.stop, 'non-web-scheme', to);
      assert.equal(await code(fx.fetchFollow(via(to))), 'ERR_UNSUPPORTED_PROTOCOL', to);
    }
    assert.equal(hitsT.connections - before, 0);
  });
  test('a 30-hop chain stops at max-hops; a query-churning loop terminates the same way', async () => {
    const t = await fx.traceRedirects(`http://public.test:${P}/churn?n=0`);
    assert.equal(t.stop, 'max-hops');
    assert.equal(t.hops.length, 11);
    churnHits.n = 0;
    assert.equal(await code(fx.fetchFollow(`http://public.test:${P}/churn?n=0`)), 'ERR_TOO_MANY_REDIRECTS');
    assert.equal(churnHits.n, 11, 'fetchFollow: 10 redirects followed, then it stops');
  });
});

// ── (e) Resources ──────────────────────────────────────────────

describe('R1 (e) — hang / OOM', () => {
  test('brotli, deflate and gzip bombs (64 MiB decoded) stop at a DECODED cap', async () => {
    for (const p of ['/bomb-br', '/bomb-deflate', '/bomb-gz']) {
      const t0 = Date.now();
      assert.equal(await code(fx.fetchFollow(`http://public.test:${P}${p}`, { maxBytes: 1024 * 1024 })), 'ERR_BODY_TOO_LARGE', p);
      assert.ok(Date.now() - t0 < 2000, `${p} decoded past the cap instead of stopping`);
    }
    const t = await fx.traceRedirects(`http://public.test:${P}/bomb-br`);
    assert.equal(t.stop, 'final');   // HTML sniff: truncated at 64 KiB, not an error
  });
  test('slow-drip HEADERS (a line every 200 ms, forever) hit the per-hop timer', async () => {
    const rawFx = createSafeFetcher({ classify: (ip, port) => (ip === '127.0.0.1' && port === RAW) || isPublicIp(ip) });
    const t0 = Date.now();
    assert.equal(await code(rawFx.safeRequest(`http://127.0.0.1:${RAW}/`, { timeoutMs: 1000 })), 'ERR_HOP_TIMEOUT');
    assert.ok(Date.now() - t0 < 2500);
    const t = await rawFx.traceRedirects(`http://127.0.0.1:${RAW}/`, { hopTimeoutMs: 1000 });
    assert.equal(t.stop, 'timeout');
    assert.equal(await code(rawFx.fetchFollow(`http://127.0.0.1:${RAW}/`, { totalTimeoutMs: 1000 })), 'ERR_HOP_TIMEOUT');
  });
  test('no socket outlives an early exit (blocked, timeout, bomb, abort, refused)', async () => {
    const baseline = await settleSockets(0, 500);
    const rawFx = createSafeFetcher({ classify: (ip, port) => (ip === '127.0.0.1' && port === RAW) || isPublicIp(ip) });
    await code(fx.safeRequest(`http://mixed.test:${T}/`));
    await code(rawFx.safeRequest(`http://127.0.0.1:${RAW}/`, { timeoutMs: 400 }));
    await code(fx.fetchFollow(`http://public.test:${P}/bomb-br`, { maxBytes: 64 * 1024 }));
    await code(fx.safeRequest(`http://refused.test:${R}/`));
    const ac = new AbortController();
    const p = fx.safeRequest(`http://127.0.0.1:${RAW}/`, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await code(p);
    assert.equal(await settleSockets(baseline), baseline, 'a client socket was left open');
  });
  test('a final page of 64 KiB unclosed <meta is parsed quickly (was ~0.7 s of blocked event loop)', async () => {
    const t0 = Date.now();
    const t = await fx.traceRedirects(`http://public.test:${P}/hostile-meta`);
    assert.equal(t.stop, 'final');
    assert.equal(t.final.title, 't');
    assert.ok(Date.now() - t0 < 300, `took ${Date.now() - t0} ms`);
  });
});

// ── R1 fix: the page parsers are linear ────────────────────────

describe('R1 fix — page parsers are linear on hostile input (were O(N²))', () => {
  const N = 512 * 1024;    // the old patterns: ~43 s (meta) / ~11 s (title) at this size
  const fast = (label, fn) => {
    const t0 = process.hrtime.bigint();
    fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 500, `${label}: ${ms.toFixed(0)} ms`);
  };
  test('findMetaRefresh / findTitle / findJsRedirect on 512 KiB of junk', () => {
    fast('unclosed <meta', () => assert.equal(findMetaRefresh('<meta'.repeat(N / 5)), null));
    fast('unclosed <title', () => assert.equal(findTitle('<title>'.repeat(N / 7)), null));
    fast('unclosed <title + text', () => assert.equal(findTitle('<title>' + 'a'.repeat(N)), null));
    fast('long attribute run', () => findMetaRefresh('<meta ' + 'a="b '.repeat(N / 5)));
    fast('location= runs', () => findJsRedirect(("location='" + 'a'.repeat(3000)).repeat(N / 3010), 'http://a/'));
    fast('window.open runs', () => findJsRedirect('window.open('.repeat(N / 12), 'http://a/'));
  });
  test('…and still read real pages the same way', () => {
    assert.deepEqual(findMetaRefresh('<meta http-equiv="refresh" content="0;url=/a">'), { delay: 0, url: '/a' });
    assert.deepEqual(findMetaRefresh('<meta<meta http-equiv=refresh content="1; url=/b">'), { delay: 1, url: '/b' });
    assert.equal(findTitle('<title>a < b &amp; c</title>'), 'a < b & c');
    assert.equal(findTitle('<TITLE lang=en>One</TITLE><title>Two</title>'), 'One');
    assert.equal(findTitle('<title>open'), null);
    assert.equal(findTitle('<!-- <title>no</title> --><title>yes</title>'), 'yes');
  });
});

// ── R1 fix: ping / traceroute / portcheck target ───────────────

describe('R1 fix — resolvePublicTarget (portcheck, ping, traceroute)', () => {
  test('a private literal is refused with NO DNS call', async () => {
    resolveCalls.length = 0;
    for (const h of ['127.0.0.1', '[::1]', '::ffff:7f00:1', '169.254.169.254', '10.0.0.1', 'fe80::1%eth0', '64:ff9b::a00:1']) {
      assert.equal(await code(fx.resolvePublicTarget(h)), 'ERR_SSRF_BLOCKED', h);
    }
    assert.equal(resolveCalls.length, 0);
  });
  test('a public literal comes back as itself (brackets stripped)', async () => {
    assert.equal(await fx.resolvePublicTarget('1.1.1.1'), '1.1.1.1');
    assert.equal(await fx.resolvePublicTarget('[2606:4700:4700::1111]'), '2606:4700:4700::1111');
  });
  test('names: only-private refused; mixed → the public address (pinned), never the private one', async () => {
    for (const h of ['localhost', 'v6priv.test', 'mapped.test', 'nat64.test', 'zero.test', 'meta.test']) {
      assert.equal(await code(fx.resolvePublicTarget(h)), 'ERR_SSRF_BLOCKED', h);
    }
    assert.equal(await fx.resolvePublicTarget('mixed.test'), '93.184.215.14');
    assert.equal(await fx.resolvePublicTarget('mixed-rev.test'), '93.184.215.14');
  });
  test('family 4 / 6 picks within that family; a missing family is an error', async () => {
    assert.equal(await fx.resolvePublicTarget('dual.test', { family: '4' }), '93.184.215.14');
    assert.equal(await fx.resolvePublicTarget('dual.test', { family: '6' }), '2606:4700:4700::1111');
    assert.equal(await fx.resolvePublicTarget('dual.test', { family: 'auto' }), '93.184.215.14');
    assert.equal(await code(fx.resolvePublicTarget('v6pub.test', { family: '4' })), 'ENOTFOUND');
  });
  test('option-shaped or malformed input never reaches DNS (or argv)', async () => {
    resolveCalls.length = 0;
    for (const h of ['-f', '--help', '-s65507', '', 'a b', 'a/b', 'x@y', 'host:80', 'a%2e']) {
      assert.equal(await code(fx.resolvePublicTarget(h)), 'ERR_BAD_URL', JSON.stringify(h));
    }
    assert.equal(resolveCalls.length, 0);
  });
});

// ── (f) What errors reveal ─────────────────────────────────────

describe('R1 (f) — errors never echo a resolved internal address', () => {
  test('blocked-by-name and connection-refused details name the URL, not the address', async () => {
    const t1 = await fx.traceRedirects(`http://public.test:${P}/loc?to=${encodeURIComponent(`http://localhost:${T}/`)}`);
    assert.equal(t1.stop, 'blocked');
    assert.match(t1.stopDetail, /localhost/);
    assert.doesNotMatch(t1.stopDetail, /127\.0\.0\.1|::1/);
    const t2 = await fx.traceRedirects(`http://refused.test:${R}/`);
    assert.equal(t2.stop, 'error');
    assert.equal(t2.stopDetail, `http://refused.test:${R}/ — Connection refused`);
    const e = await fx.fetchFollow(`http://mixed.test:${T}/`).catch(x => x);
    assert.equal(e.code, 'ERR_SSRF_BLOCKED');
    assert.doesNotMatch(e.message, /127\.0\.0\.1|93\.184/);
  });
});
