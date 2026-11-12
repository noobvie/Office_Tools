'use strict';

// url-guard.js — the yt-server SSRF allowlist. node:test, zero deps: `npm test` in yt-server/.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkVideoUrl } = require('../url-guard');

const BS  = '\x5c';   // a literal backslash, spelled so no tool or shell can collapse it
const ID  = 'dQw4w9WgXcQ';
const CANON = `https://www.youtube.com/watch?v=${ID}`;

test('every single-video form passes and comes back as one canonical watch URL', () => {
  for (const raw of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `http://www.youtube.com/watch/?v=${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://youtube.com/shorts/${ID}/`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/v/${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abcdef`,
    `  HTTPS://WWW.YouTube.COM/watch?v=${ID}  `,
    `https://www.youtube.com./watch?v=${ID}`,
    'https://youtu.be/J6VMJLSNAHk',
  ]) {
    const want = raw.includes('J6VMJLSNAHk') ? 'https://www.youtube.com/watch?v=J6VMJLSNAHk' : CANON;
    assert.deepEqual(checkVideoUrl(raw), { href: want }, raw);
  }
});

test('playlist, timestamp and every other parameter are dropped', () => {
  for (const raw of [
    `https://www.youtube.com/watch?v=${ID}&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG&index=3`,
    `https://www.youtube.com/watch?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG&v=${ID}&t=42s`,
    `https://youtu.be/${ID}?t=90&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG`,
    `https://www.youtube.com/watch?v=${ID}#t=10`,
  ]) assert.deepEqual(checkVideoUrl(raw), { href: CANON }, raw);
});

test('non-video URLs on a YouTube host are refused', () => {
  for (const raw of [
    'https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
    'https://www.youtube.com/@SomeChannel',
    'https://www.youtube.com/@SomeChannel/videos',
    'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
    'https://www.youtube.com/c/SomeChannel',
    'https://www.youtube.com/user/SomeUser',
    'https://www.youtube.com/results?search_query=music',
    'https://www.youtube.com/feed/trending',
    'https://www.youtube.com/',
    'https://www.youtube.com',
    `https://www.youtube.com/shorts/${ID}/extra`,
    `https://studio.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}/extra`,
  ]) assert.deepEqual(checkVideoUrl(raw), { error: 'unsupported_url' }, raw);
});

test('a malformed video id is refused', () => {
  for (const raw of [
    'https://www.youtube.com/watch?v=abc',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=',
    `https://www.youtube.com/watch?v=${ID}x`,
    `https://www.youtube.com/watch?v=${ID.slice(0, 10)}%00`,
    'https://www.youtube.com/watch?v=dQw4w9WgXc!',
    'https://youtube.com/shorts/abc',
    'https://youtu.be/',
    'https://youtu.be/abc',
  ]) assert.deepEqual(checkVideoUrl(raw), { error: 'invalid_url' }, raw);
});

test('a look-alike host is refused', () => {
  for (const raw of ['https://evilyoutube.com/x', 'https://notyoutu.be/x', 'https://youtube.com.evil.example/x',
    'https://xmusic.youtube.co/x', 'https://youtube.co/x', 'http://127.0.0.1/youtube.com', 'http://169.254.169.254/#youtube.com',
    `https://evilyoutube.com/watch?v=${ID}`]) {
    assert.deepEqual(checkVideoUrl(raw), { error: 'unsupported_host' }, raw);
  }
});

test('parser differential: yt-dlp never gets the raw string', () => {
  // WHATWG: host youtube.com. Python urllib (yt-dlp): host evil.example.
  assert.deepEqual(checkVideoUrl(`https://youtube.com${BS}@evil.example/x`), { error: 'unsupported_url' });
  const r = checkVideoUrl(`https://www.youtube.com${BS}@evil.example/watch?v=${ID}`);
  assert.ok(r.error || r.href === CANON, JSON.stringify(r));
  // Even an accepted URL is rebuilt from the id alone.
  const ok = checkVideoUrl(`https://www.youtube.com/watch?v=${ID}&x=${BS}@evil.example`);
  assert.deepEqual(ok, { href: CANON });
});

test('userinfo, ports, non-web schemes and junk are refused', () => {
  assert.deepEqual(checkVideoUrl(`https://user@youtube.com/watch?v=${ID}`), { error: 'unsupported_host' });
  assert.deepEqual(checkVideoUrl('https://youtube.com@evil.example/x'), { error: 'unsupported_host' });
  assert.deepEqual(checkVideoUrl(`https://youtube.com:8080/watch?v=${ID}`), { error: 'unsupported_host' });
  for (const raw of ['file:///etc/passwd', 'ftp://youtube.com/x', 'javascript:alert(1)//youtube.com', 'youtube.com/watch',
    '', '   ', null, undefined, 42, { href: 'https://youtube.com' }, ['https://youtube.com']]) {
    assert.deepEqual(checkVideoUrl(raw), { error: 'invalid_url' }, String(raw));
  }
});
