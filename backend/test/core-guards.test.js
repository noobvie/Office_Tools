'use strict';

// Unit tests for the small request-safety libs: client-ip, rate-limit, captcha,
// sanitize, shares (input rules + expiry sweeper), ttl-cache, fs-safe, http-guards.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const { clientIp, rateKey, isLoopback } = require('../lib/client-ip');
const { makeRateLimiter } = require('../lib/rate-limit');
const { makeCaptcha, CAPTCHA_ERRORS } = require('../lib/captcha');
const { str, stripCtl, cleanHeaderText, safeFileName, validMailbox } = require('../lib/sanitize');
const shares = require('../lib/shares');
const { makeTtlCache } = require('../lib/ttl-cache');
const { emptyDirInside } = require('../lib/fs-safe');
const { asyncRoute, guardAsyncRoutes, finalErrorHandler } = require('../lib/http-guards');

const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
const quiet = { error() {} };

describe('client-ip', () => {
  test('X-Real-IP is trusted only from a loopback peer', () => {
    assert.equal(clientIp(req('127.0.0.1', { 'x-real-ip': '203.0.113.7' })), '203.0.113.7');
    assert.equal(clientIp(req('::1', { 'x-real-ip': '2001:db8::5' })), '2001:db8::5');
    assert.equal(clientIp(req('::ffff:127.0.0.1', { 'x-real-ip': '198.51.100.2' })), '198.51.100.2');
    assert.equal(clientIp(req('198.51.100.9', { 'x-real-ip': '203.0.113.7' })), '198.51.100.9');
  });
  test('X-Forwarded-For and CF-Connecting-IP are never read', () => {
    const h = { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8' };
    assert.equal(clientIp(req('127.0.0.1', h)), '127.0.0.1');
    assert.equal(clientIp(req('198.51.100.9', h)), '198.51.100.9');
  });
  test('an invalid or non-string X-Real-IP falls back to the socket', () => {
    assert.equal(clientIp(req('127.0.0.1', { 'x-real-ip': 'evil' })), '127.0.0.1');
    assert.equal(clientIp(req('127.0.0.1', { 'x-real-ip': ['1.2.3.4'] })), '127.0.0.1');
    assert.equal(clientIp(req('::ffff:198.51.100.9')), '198.51.100.9');
    assert.equal(clientIp({ headers: {} }), '');
  });
  test('isLoopback', () => {
    assert.ok(isLoopback('127.8.9.1'));
    assert.ok(isLoopback('::1'));
    assert.ok(!isLoopback('10.0.0.1'));
    assert.ok(!isLoopback('::2'));
  });
  test('rateKey: IPv4 unchanged, IPv6 → /64', () => {
    assert.equal(rateKey('203.0.113.7'), '203.0.113.7');
    assert.equal(rateKey('2001:db8:aa:bb:1:2:3:4'), '2001:db8:aa:bb::/64');
    assert.equal(rateKey('2001:db8:aa:bb::9'), rateKey('2001:db8:aa:bb:ffff::1'));
    assert.notEqual(rateKey('2001:db8:aa:bb::9'), rateKey('2001:db8:aa:bc::9'));
    assert.equal(rateKey('::1'), '0:0:0:0::/64');
    assert.equal(rateKey('::ffff:198.51.100.1'), '198.51.100.1');
    assert.equal(rateKey(''), 'unknown');
  });
});

describe('rate-limit', () => {
  test('fixed window + blocked() does not count', () => {
    const l = makeRateLimiter({ windowMs: 60_000, max: 2 });
    assert.ok(l.allow('a'));
    assert.ok(!l.blocked('a'));
    assert.ok(l.allow('a'));
    assert.ok(l.blocked('a'));
    assert.ok(!l.allow('a'));
    assert.ok(l.allow('b'));
  });
  test('map is capped: the oldest bucket is evicted', () => {
    const l = makeRateLimiter({ windowMs: 60_000, max: 5, maxKeys: 3 });
    for (const k of ['a', 'b', 'c', 'd', 'e']) l.allow(k);
    assert.equal(l.map.size, 3);
    assert.deepEqual([...l.map.keys()], ['c', 'd', 'e']);
  });
  test('middleware keys on rateKey(clientIp)', () => {
    const l = makeRateLimiter({ windowMs: 60_000, max: 1 });
    let n = 0; const next = () => n++;
    const res = { status() { return this; }, json() { this.sent = true; return this; } };
    l.middleware(req('2001:db8:1:2::1'), res, next);
    l.middleware(req('2001:db8:1:2::99'), res, next);   // same /64 → limited
    assert.equal(n, 1);
    assert.ok(res.sent);
  });
});

describe('captcha', () => {
  test('issue → integers + token; correct answer verifies once', () => {
    const c = makeCaptcha();
    const { a, b, token } = c.issue();
    assert.ok(Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b <= 9);
    assert.ok(typeof token === 'string' && token.length > 10);
    assert.equal(c.verify(a + b, token), 'ok');
    assert.equal(c.verify(a + b, token), 'bad', 'replay refused');
  });
  test('string answer (multipart) works; wrong answer fails', () => {
    const c = makeCaptcha();
    const { a, b, token } = c.issue();
    assert.equal(c.verify(String(a + b + 1), token), 'bad');
    assert.equal(c.verify(String(a + b), token), 'ok');
  });
  test('missing token vs malformed', () => {
    const c = makeCaptcha();
    assert.equal(c.verify(3, undefined), 'missing');
    assert.equal(c.verify(3, ''), 'missing');
    assert.equal(c.verify(3, 'x'), 'bad');
    assert.equal(c.verify(3, { toString: 1 }), 'bad');
    assert.equal(c.verify({ toString: 1 }, c.issue().token), 'bad');
    assert.equal(CAPTCHA_ERRORS.missing.code, 'captcha_reload');
    assert.equal(CAPTCHA_ERRORS.bad.code, 'captcha');
  });
  test('expired token fails', () => {
    let t = 1_000_000;
    const c = makeCaptcha({ now: () => t });
    const { a, b, token } = c.issue();
    t += 10 * 60_000 + 1;
    assert.equal(c.verify(a + b, token), 'bad');
  });
  test('token from another process secret fails', () => {
    const { a, b, token } = makeCaptcha().issue();
    assert.equal(makeCaptcha().verify(a + b, token), 'bad');
  });
  test('used-nonce memory full of live nonces fails closed', () => {
    const c = makeCaptcha({ maxUsed: 1 });
    const x = c.issue(), y = c.issue();
    assert.equal(c.verify(x.a + x.b, x.token), 'ok');
    assert.equal(c.verify(y.a + y.b, y.token), 'bad');
  });
});

describe('sanitize', () => {
  test('str', () => {
    assert.equal(str('a'), 'a');
    assert.equal(str(['a']), '');
    assert.equal(str({ toString: 1 }), '');
    assert.equal(str(Object.create(null)), '');
    assert.equal(str(5), '');
  });
  test('stripCtl / cleanHeaderText remove CR/LF and controls', () => {
    assert.equal(stripCtl('a\r\nb\u0000c d\u0085e'), 'abcde');
    assert.equal(cleanHeaderText('/tools/x\r\nBcc: victim@example.com'), '/tools/x Bcc: victim@example.com');
    assert.ok(!/[\r\n]/.test(cleanHeaderText('a\nb\rc')));
    assert.equal(cleanHeaderText({ toString: 1 }), '');
  });
  test('safeFileName', () => {
    assert.equal(safeFileName('../../etc/passwd'), '.._.._etc_passwd');
    assert.equal(safeFileName('a\\b\u0001.zip'), 'a_b.zip');
    assert.equal(safeFileName('..'), '');
    assert.equal(safeFileName('x'.repeat(300)).length, 200);
    assert.equal(safeFileName(['a']), '');
  });
  test('validMailbox', () => {
    assert.ok(validMailbox('ops@example.com'));
    assert.ok(!validMailbox('a@example.com, b@example.com'));
    assert.ok(!validMailbox('a@example.com\nBcc: x@y.z'));
    assert.ok(!validMailbox('-oQ/tmp@example.com'));
    assert.ok(!validMailbox('a b@example.com'));
  });
});

describe('shares input rules', () => {
  test('share codes accept what the pages send', () => {
    for (const ok of ['my-link', 'abcd', 'Ab3dEf9h', 'aZ09aZ09aZ', 'a'.repeat(20)]) assert.ok(shares.validShareCode(ok), ok);
    for (const bad of ['abc', 'a'.repeat(21), 'a b c d', 'a/bcd', '', ['abcd'], 'äbcd']) assert.ok(!shares.validShareCode(bad), String(bad));
  });
  test('long URL normalised; hostile raw input refused', () => {
    assert.equal(shares.normaliseLongUrl('https://Example.com/a?b=1'), 'https://example.com/a?b=1');
    for (const bad of ['javascript:alert(1)', 'https://x.com/"><script>', 'https://x.com/a b', "https://x.com/'",
      'https://x.com/`', 'https://x.com/\n', 'ftp://x.com/', 'https://x.com/' + 'a'.repeat(2048), {}]) {
      assert.equal(shares.normaliseLongUrl(bad), null, String(bad).slice(0, 40));
    }
  });
  test('optional expiry: empty = never, page format accepted, junk refused', () => {
    assert.equal(shares.optionalExpiry(''), '');
    assert.equal(shares.optionalExpiry(undefined), '');
    assert.equal(shares.optionalExpiry('2026-11-19 10:00:00Z'), '2026-11-19 10:00:00Z');
    assert.equal(shares.optionalExpiry('not a date'), null);
    assert.equal(shares.optionalExpiry({}), null);
  });
  test('file share expiry is clamped to 1..50 days, default 7', () => {
    const now = Date.parse('2026-11-12T00:00:00Z');
    const fmt = d => new Date(now + d * 86_400_000).toISOString().replace('T', ' ').split('.')[0] + 'Z';
    assert.equal(shares.fileShareExpiry(fmt(14), now), fmt(14));
    assert.equal(shares.fileShareExpiry(fmt(500), now), fmt(50));
    assert.equal(shares.fileShareExpiry(fmt(-3), now), fmt(1));
    assert.equal(shares.fileShareExpiry('junk', now), fmt(7));
    assert.equal(shares.fileShareExpiry(undefined, now), fmt(7));
  });
});

describe('shares.sweepExpired', () => {
  test('removes expired rows + files, keeps "never" and live rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-sweep-'));
    try {
      const up = path.join(dir, 'uploads');
      fs.mkdirSync(up);
      const db = new DatabaseSync(':memory:');
      db.exec(`
        CREATE TABLE short_urls (code TEXT PRIMARY KEY, long_url TEXT, expires TEXT DEFAULT '', created TEXT DEFAULT (datetime('now')));
        CREATE TABLE pastes (id TEXT PRIMARY KEY, code TEXT, content TEXT, expires TEXT DEFAULT '', created TEXT DEFAULT (datetime('now')));
        CREATE TABLE file_shares (id TEXT PRIMARY KEY, code TEXT, file_path TEXT, expires TEXT DEFAULT '', created TEXT DEFAULT (datetime('now')));`);
      const now = Date.parse('2026-11-12T00:00:00Z');
      const f1 = path.join(up, 'f1'), f2 = path.join(up, 'f2'), f3 = path.join(up, 'f3');
      for (const f of [f1, f2, f3]) fs.writeFileSync(f, 'x');
      const outside = path.join(dir, 'outside');
      fs.writeFileSync(outside, 'keep');
      const ins = db.prepare('INSERT INTO file_shares (id, code, file_path, expires, created) VALUES (?, ?, ?, ?, ?)');
      ins.run('1', 'c1', f1, '2026-11-01 00:00:00Z', '2026-10-01 00:00:00');        // expired
      ins.run('2', 'c2', f2, '2026-12-01 00:00:00Z', '2026-11-01 00:00:00');        // live
      ins.run('3', 'c3', f3, '', '2026-08-01 00:00:00');                            // legacy, > 50 d old
      ins.run('4', 'c4', path.join(up, 'gone'), '2026-01-01 00:00:00Z', '2025-12-01 00:00:00'); // file missing
      ins.run('5', 'c5', outside, '2026-01-01 00:00:00Z', '2025-12-01 00:00:00');   // path outside uploads
      db.prepare("INSERT INTO pastes (id, code, content, expires) VALUES ('p1','a','x',''), ('p2','b','x','2026-11-01 00:00:00Z'), ('p3','c','x','2027-01-01 00:00:00Z')").run();
      db.prepare("INSERT INTO short_urls (code, long_url, expires) VALUES ('s1','u',''), ('s2','u','2026-11-11 00:00:00Z'), ('s3','u','junk')").run();

      const n = shares.sweepExpired(db, { uploadsDir: up, now, log: quiet });
      assert.deepEqual(n, { files: 4, pastes: 1, shortUrls: 1 });
      assert.deepEqual(db.prepare('SELECT id FROM file_shares').all().map(r => r.id), ['2']);
      assert.ok(!fs.existsSync(f1) && fs.existsSync(f2) && !fs.existsSync(f3));
      assert.ok(fs.existsSync(outside), 'never unlinks outside the uploads dir');
      assert.deepEqual(db.prepare('SELECT id FROM pastes ORDER BY id').all().map(r => r.id), ['p1', 'p3']);
      assert.deepEqual(db.prepare('SELECT code FROM short_urls ORDER BY code').all().map(r => r.code), ['s1', 's3']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('never throws on a broken db', () => {
    const db = new DatabaseSync(':memory:');
    assert.doesNotThrow(() => shares.sweepExpired(db, { uploadsDir: os.tmpdir(), log: quiet }));
  });
});

describe('ttl-cache', () => {
  test('bounded, oldest evicted, re-set refreshes position', () => {
    const c = makeTtlCache({ ttlMs: 60_000, maxEntries: 2 });
    c.set('a', 1); c.set('b', 2); c.set('a', 3); c.set('c', 4);
    assert.equal(c.get('b'), null);
    assert.equal(c.get('a'), 3);
    assert.equal(c.get('c'), 4);
    assert.equal(c.map.size, 2);
  });
});

describe('fs-safe.emptyDirInside', () => {
  test('empties a sub-dir, refuses anything not strictly inside parent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-empty-'));
    try {
      const chat = path.join(root, 'chat');
      fs.mkdirSync(path.join(chat, 'ROOM1'), { recursive: true });
      fs.writeFileSync(path.join(chat, 'ROOM1', 'f'), 'x');
      fs.writeFileSync(path.join(root, 'keep'), 'x');
      assert.equal(emptyDirInside(chat, root, quiet), true);
      assert.deepEqual(fs.readdirSync(chat), []);
      assert.ok(fs.existsSync(path.join(root, 'keep')));
      assert.equal(emptyDirInside(root, root, quiet), false);
      assert.equal(emptyDirInside(path.join(root, '..'), root, quiet), false);
      assert.ok(fs.existsSync(path.join(root, 'keep')));
      assert.equal(emptyDirInside(path.join(root, 'new'), root, quiet), true);   // missing → created
      assert.ok(fs.existsSync(path.join(root, 'new')));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('http-guards', () => {
  function listen(app) {
    return new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  }
  async function call(port, method, p, body, type = 'application/json') {
    return new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port, method, path: p, headers: body ? { 'Content-Type': type } : {} }, res => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      rq.on('error', reject);
      if (body) rq.write(body);
      rq.end();
    });
  }
  test('async rejection → 500 JSON; malformed JSON → 400 JSON; process survives', async () => {
    const orig = console.error; console.error = () => {};
    const app = express();
    guardAsyncRoutes(app);
    app.use(express.json());
    app.get('/boom', async () => { throw new Error('secret detail'); });
    app.get('/explicit', asyncRoute(async () => { throw new Error('x'); }));
    app.post('/echo', (q, s) => s.json({ ok: true }));
    app.get('/sync', () => { throw new Error('sync detail'); });
    app.use(finalErrorHandler);
    const srv = await listen(app);
    try {
      const port = srv.address().port;
      let r = await call(port, 'GET', '/boom');
      assert.equal(r.status, 500); assert.deepEqual(JSON.parse(r.body), { error: 'Server error' });
      r = await call(port, 'GET', '/explicit');
      assert.equal(r.status, 500);
      r = await call(port, 'POST', '/echo', '{bad json');
      assert.equal(r.status, 400); assert.deepEqual(JSON.parse(r.body), { error: 'Bad request' });
      r = await call(port, 'GET', '/sync');
      assert.equal(r.status, 500); assert.ok(!r.body.includes('sync detail'));
      assert.equal(app.get('env') !== undefined, true, 'settings getter still works');
    } finally { srv.close(); console.error = orig; }
  });
});
