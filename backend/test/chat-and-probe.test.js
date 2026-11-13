'use strict';

// Chat-room upload tokens (lib/chat-upload-token.js) and the port checker's
// PROBE_SELF_PORTS exception (lib/outbound-guards.js parsePortList / selfProbeAllowed +
// lib/safe-fetch.js resolvePublicTarget `allowSelf`). resolvePublicTarget only resolves,
// it never connects, so public literals and a fake resolver are safe here.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { newUploadToken, findMemberByToken } = require('../lib/chat-upload-token');
const { parsePortList, selfProbeAllowed } = require('../lib/outbound-guards');
const { makeSelfAddresses, createSafeFetcher } = require('../lib/safe-fetch');

describe('chat upload token', () => {
  // Mirrors the server: a member entry carries uploadToken while it is in a room, and
  // leaving (or the room closing) sets it to null and removes it from room.members.
  function makeRoom() { return { members: new Map() }; }
  function join(room, id, name) {
    const c = { id, name, uploadToken: newUploadToken() };
    room.members.set(id, c);
    return c;
  }
  function leave(room, c) { room.members.delete(c.id); c.uploadToken = null; }

  test('tokens are URL-safe, at least 128 bits, and distinct', () => {
    const a = newUploadToken(), b = newUploadToken();
    assert.match(a, /^[A-Za-z0-9_-]+$/);
    assert.ok(Buffer.from(a, 'base64url').length >= 16);
    assert.notEqual(a, b);
  });

  test('a token is issued on create and on join, and matches only its member', () => {
    const room = makeRoom();
    const creator = join(room, 'c1', 'Alex');
    const joiner  = join(room, 'c2', 'Sam');
    assert.ok(creator.uploadToken && joiner.uploadToken);
    assert.equal(findMemberByToken(room.members.values(), creator.uploadToken), creator);
    assert.equal(findMemberByToken(room.members.values(), joiner.uploadToken).name, 'Sam');
  });

  test('missing, malformed or wrong token → no member', () => {
    const room = makeRoom();
    join(room, 'c1', 'Alex');
    for (const t of [undefined, null, '', 'short', 'x'.repeat(200), 'has space in it 1234', ['a'], newUploadToken()]) {
      assert.equal(findMemberByToken(room.members.values(), t), null, String(t));
    }
  });

  test('a token from another room does not open this one', () => {
    const r1 = makeRoom(), r2 = makeRoom();
    const m = join(r1, 'c1', 'Alex');
    join(r2, 'c2', 'Sam');
    assert.equal(findMemberByToken(r2.members.values(), m.uploadToken), null);
  });

  test('the token is invalid after leave, and a rejoin gets a fresh one', () => {
    const room = makeRoom();
    const m = join(room, 'c1', 'Alex');
    const old = m.uploadToken;
    leave(room, m);
    assert.equal(findMemberByToken(room.members.values(), old), null);
    const again = join(room, 'c1', 'Alex');
    assert.notEqual(again.uploadToken, old);
    assert.equal(findMemberByToken(room.members.values(), old), null);
    assert.equal(findMemberByToken(room.members.values(), again.uploadToken), again);
  });
});

describe('PROBE_SELF_PORTS', () => {
  test('parsePortList keeps only whole ports 1–65535', () => {
    assert.deepEqual([...parsePortList('')], []);
    assert.deepEqual([...parsePortList(undefined)], []);
    assert.deepEqual([...parsePortList(' 3416, 13416 ,3416')], [3416, 13416]);
    assert.deepEqual([...parsePortList('0,65536,abc,34.5,-1,80x,22')], [22]);
  });

  test('selfProbeAllowed: every requested port must be listed', () => {
    const listed = parsePortList('3416,13416');
    assert.equal(selfProbeAllowed([3416], parsePortList('')), false);
    assert.equal(selfProbeAllowed([3416], listed), true);
    assert.equal(selfProbeAllowed([3416, 13416], listed), true);
    assert.equal(selfProbeAllowed([22], listed), false);
    assert.equal(selfProbeAllowed([3416, 22], listed), false);
    assert.equal(selfProbeAllowed([], listed), false);
  });

  const SELF = '93.184.215.14';
  const self = makeSelfAddresses({ interfaces: () => ({ eth0: [{ address: SELF }] }), extra: '', refreshMs: 0 });
  const DNS = {
    'own.test':  [{ address: SELF, family: 4 }],
    'priv.test': [{ address: '10.0.0.5', family: 4 }],
  };
  const resolve = (h, o, cb) => setImmediate(() => DNS[h] ? cb(null, DNS[h]) : cb(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })));
  const fx = createSafeFetcher({ isSelf: ip => self.has(ip), resolve });
  // What the portcheck routes do: allowSelf only when every port is listed.
  const probeTarget = (host, ports, listed) => fx.resolvePublicTarget(host, { allowSelf: selfProbeAllowed(ports, parsePortList(listed)) });

  test('default (empty list): own address refused', async () => {
    await assert.rejects(probeTarget(SELF, [3416], ''), { code: 'ERR_SSRF_BLOCKED' });
    await assert.rejects(probeTarget('own.test', [3416], ''), { code: 'ERR_SSRF_BLOCKED' });
  });

  test('listed port: own address allowed (literal and via DNS)', async () => {
    assert.equal(await probeTarget(SELF, [3416], '3416'), SELF);
    assert.equal(await probeTarget('own.test', [3416], '3416,13416'), SELF);
  });

  test('unlisted port and mixed batch: own address refused', async () => {
    await assert.rejects(probeTarget(SELF, [22], '3416'), { code: 'ERR_SSRF_BLOCKED' });
    await assert.rejects(probeTarget(SELF, [3416, 22], '3416'), { code: 'ERR_SSRF_BLOCKED' });
    assert.equal(await probeTarget(SELF, [3416, 13416], '3416,13416'), SELF);
  });

  test('a private / loopback / reserved address is never allowed, even on a listed port', async () => {
    for (const h of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'priv.test']) {
      await assert.rejects(probeTarget(h, [3416], '3416'), { code: 'ERR_SSRF_BLOCKED' }, h);
    }
    // the raw option too: allowSelf never widens the classifier
    await assert.rejects(fx.resolvePublicTarget('127.0.0.1', { allowSelf: true }), { code: 'ERR_SSRF_BLOCKED' });
  });

  test('other public targets are unaffected by the option', async () => {
    assert.equal(await probeTarget('1.1.1.1', [22], ''), '1.1.1.1');
    assert.equal(await probeTarget('1.1.1.1', [3416], '3416'), '1.1.1.1');
  });
});
