'use strict';

// Tests for lib/safe-fetch.js. node:test, zero dependencies: `npm test` in backend/.
//
// Fixtures bind 127.0.0.1 on port 0 and are closed in after(). They are reached through
// the D7 seam — createSafeFetcher({ classify, resolve }) — which allows ONLY the fixture
// ports listed in `allowed`; every other address goes through the real isPublicIp().
// The resolver is fake, so no test touches real DNS or the internet.
// fixtures/fixture-test.{key,crt} is a TEST-ONLY self-signed pair for CN=fixture.test,
// trusted by nothing; it exists so the TLS tests can watch SNI against a pinned IP.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');

const sf = require('../lib/safe-fetch');
const { isPublicIp, normalizeUserUrl, createSafeFetcher, parseRefresh, findMetaRefresh, findJsRedirect } = sf;

// ── Fixture plumbing ──────────────────────────────────────────

const allowed = new Set();
const classify = (ip, port) => (ip === '127.0.0.1' && allowed.has(port)) || isPublicIp(ip);

const resolveCalls = [];
const DNS = {
  'fixture.test':  [{ address: '127.0.0.1', family: 4 }],
  'internal.test': [{ address: '127.0.0.1', family: 4 }],   // allowed ONLY on fixture ports
  'mixed.test':    [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.1', family: 4 }],
  'v6priv.test':   [{ address: 'fd00::1', family: 6 }],
};
function fakeResolve(host, opts, cb) {
  resolveCalls.push({ host, opts });
  const a = DNS[host];
  setImmediate(() => {
    if (!a) return cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    cb(null, opts && opts.all ? a.map(x => ({ ...x })) : a[0].address, a[0].family);
  });
}
const fx = createSafeFetcher({ classify, resolve: fakeResolve });

let A, B, C;            // ports: main fixture, "private" target, TLS fixture
let srvA, srvB, srvC;
const hitsB = { connections: 0, requests: 0 };
const seen = [];         // { method, url, auth } per request on A
const sniSeen = [];
const closedA = [];      // paths whose response socket closed early

const BIG = 32 * 1024 * 1024;
let bombGz, bombBr;
const html = s => `<!doctype html><html><head>${s}</head><body>x</body></html>`;

function routeA(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, ae: req.headers['accept-encoding'] });
  const redirect = (code, loc) => { res.writeHead(code, { Location: loc, Server: 'fixture' }); res.end(); };
  const page = (body, extra = {}) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...extra }); res.end(body); };
  const m = /^\/chain\/(\d+)$/.exec(p);
  if (m) { const n = +m[1]; return n > 0 ? redirect(302, `/chain/${n - 1}`) : page(html('<title>end</title>')); }
  const s = /^\/slow\/(\d+)$/.exec(p);
  if (s) { const n = +s[1]; return setTimeout(() => n > 0 ? redirect(302, `/slow/${n - 1}`) : page('done'), 300); }
  switch (p) {
    case '/ok':          return page(html('<title> Landing &amp; Page </title>'));
    case '/plain':       res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('hello');
    case '/c3':          return redirect(301, `http://127.0.0.1:${A}/c2`);
    case '/c2':          return redirect(302, '/c1');
    case '/c1':          return redirect(308, 'ok');
    case '/to-private':  return redirect(302, `http://127.0.0.1:${B}/secret`);
    case '/to-private-name': return redirect(302, `http://internal.test:${B}/secret`);
    case '/to-metadata': return redirect(302, 'http://169.254.169.254/latest/meta-data/');
    case '/proto-rel':   return redirect(302, `//127.0.0.1:${A}/ok`);
    case '/dir/relative': return redirect(302, '../ok');
    case '/see-other':   return redirect(303, '/ok');
    case '/loop-a':      return redirect(302, '/loop-b');
    case '/loop-b':      return redirect(302, '/loop-a#frag');
    case '/refresh-h':   res.writeHead(200, { 'Content-Type': 'text/plain', Refresh: '0; url=/ok' }); return res.end('wait');
    case '/meta1':       return page(html(`<META HTTP-EQUIV="Refresh" CONTENT="0; URL='/ok'">`));
    case '/meta2':       return page(html('<meta content=5;url=/ok http-equiv=refresh>'));
    case '/meta3':       return page(html('<meta http-equiv="refresh" content="3, url=&quot;/ok&quot;">'));
    case '/meta-reload': return page(html('<title>news</title><meta http-equiv="refresh" content="30">'));
    case '/meta-self':   return page(html('<title>self</title><meta http-equiv="refresh" content="60;url=/meta-self">'));
    case '/meta-comment': return page(html('<title>c</title><!-- <meta http-equiv="refresh" content="0;url=/ok"> -->'));
    case '/meta-private': return page(html(`<meta http-equiv="refresh" content="0;url=http://127.0.0.1:${B}/secret">`));
    case '/js':          return page(html('<title>js</title><script>if (1) window.location.href = "https://evil.example/x";</script>'));
    case '/js-rel':      return page(html(`<script>location.replace('/next?a=1')</script>`));
    case '/js-scheme':   return redirect(302, 'javascript:alert(1)');
    case '/intent':      return redirect(302, 'intent://scan/#Intent;scheme=zxing;end');
    case '/bad-loc':     return redirect(302, 'http://[::1');
    case '/userinfo':    return redirect(302, `http://user:pw@127.0.0.1:${A}/echo`);
    case '/echo':        return page(html('<title>echo</title>'));
    case '/gz-meta':     res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
                         return res.end(zlib.gzipSync(html('<meta http-equiv="refresh" content="0;url=/ok">')));
    case '/deflate':     res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'deflate' }); return res.end(zlib.deflateSync('deflated body'));
    case '/br':          res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'br' }); return res.end(zlib.brotliCompressSync('brotli body'));
    case '/bomb-gz':     res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' }); return res.end(bombGz);
    case '/bomb-br':     res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'br' }); return res.end(bombBr);
    case '/big-plain':   res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(Buffer.alloc(2 * 1024 * 1024));
    case '/drip': {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const t = setInterval(() => res.write('x'), 100);
      req.on('close', () => { clearInterval(t); closedA.push(p); });
      return;
    }
    case '/hang':        req.on('close', () => closedA.push(p)); return;
    case '/redirect-endless-body': {
      res.writeHead(302, { Location: '/ok' });
      const chunk = Buffer.alloc(16 * 1024, 120);
      const t = setInterval(() => res.write(chunk), 5);
      req.on('close', () => { clearInterval(t); closedA.push(p); });
      return;
    }
    default: res.writeHead(404); return res.end('nope');
  }
}

function listen(server) {
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}
function close(server) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise(r => server.close(() => r()));
}

before(async () => {
  bombGz = zlib.gzipSync(Buffer.alloc(BIG));
  bombBr = zlib.brotliCompressSync(Buffer.alloc(BIG));
  srvA = http.createServer(routeA);
  srvB = http.createServer((req, res) => { hitsB.requests++; res.end('{"secret":true}'); });
  srvB.on('connection', () => { hitsB.connections++; });
  const fdir = path.join(__dirname, 'fixtures');
  const key = fs.readFileSync(path.join(fdir, 'fixture-test.key'));
  const cert = fs.readFileSync(path.join(fdir, 'fixture-test.crt'));
  const ctx = tls.createSecureContext({ key, cert });
  srvC = https.createServer({ key, cert, SNICallback: (name, cb) => { sniSeen.push(name); cb(null, ctx); } },
    (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('tls ok'); });
  A = await listen(srvA);
  B = await listen(srvB);
  C = await listen(srvC);
  allowed.add(A);
  allowed.add(C);
});

after(async () => {
  await Promise.all([close(srvA), close(srvB), close(srvC)]);
});

// ── D3: the classifier ────────────────────────────────────────

describe('isPublicIp — IPv4 (D3)', () => {
  const cases = [
    // [range, inside (refused), boundary-outside (allowed)]
    ['0/8',            '0.255.255.255',   '1.0.0.0'],
    ['10/8',           '10.0.0.1',        '11.0.0.0'],
    ['10/8 low edge',  '10.0.0.0',        '9.255.255.255'],
    ['100.64/10',      '100.127.255.255', '100.128.0.0'],
    ['100.64/10 low',  '100.64.0.0',      '100.63.255.255'],
    ['127/8',          '127.255.255.254', '128.0.0.0'],
    ['169.254/16',     '169.254.169.254', '169.255.0.0'],
    ['172.16/12',      '172.31.255.255',  '172.32.0.0'],
    ['172.16/12 low',  '172.16.0.0',      '172.15.255.255'],
    ['192.0.0/24',     '192.0.0.8',       '192.0.1.0'],
    ['192.0.2/24',     '192.0.2.1',       '192.0.3.0'],
    ['192.88.99/24',   '192.88.99.1',     '192.88.100.0'],
    ['192.168/16',     '192.168.1.1',     '192.169.0.0'],
    ['198.18/15',      '198.19.255.255',  '198.20.0.0'],
    ['198.18/15 low',  '198.18.0.0',      '198.17.255.255'],
    ['198.51.100/24',  '198.51.100.7',    '198.51.101.0'],
    ['203.0.113/24',   '203.0.113.9',     '203.0.114.0'],
    ['224/4',          '224.0.0.1',       '223.255.255.255'],
  ];
  for (const [name, inside, outside] of cases) {
    test(`${name}: ${inside} refused, ${outside} allowed`, () => {
      assert.equal(isPublicIp(inside), false);
      assert.equal(isPublicIp(outside), true);
    });
  }
  test('240/4: 240.0.0.0 refused (its lower neighbour 239.255.255.255 is in 224/4 — no public edge)', () => {
    assert.equal(isPublicIp('240.0.0.0'), false);
    assert.equal(isPublicIp('239.255.255.255'), false);
  });
  test('255.255.255.255 refused; ordinary public addresses allowed', () => {
    assert.equal(isPublicIp('255.255.255.255'), false);
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.215.14']) assert.equal(isPublicIp(ip), true, ip);
  });
  test('non-canonical spellings are not IPs, so not public', () => {
    for (const s of ['127.1', '2130706433', '0x7f.0.0.1', '010.0.0.1', 'localhost', '', null, undefined]) {
      assert.equal(isPublicIp(s), false, String(s));
    }
  });
});

describe('isPublicIp — IPv6 (D3)', () => {
  const refused = {
    '::/128': '::', '::1/128': '::1', 'IPv4-compatible ::/96': '::7f00:1',
    'mapped dotted → 127/8': '::ffff:127.0.0.1', 'mapped hex → 127/8': '::ffff:7f00:1',
    'mapped → 10/8': '::ffff:10.0.0.1', 'mapped → metadata': '::ffff:a9fe:a9fe',
    'NAT64 → 127/8': '64:ff9b::7f00:1', 'NAT64 → 10/8': '64:ff9b::a00:1',
    'NAT64 local-use 64:ff9b:1::/48': '64:ff9b:1::808:808',
    '6to4 → 127/8': '2002:7f00:1::', '6to4 → metadata': '2002:a9fe:a9fe::1',
    'Teredo 2001::/32': '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2001:db8::/32': '2001:db8::1', '100::/64': '100::1',
    'fc00::/7 (fc)': 'fc00::1', 'fc00::/7 (fd)': 'fd12:3456::1',
    'fe80::/10': 'fe80::1', 'fe80::/10 top': 'febf:ffff::1', 'fec0::/10': 'fec0::1',
    'ff00::/8': 'ff02::1', 'uppercase link-local': 'FE80::1',
    'zone id on link-local': 'fe80::1%eth0', 'zone id on a global address': '2606:4700::1111%eth0',
    'bracketed loopback': '[::1]', 'below 2000::/3': '1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'above 2000::/3': '4000::1',
  };
  for (const [name, ip] of Object.entries(refused)) {
    test(`refused: ${name} (${ip})`, () => assert.equal(isPublicIp(ip), false));
  }
  const allowedV6 = {
    'mapped → public': '::ffff:8.8.8.8', 'mapped hex → public': '::ffff:808:808',
    'NAT64 → public': '64:ff9b::808:808', '6to4 → public': '2002:808:808::1',
    'outside Teredo (2001:1::/32)': '2001:1::1', 'outside documentation (2001:db9::)': '2001:db9::1',
    'start of 2000::/3': '2000::1', 'end of 2000::/3': '3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'Cloudflare': '2606:4700:4700::1111', 'uppercase global': '2606:4700:4700::1111'.toUpperCase(),
  };
  for (const [name, ip] of Object.entries(allowedV6)) {
    test(`allowed: ${name} (${ip})`, () => assert.equal(isPublicIp(ip), true));
  }
});

describe('net.BlockList behaviour the classifier depends on (D3: tested, not assumed)', () => {
  test('a v4 rule DOES match ::ffff:a.b.c.d (dotted and hex) checked as ipv6', () => {
    const bl = new net.BlockList();
    bl.addSubnet('127.0.0.0', 8, 'ipv4');
    assert.equal(bl.check('::ffff:127.0.0.1', 'ipv6'), true);
    assert.equal(bl.check('::ffff:7f00:1', 'ipv6'), true);
  });
  test('TRAP: a ::ffff:0:0/96 v6 rule matches EVERY plain IPv4 address', () => {
    const bl = new net.BlockList();
    bl.addSubnet('::ffff:0:0', 96, 'ipv6');
    assert.equal(bl.check('8.8.8.8', 'ipv4'), true);   // why the mapped prefix is never listed
  });
  test('a v4 rule does NOT match NAT64 / 6to4 embedded IPv4 — those need explicit decoding', () => {
    const bl = new net.BlockList();
    bl.addSubnet('127.0.0.0', 8, 'ipv4');
    assert.equal(bl.check('64:ff9b::7f00:1', 'ipv6'), false);
    assert.equal(bl.check('2002:7f00:1::', 'ipv6'), false);
  });
});

// ── normalizeUserUrl ──────────────────────────────────────────

describe('normalizeUserUrl', () => {
  const toLoopback = {
    decimal: 'http://2130706433/', hex: 'http://0x7f.1/', octal: 'http://017700000001/',
    'short-dotted': 'http://127.1/', 'scheme-less decimal': '2130706433',
    backslashes: 'http:\x5c\x5c127.0.0.1\x5cx', 'mixed slashes': 'http:/\x5c127.0.0.1/',
  };
  for (const [name, raw] of Object.entries(toLoopback)) {
    test(`${name} (${raw}) canonicalises to 127.0.0.1 and is not public`, () => {
      const { url } = normalizeUserUrl(raw);
      assert.equal(url.hostname, '127.0.0.1');
      assert.equal(isPublicIp(url.hostname), false);
    });
  }
  test('[::ffff:7f00:1] and [::] stay IPv6 and are not public', () => {
    assert.equal(normalizeUserUrl('http://[::ffff:7f00:1]/').url.hostname, '[::ffff:7f00:1]');
    assert.equal(normalizeUserUrl('HTTP://[::FFFF:127.0.0.1]/').url.hostname, '[::ffff:7f00:1]');
    assert.equal(normalizeUserUrl('http://[::]/').url.hostname, '[::]');
    for (const h of ['[::ffff:7f00:1]', '[::]']) assert.equal(isPublicIp(h), false);
  });
  test('http://0/ → 0.0.0.0, not public', () => {
    const { url } = normalizeUserUrl('http://0/');
    assert.equal(url.hostname, '0.0.0.0');
    assert.equal(isPublicIp(url.hostname), false);
  });
  test('scheme-less input gets https://, a host:port is not mistaken for a scheme', () => {
    assert.equal(normalizeUserUrl('bit.ly/abc').url.href, 'https://bit.ly/abc');
    assert.equal(normalizeUserUrl('  example.com:8443/x ').url.href, 'https://example.com:8443/x');
    assert.equal(normalizeUserUrl('//example.com/y').url.href, 'https://example.com/y');
  });
  test('userinfo is stripped and reported', () => {
    const r = normalizeUserUrl('https://paypal.com@evil.example/login');
    assert.equal(r.url.href, 'https://evil.example/login');
    assert.equal(r.userinfo, 'paypal.com');
    const r2 = normalizeUserUrl('https://u:p%40ss@example.com/');
    assert.equal(r2.userinfo, 'u:p@ss');
    assert.equal(r2.url.username + r2.url.password, '');
    assert.equal(normalizeUserUrl('https://example.com/').userinfo, '');
  });
  test('non-web schemes, garbage and zone ids are refused', () => {
    for (const raw of ['javascript:alert(1)', 'ftp://x.example/', 'file:///etc/passwd', 'data:text/html,hi', 'intent://x']) {
      assert.throws(() => normalizeUserUrl(raw), { code: 'ERR_UNSUPPORTED_PROTOCOL' }, raw);
    }
    for (const raw of ['', '   ', 'http://', 'http://[fe80::1%25eth0]/', 'http://1.2.3.4.5/', 'https://exa mple.com/']) {
      assert.throws(() => normalizeUserUrl(raw), { code: 'ERR_BAD_URL' }, raw);
    }
  });
});

// ── guardedLookup ─────────────────────────────────────────────

describe('guardedLookup', () => {
  const realish = createSafeFetcher({ resolve: (h, o, cb) => setImmediate(() => cb(null, {
    'pub.test':   [{ address: '93.184.215.14', family: 4 }, { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 }],
    'mixed.test': [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.1', family: 4 }],
    'mapped.test': [{ address: '::ffff:169.254.169.254', family: 6 }],
  }[h])) });
  const call = (...args) => new Promise(r => realish.guardedLookup(...args, (...out) => r(out)));

  test('{all:true} → array of every address', async () => {
    const [err, addrs] = await call('pub.test', { all: true });
    assert.equal(err, null);
    assert.deepEqual(addrs.map(a => a.address), ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c']);
  });
  test('no options / {} / numeric family → (err, address, family)', async () => {
    for (const opts of [{}, 4]) {
      const [err, addr, fam] = await call('pub.test', opts);
      assert.equal(err, null);
      assert.equal(addr, '93.184.215.14');
      assert.equal(fam, 4);
    }
    const out = await new Promise(r => realish.guardedLookup('pub.test', (...o) => r(o)));
    assert.equal(out[1], '93.184.215.14');
  });
  test('public + private answer → the whole host is refused (both shapes)', async () => {
    for (const opts of [{ all: true }, {}]) {
      const [err, addr] = await call('mixed.test', opts);
      assert.equal(err?.code, 'ERR_SSRF_BLOCKED');
      assert.equal(addr, undefined);
      assert.doesNotMatch(err.message, /10\.0\.0\.1/, 'the internal address is not echoed');
    }
  });
  test('an IPv4-mapped metadata answer is refused', async () => {
    const [err] = await call('mapped.test', { all: true });
    assert.equal(err?.code, 'ERR_SSRF_BLOCKED');
  });
});

// ── safeRequest ───────────────────────────────────────────────

describe('safeRequest', () => {
  test('an IP literal is refused with NO DNS call and no connection', async () => {
    const calls = [];
    const spy = createSafeFetcher({ resolve: (h, o, cb) => { calls.push(h); cb(new Error('must not resolve')); } });
    const before = hitsB.connections;
    for (const raw of ['http://2130706433/', 'http://0x7f.1/', 'http://127.1/', 'http://[::1]/', 'http://[::ffff:7f00:1]/',
      'http://169.254.169.254/latest/meta-data/', `http://127.0.0.1:${B}/secret`, 'http:\x5c\x5c127.0.0.1\x5c']) {
      const { url } = normalizeUserUrl(raw);
      await assert.rejects(spy.safeRequest(url), { code: 'ERR_SSRF_BLOCKED' }, raw);
    }
    assert.deepEqual(calls, []);
    assert.equal(hitsB.connections, before);
  });
  test('a hostname resolving to a private address is refused at lookup, no connection', async () => {
    const before = hitsB.connections;
    await assert.rejects(fx.safeRequest(`http://internal.test:${B}/secret`), { code: 'ERR_SSRF_BLOCKED' });
    await assert.rejects(fx.safeRequest(`http://v6priv.test:${B}/`), { code: 'ERR_SSRF_BLOCKED' });
    assert.equal(hitsB.connections, before);
  });
  test('a mixed answer (allowed + private) is refused even though one address is fine', async () => {
    const n = seen.length;
    await assert.rejects(fx.safeRequest(`http://mixed.test:${A}/ok`), { code: 'ERR_SSRF_BLOCKED' });
    assert.equal(seen.length, n, 'fixture A saw no request');
  });
  test('hostname request works with Node calling lookup {all:true} (autoSelectFamily on)', async () => {
    resolveCalls.length = 0;
    const r = await fx.safeRequest(`http://fixture.test:${A}/plain`);
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), 'hello');
    assert.equal(r.remoteAddress, '127.0.0.1');
    assert.equal(resolveCalls.length, 1, 'resolved exactly once: the check and the connect share one answer');
  });
  test('…and with lookup called WITHOUT {all} (autoSelectFamily off)', async () => {
    const prev = net.getDefaultAutoSelectFamily();
    net.setDefaultAutoSelectFamily(false);
    try {
      const r = await fx.safeRequest(`http://fixture.test:${A}/plain`);
      assert.equal(r.body.toString(), 'hello');
    } finally { net.setDefaultAutoSelectFamily(prev); }
  });
  test('sends Accept-Encoding and decodes gzip / deflate / br', async () => {
    const d = await fx.safeRequest(`http://127.0.0.1:${A}/deflate`);
    assert.equal(d.body.toString(), 'deflated body');
    const b = await fx.safeRequest(`http://127.0.0.1:${A}/br`);
    assert.equal(b.body.toString(), 'brotli body');
    assert.match(seen.at(-1).ae, /gzip/);
    assert.match(seen.at(-1).ae, /br/);
  });
  for (const kind of ['gz', 'br']) {
    test(`${kind} bomb (small compressed, 32 MiB decoded) is stopped at the DECODED cap`, async () => {
      const t0 = Date.now();
      await assert.rejects(fx.safeRequest(`http://127.0.0.1:${A}/bomb-${kind}`, { maxBytes: 1024 * 1024 }), { code: 'ERR_BODY_TOO_LARGE' });
      const r = await fx.safeRequest(`http://127.0.0.1:${A}/bomb-${kind}`, { maxBytes: 64 * 1024, truncate: true });
      assert.equal(r.truncated, true);
      assert.equal(r.body.length, 64 * 1024);
      assert.ok(Date.now() - t0 < 5000);
    });
  }
  test('identity body over the cap → ERR_BODY_TOO_LARGE', async () => {
    await assert.rejects(fx.safeRequest(`http://127.0.0.1:${A}/big-plain`, { maxBytes: 1024 * 1024 }), { code: 'ERR_BODY_TOO_LARGE' });
  });
  test('slow-drip body hits the per-request timeout (headers arrived, body never ends)', async () => {
    const t0 = Date.now();
    await assert.rejects(fx.safeRequest(`http://127.0.0.1:${A}/drip`, { timeoutMs: 600 }), { code: 'ERR_HOP_TIMEOUT' });
    const el = Date.now() - t0;
    assert.ok(el >= 550 && el < 2000, `elapsed ${el}`);
  });
  test('no headers at all hits the same timeout', async () => {
    await assert.rejects(fx.safeRequest(`http://127.0.0.1:${A}/hang`, { timeoutMs: 400 }), { code: 'ERR_HOP_TIMEOUT' });
  });
  test('an AbortSignal aborts the request', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(fx.safeRequest(`http://127.0.0.1:${A}/hang`, { timeoutMs: 5000, signal: ac.signal }), { code: 'ERR_ABORTED' });
  });
  test('userinfo is never sent as Authorization', async () => {
    await fx.safeRequest(`http://user:pw@127.0.0.1:${A}/echo`);
    assert.equal(seen.at(-1).auth, undefined);
  });
  test('non-web scheme refused', async () => {
    await assert.rejects(fx.safeRequest('ftp://example.com/'), { code: 'ERR_UNSUPPORTED_PROTOCOL' });
  });
  test('https: SNI carries the hostname while lookup pins the IP; TLS verification is ON', async () => {
    sniSeen.length = 0;
    const err = await fx.safeRequest(`https://fixture.test:${C}/`).then(() => null, e => e);
    assert.ok(err, 'a self-signed cert must not be accepted');
    assert.match(String(err.code), /SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/);
    assert.deepEqual(sniSeen, ['fixture.test']);
  });
});

// ── certInfo ──────────────────────────────────────────────────

describe('certInfo', () => {
  test('reads the cert from the pinned IP with SNI = hostname, never resolving', async () => {
    sniSeen.length = 0;
    const n = resolveCalls.length;
    const c = await fx.certInfo(`https://fixture.test:${C}/`, '127.0.0.1');
    assert.equal(resolveCalls.length, n, 'no DNS');
    assert.deepEqual(sniSeen, ['fixture.test']);
    assert.ok(c && c.validTo);
    assert.equal(c.issuer, 'Office Tools TEST FIXTURE');
    assert.ok(c.daysLeft > 30000);
  });
  test('a non-public / missing remote address → null without connecting', async () => {
    sniSeen.length = 0;
    const before = hitsB.connections;
    assert.equal(await fx.certInfo(`https://fixture.test:${B}/`, '127.0.0.1'), null);   // port not allowed
    assert.equal(hitsB.connections, before, 'no TCP connection to a refused address');
    assert.equal(await fx.certInfo('https://example.com/', '10.0.0.1'), null);
    assert.equal(await fx.certInfo('https://example.com/', null), null);
    assert.equal(await fx.certInfo('https://example.com/', 'example.com'), null);   // a name is not an address
    assert.equal(await fx.certInfo('http://example.com/', '93.184.215.14'), null);
    assert.deepEqual(sniSeen, []);
  });
});

// ── traceRedirects (D4) ───────────────────────────────────────

describe('traceRedirects', () => {
  const T = (p, o) => fx.traceRedirects(`http://127.0.0.1:${A}${p}`, o);
  const CONTRACT = ['start', 'hops', 'final', 'stop', 'stopDetail', 'jsRedirectHint', 'totalMs'];

  test('3-hop chain → hops[] with status, kind, next, ip; final with title', async () => {
    const t = await T('/c3');
    assert.deepEqual(Object.keys(t), CONTRACT);
    assert.equal(t.stop, 'final');
    assert.deepEqual(t.hops.map(h => [h.n, h.status, h.kind]), [[1, 301, 'http'], [2, 302, 'http'], [3, 308, 'http']]);
    assert.equal(t.hops[0].next, `http://127.0.0.1:${A}/c2`);
    assert.equal(t.hops[1].next, `http://127.0.0.1:${A}/c1`);
    assert.equal(t.hops[2].next, `http://127.0.0.1:${A}/ok`);
    for (const h of t.hops) {
      assert.equal(h.ip, '127.0.0.1');
      assert.equal(h.host, '127.0.0.1');
      assert.equal(typeof h.ms, 'number');
    }
    assert.equal(t.hops[0].server, 'fixture');
    assert.deepEqual(t.final, { url: `http://127.0.0.1:${A}/ok`, status: 200, contentType: 'text/html', title: 'Landing & Page', ip: '127.0.0.1', server: null });
    assert.equal(t.stopDetail, null);
    assert.equal(t.jsRedirectHint, null);
  });
  test('redirect to 127.0.0.1 (literal) → blocked, and the target saw ZERO connections', async () => {
    const before = { ...hitsB };
    const t = await T('/to-private');
    assert.equal(t.stop, 'blocked');
    assert.equal(t.final, null);
    assert.equal(t.hops.length, 1);
    assert.equal(t.hops[0].next, `http://127.0.0.1:${B}/secret`);
    assert.match(t.stopDetail, /private \/ internal address/);
    assert.deepEqual(hitsB, before);
  });
  test('redirect to a NAME that resolves private → blocked, zero connections', async () => {
    const before = { ...hitsB };
    const t = await T('/to-private-name');
    assert.equal(t.stop, 'blocked');
    assert.deepEqual(hitsB, before);
  });
  test('redirect to the cloud metadata address → blocked', async () => {
    const t = await T('/to-metadata');
    assert.equal(t.stop, 'blocked');
    assert.match(t.stopDetail, /^http:\/\/169\.254\.169\.254\/latest\/meta-data\//);
  });
  test('a private INPUT → blocked with no hops (the route maps this to 403)', async () => {
    const before = { ...hitsB };
    const t = await fx.traceRedirects(`http://127.0.0.1:${B}/secret`);
    assert.equal(t.stop, 'blocked');
    assert.deepEqual(t.hops, []);
    assert.deepEqual(hitsB, before);
  });
  test('protocol-relative and relative Location are resolved against the current URL', async () => {
    const p = await T('/proto-rel');
    assert.equal(p.hops[0].next, `http://127.0.0.1:${A}/ok`);
    assert.equal(p.stop, 'final');
    const r = await T('/dir/relative');
    assert.equal(r.hops[0].next, `http://127.0.0.1:${A}/ok`);
    assert.equal(r.final.url, `http://127.0.0.1:${A}/ok`);
  });
  test('303 → followed with GET (every hop is GET)', async () => {
    const n = seen.length;
    const t = await T('/see-other');
    assert.equal(t.hops[0].status, 303);
    assert.deepEqual(seen.slice(n).map(s => s.method), ['GET', 'GET']);
  });
  test('loop (a fragment does not dodge detection) → stop loop', async () => {
    const t = await T('/loop-a');
    assert.equal(t.stop, 'loop');
    assert.equal(t.hops.length, 2);
    assert.equal(t.stopDetail, `http://127.0.0.1:${A}/loop-a`);
    assert.equal(t.final, null);
  });
  test('10 redirects are followed; 11 → max-hops, the 11th target not fetched', async () => {
    const ok = await T('/chain/10');
    assert.equal(ok.stop, 'final');
    assert.equal(ok.hops.length, 10);
    const n = seen.length;
    const t = await T('/chain/11');
    assert.equal(t.stop, 'max-hops');
    assert.equal(t.hops.length, 11, 'the 11th redirect is recorded…');
    assert.equal(t.hops[10].next, `http://127.0.0.1:${A}/chain/0`);
    assert.equal(seen.length - n, 11, '…but its target is never requested');
    assert.ok(!seen.slice(n).some(s => s.url === '/chain/0'));
    assert.equal(t.final, null);
    assert.match(t.stopDetail, /\/chain\/0 — more than 10 redirects/);
  });
  test('Refresh header → kind refresh-header', async () => {
    const t = await T('/refresh-h');
    assert.equal(t.hops[0].kind, 'refresh-header');
    assert.equal(t.hops[0].status, 200);
    assert.equal(t.stop, 'final');
  });
  for (const p of ['/meta1', '/meta2', '/meta3', '/gz-meta']) {
    test(`meta refresh ${p} → kind meta-refresh`, async () => {
      const t = await T(p);
      assert.equal(t.hops.length, 1);
      assert.equal(t.hops[0].kind, 'meta-refresh');
      assert.equal(t.hops[0].next, `http://127.0.0.1:${A}/ok`);
      assert.equal(t.final.title, 'Landing & Page');
    });
  }
  test('meta refresh without url, to itself, or inside a comment → not a redirect', async () => {
    for (const [p, title] of [['/meta-reload', 'news'], ['/meta-self', 'self'], ['/meta-comment', 'c']]) {
      const t = await T(p);
      assert.equal(t.stop, 'final', p);
      assert.equal(t.hops.length, 0, p);
      assert.equal(t.final.title, title, p);
    }
  });
  test('meta refresh to a private address → blocked', async () => {
    const before = { ...hitsB };
    const t = await T('/meta-private');
    assert.equal(t.stop, 'blocked');
    assert.equal(t.hops[0].kind, 'meta-refresh');
    assert.deepEqual(hitsB, before);
  });
  test('JS redirect is reported as jsRedirectHint and NOT followed', async () => {
    const n = resolveCalls.length;
    const t = await T('/js');
    assert.equal(t.stop, 'final');
    assert.deepEqual(t.jsRedirectHint, { via: 'location.href', url: 'https://evil.example/x' });
    assert.equal(resolveCalls.slice(n).filter(c => c.host === 'evil.example').length, 0);
    const r = await T('/js-rel');
    assert.deepEqual(r.jsRedirectHint, { via: 'location.replace', url: `http://127.0.0.1:${A}/next?a=1` });
  });
  test('javascript: / intent: Location → non-web-scheme, reported, not fetched', async () => {
    const j = await T('/js-scheme');
    assert.equal(j.stop, 'non-web-scheme');
    assert.equal(j.hops[0].next, 'javascript:alert(1)');
    assert.equal(j.stopDetail, 'javascript:alert(1)');
    const i = await T('/intent');
    assert.equal(i.stop, 'non-web-scheme');
    assert.match(i.hops[0].next, /^intent:\/\/scan\//);
  });
  test('an unparseable Location → stop error', async () => {
    const t = await T('/bad-loc');
    assert.equal(t.stop, 'error');
    assert.match(t.stopDetail, /Invalid redirect target/);
  });
  test('userinfo in a hop is stripped before the request, reported in `next`', async () => {
    const t = await T('/userinfo');
    assert.equal(t.hops[0].next, `http://user:pw@127.0.0.1:${A}/echo`);
    assert.equal(t.final.url, `http://127.0.0.1:${A}/echo`);
    assert.equal(seen.at(-1).auth, undefined);
  });
  test('a 3xx body is never read: an endless redirect body does not stall the trace', async () => {
    const t0 = Date.now();
    const t = await T('/redirect-endless-body', { hopTimeoutMs: 3000 });
    assert.equal(t.stop, 'final');
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(closedA.includes('/redirect-endless-body'), 'our side closed the socket');
  });
  test('a gzip bomb as the final HTML page is sniffed only up to 64 KiB', async () => {
    const t = await T('/bomb-gz');
    assert.equal(t.stop, 'final');
    assert.equal(t.final.status, 200);
  });
  test('slow-drip body → stop timeout at the per-hop limit', async () => {
    const t = await T('/drip', { hopTimeoutMs: 600 });
    assert.equal(t.stop, 'timeout');
    assert.match(t.stopDetail, /no complete response within/);
  });
  test('total time limit stops a chain of slow hops', async () => {
    const t = await T('/slow/10', { totalTimeoutMs: 1000, hopTimeoutMs: 800 });
    assert.equal(t.stop, 'timeout');
    assert.ok(t.hops.length >= 1 && t.hops.length <= 3, `hops ${t.hops.length}`);
    assert.ok(t.totalMs < 1600, `totalMs ${t.totalMs}`);
  });
  test('connection refused → stop error with a short reason, no internals', async () => {
    // A port nothing listens on: open one, then close it (guessing a free port is flaky).
    const tmp = http.createServer();
    const dead = await listen(tmp);
    await close(tmp);
    allowed.add(dead);
    const t = await fx.traceRedirects(`http://127.0.0.1:${dead}/`);
    allowed.delete(dead);
    assert.equal(t.stop, 'error');
    assert.match(t.stopDetail, /Connection refused/);
  });
  test('an aborted signal rejects with ERR_ABORTED', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(T('/hang', { signal: ac.signal, hopTimeoutMs: 5000 }), { code: 'ERR_ABORTED' });
  });
});

describe('fetchFollow (the proxy route transport)', () => {
  const F = (p, o) => fx.fetchFollow(`http://127.0.0.1:${A}${p}`, o);

  test('follows a 3-hop chain and returns the final body + URL', async () => {
    const r = await F('/c3');
    assert.equal(r.status, 200);
    assert.equal(r.url, `http://127.0.0.1:${A}/ok`);
    assert.equal(r.redirects, 3);
    assert.match(r.body.toString(), /Landing &amp; Page/);
  });
  test('redirect to 127.0.0.1 → ERR_SSRF_BLOCKED (redirects 1), the target saw ZERO connections', async () => {
    const before = { ...hitsB };
    await assert.rejects(F('/to-private'), e => e.code === 'ERR_SSRF_BLOCKED' && e.redirects === 1);
    await assert.rejects(F('/to-private-name'), { code: 'ERR_SSRF_BLOCKED' });
    await assert.rejects(F('/to-metadata'), { code: 'ERR_SSRF_BLOCKED' });
    assert.deepEqual(hitsB, before);
  });
  test('a private INPUT → ERR_SSRF_BLOCKED with redirects 0', async () => {
    const before = { ...hitsB };
    await assert.rejects(fx.fetchFollow(`http://127.0.0.1:${B}/`), e => e.code === 'ERR_SSRF_BLOCKED' && e.redirects === 0);
    assert.deepEqual(hitsB, before);
  });
  test('more than maxRedirects → ERR_TOO_MANY_REDIRECTS; exactly maxRedirects is fine', async () => {
    assert.equal((await F('/chain/3', { maxRedirects: 3 })).status, 200);
    await assert.rejects(F('/chain/4', { maxRedirects: 3 }), { code: 'ERR_TOO_MANY_REDIRECTS' });
    await assert.rejects(F('/loop-a'), { code: 'ERR_TOO_MANY_REDIRECTS' });
  });
  test('non-web-scheme and unparseable Location are refused', async () => {
    await assert.rejects(F('/js-scheme'), { code: 'ERR_UNSUPPORTED_PROTOCOL' });
    await assert.rejects(F('/bad-loc'), { code: 'ERR_BAD_REDIRECT' });
  });
  test('the byte cap applies to the final DECODED body (gzip bomb)', async () => {
    await assert.rejects(F('/bomb-gz', { maxBytes: 1024 * 1024 }), { code: 'ERR_BODY_TOO_LARGE' });
  });
  test('a 3xx body is never read', async () => {
    const r = await F('/redirect-endless-body', { totalTimeoutMs: 3000 });
    assert.equal(r.status, 200);
  });
  test('one budget covers the whole chain', async () => {
    const t0 = Date.now();
    await assert.rejects(F('/slow/9', { totalTimeoutMs: 700 }), { code: 'ERR_HOP_TIMEOUT' });
    assert.ok(Date.now() - t0 < 1500);
  });
});

// ── pure parsers ──────────────────────────────────────────────

describe('parsers', () => {
  test('parseRefresh follows the HTML declarative-refresh steps', () => {
    assert.deepEqual(parseRefresh('0; url=/x'), { delay: 0, url: '/x' });
    assert.deepEqual(parseRefresh('5;URL=\'/x y\''), { delay: 5, url: '/x y' });
    assert.deepEqual(parseRefresh('3, url="/q"'), { delay: 3, url: '/q' });
    assert.deepEqual(parseRefresh('0 https://a.example/'), { delay: 0, url: 'https://a.example/' });
    assert.deepEqual(parseRefresh('.5;url=/d'), { delay: 0, url: '/d' });
    assert.deepEqual(parseRefresh('30'), { delay: 30, url: '' });
    assert.equal(parseRefresh('url=/x'), null);
    assert.equal(parseRefresh('5x;url=/x'), null);
    assert.equal(parseRefresh(''), null);
  });
  test('findMetaRefresh: attribute order, case, quotes, entities, comments', () => {
    assert.equal(findMetaRefresh('<meta content="0;url=/a" http-equiv="refresh">').url, '/a');
    assert.equal(findMetaRefresh('<META HTTP-EQUIV=REFRESH CONTENT="1;URL=/b">').url, '/b');
    assert.equal(findMetaRefresh('<meta http-equiv="refresh" content="0;url=/c?a=1&amp;b=2">').url, '/c?a=1&b=2');
    assert.equal(findMetaRefresh('<!--<meta http-equiv="refresh" content="0;url=/d">-->'), null);
    assert.equal(findMetaRefresh('<meta name="refresh" content="0;url=/e">'), null);
  });
  test('findJsRedirect: patterns, earliest wins, comparisons ignored', () => {
    assert.deepEqual(findJsRedirect('top.location = "https://a.example/"', 'https://b.example/'), { via: 'location.href', url: 'https://a.example/' });
    assert.deepEqual(findJsRedirect("window.open('/p')", 'https://b.example/'), { via: 'window.open', url: 'https://b.example/p' });
    assert.equal(findJsRedirect('if (location.href == "https://a.example/") {}', 'https://b.example/'), null);
    assert.equal(findJsRedirect('location.href === "x"', 'https://b.example/'), null);
    assert.equal(findJsRedirect('<p>no script</p>', 'https://b.example/'), null);
  });
});
