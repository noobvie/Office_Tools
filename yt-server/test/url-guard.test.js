'use strict';

// url-guard.js — the yt-server SSRF allowlist. node:test, zero deps: `npm test` in yt-server/.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkVideoUrl } = require('../url-guard');

const BS = '\x5c';   // a literal backslash, spelled so no tool or shell can collapse it

test('YouTube URLs pass, and come back canonical', () => {
  for (const [raw, href] of [
    ['https://www.youtube.com/watch?v=abc', 'https://www.youtube.com/watch?v=abc'],
    ['https://youtube.com/shorts/abc', 'https://youtube.com/shorts/abc'],
    ['https://m.youtube.com/watch?v=abc', 'https://m.youtube.com/watch?v=abc'],
    ['https://music.youtube.com/watch?v=abc', 'https://music.youtube.com/watch?v=abc'],
    ['https://youtu.be/abc', 'https://youtu.be/abc'],
    ['  HTTPS://WWW.YouTube.COM/watch?v=abc  ', 'https://www.youtube.com/watch?v=abc'],
    ['https://www.youtube.com./watch?v=abc', 'https://www.youtube.com./watch?v=abc'],
  ]) assert.deepEqual(checkVideoUrl(raw), { href }, raw);
});

test('a look-alike host is refused (was: endsWith without a dot)', () => {
  for (const raw of ['https://evilyoutube.com/x', 'https://notyoutu.be/x', 'https://youtube.com.evil.example/x',
    'https://xmusic.youtube.co/x', 'https://youtube.co/x', 'http://127.0.0.1/youtube.com', 'http://169.254.169.254/#youtube.com']) {
    assert.deepEqual(checkVideoUrl(raw), { error: 'unsupported_host' }, raw);
  }
});

test('parser differential: yt-dlp gets the CHECKED href, never the raw string', () => {
  // WHATWG: host youtube.com. Python urllib (yt-dlp): host evil.example.
  const raw = `https://youtube.com${BS}@evil.example/x`;
  const r = checkVideoUrl(raw);
  assert.equal(r.href, 'https://youtube.com/@evil.example/x');
  assert.notEqual(r.href, raw);
  assert.ok(!r.href.includes(BS));
});

test('userinfo, ports, non-web schemes and junk are refused', () => {
  assert.deepEqual(checkVideoUrl('https://user@youtube.com/x'), { error: 'unsupported_host' });
  assert.deepEqual(checkVideoUrl('https://youtube.com@evil.example/x'), { error: 'unsupported_host' });
  assert.deepEqual(checkVideoUrl('https://youtube.com:8080/x'), { error: 'unsupported_host' });
  for (const raw of ['file:///etc/passwd', 'ftp://youtube.com/x', 'javascript:alert(1)//youtube.com', 'youtube.com/watch',
    '', '   ', null, undefined, 42, { href: 'https://youtube.com' }, ['https://youtube.com']]) {
    assert.deepEqual(checkVideoUrl(raw), { error: 'invalid_url' }, String(raw));
  }
});
