'use strict';

// Pure helpers exported by server.js. Requiring server.js does not listen, start timers
// or install process handlers (those run only under `node server.js`).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateDownloadOptions, ytdlpArgs, scrubPaths, isJobTempFile, rateKey, infoRefusal, parseFilesizeLimit,
} = require('../server');

test('every body the page sends is accepted', () => {
  for (const q of ['max', '1080', '720', '480', '360', '240', '144']) {
    const r = validateDownloadOptions({ url: 'x', downloadMode: 'auto', videoQuality: q, filenameStyle: 'pretty' });
    assert.equal(r.options.videoQuality, q);
    assert.equal(r.options.downloadMode, 'auto');
  }
  for (const b of ['320', '256', '128', '96']) {
    const r = validateDownloadOptions({ url: 'x', downloadMode: 'audio', audioFormat: 'mp3', audioBitrate: b });
    assert.deepEqual(r.options, { downloadMode: 'audio', videoQuality: '1080', audioFormat: 'mp3', audioBitrate: b });
  }
});

test('absent or null options take the documented defaults; integers are accepted', () => {
  assert.deepEqual(validateDownloadOptions({}).options,
    { downloadMode: 'auto', videoQuality: '1080', audioFormat: 'mp3', audioBitrate: '128' });
  assert.deepEqual(validateDownloadOptions({ videoQuality: null, audioBitrate: 320 }).options,
    { downloadMode: 'auto', videoQuality: '1080', audioFormat: 'mp3', audioBitrate: '320' });
  assert.ok(validateDownloadOptions(undefined).options);
});

test('anything outside the allow-lists is refused with the field name', () => {
  for (const [field, v] of [
    ['audioBitrate', '128\0--exec'], ['audioBitrate', '128K'], ['audioBitrate', 1.5], ['audioBitrate', ['128']],
    ['videoQuality', '1080p'], ['videoQuality', 'best'], ['videoQuality', {}],
    ['downloadMode', 'video'], ['audioFormat', 'wav'], ['audioFormat', true],
  ]) assert.deepEqual(validateDownloadOptions({ [field]: v }), { error: 'invalid_option', field }, `${field}=${String(v)}`);
});

test('yt-dlp argv: --ignore-config first, -- right before the URL', () => {
  const a = ytdlpArgs(['-j', '--no-playlist'], '-https://x');
  assert.equal(a[0], '--ignore-config');
  assert.deepEqual(a.slice(-2), ['--', '-https://x']);
});

test('absolute paths are scrubbed, URLs and messages kept', () => {
  assert.equal(scrubPaths("ERROR: unable to open for writing: [Errno 13] Permission denied: '/tmp/ytdl-0123.mp4.part'"),
    "ERROR: unable to open for writing: [Errno 13] Permission denied: '<path>'");
  assert.equal(scrubPaths('cookies file /opt/office-tools/yt-server/cookies.txt is invalid'),
    'cookies file <path> is invalid');
  assert.equal(scrubPaths('bad cookie file:/opt/x/cookies.txt'), 'bad cookie file:<path>');
  assert.equal(scrubPaths('spawn C:\\tools\\yt-dlp.exe ENOENT'), 'spawn <path> ENOENT');
  const bot = "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies.";
  assert.equal(scrubPaths(bot), bot);
  assert.equal(scrubPaths('Video unavailable. 1/2 done'), 'Video unavailable. 1/2 done');
});

test('temp-file matcher takes only ytdl-<32 hex> names, and only the given job', () => {
  const id = '0123456789abcdef0123456789abcdef';
  const other = 'ffffffffffffffffffffffffffffffff';
  for (const n of [`ytdl-${id}.mp4`, `ytdl-${id}.mp4.part`, `ytdl-${id}.f137.mp4`, `ytdl-${id}.mp4.ytdl`,
    `ytdl-${id}.temp.mp4`, `ytdl-${id}.mp3`, `ytdl-${id}`]) {
    assert.ok(isJobTempFile(n, id), n);
    assert.ok(isJobTempFile(n), n);
    assert.ok(!isJobTempFile(n, other), n);
  }
  for (const n of ['ytdl-abc.mp4', `ytdl-${id}0.mp4`, `ytdl-${id.toUpperCase()}.mp4`, `x-ytdl-${id}.mp4`,
    `ytdl_${id}.mp4`, 'cookies.txt', '.', '..', `ytdl-${id.slice(1)}.mp4`]) {
    assert.ok(!isJobTempFile(n), n);
  }
  assert.ok(!isJobTempFile(`ytdl-${id}.mp4`, ''));
  assert.ok(!isJobTempFile(`ytdl-${id}.mp4`, '../x'));
});

test('rate key: IPv4 as-is, IPv6 by /64', () => {
  assert.equal(rateKey('203.0.113.7'), '203.0.113.7');
  assert.equal(rateKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(rateKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(rateKey('2001:db8:1:2::ffff'), '2001:db8:1:2::/64');
  assert.equal(rateKey('2001:DB8:0001:0002:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(rateKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(rateKey('::1'), '0:0:0:0::/64');
  assert.equal(rateKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(rateKey('64:ff9b::192.0.2.1'), '64:ff9b:0:0::/64');
  assert.equal(rateKey(undefined), 'unknown');
});

test('live, upcoming and over-long videos are refused before download', () => {
  assert.match(infoRefusal({ is_live: true }, 14400), /Live streams/);
  assert.match(infoRefusal({ live_status: 'is_live' }, 14400), /Live streams/);
  assert.match(infoRefusal({ live_status: 'is_upcoming' }, 14400), /not started/);
  assert.match(infoRefusal({ duration: 14401 }, 14400), /4 hours/);
  assert.equal(infoRefusal({ duration: 14400, live_status: 'not_live' }, 14400), null);
  assert.equal(infoRefusal({ duration: 99999, live_status: 'was_live' }, 0), null);
  assert.equal(infoRefusal({ title: 'no duration' }, 14400), null);
  assert.equal(infoRefusal(null, 14400), null);
});

test('MAX_FILESIZE parsing', () => {
  assert.equal(parseFilesizeLimit(undefined), '4G');
  assert.equal(parseFilesizeLimit(''), '4G');
  assert.equal(parseFilesizeLimit('500M'), '500M');
  assert.equal(parseFilesizeLimit('1.5g'), '1.5g');
  assert.equal(parseFilesizeLimit('0'), '');
  assert.equal(parseFilesizeLimit('none'), '');
  assert.equal(parseFilesizeLimit('4 GB; rm'), '4G');
});
