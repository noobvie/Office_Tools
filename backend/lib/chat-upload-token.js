'use strict';

// Chat-room upload tokens. A member gets one when it joins a room (create, join, or a
// rejoin after a reconnect) inside the `joined` message, and the upload route accepts a
// file only with the token of a CURRENT member of that room. The room code alone is
// shared by link, so it cannot be what authorises writing files to the server's disk.
// A token lives on the member's entry and dies with the membership (leave, disconnect,
// room closed).

const crypto = require('crypto');

// 24 random bytes → 32 URL-safe characters (192 bits).
function newUploadToken() {
  return crypto.randomBytes(24).toString('base64url');
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

// members: iterable of member entries carrying `uploadToken`. → the member whose token
// equals `token`, else null. Every candidate is compared in constant time.
function findMemberByToken(members, token) {
  const t = typeof token === 'string' ? token : '';
  if (!TOKEN_RE.test(t)) return null;
  const want = Buffer.from(t);
  let found = null;
  for (const m of members || []) {
    const have = typeof m?.uploadToken === 'string' ? Buffer.from(m.uploadToken) : null;
    if (have && have.length === want.length && crypto.timingSafeEqual(have, want) && !found) found = m;
  }
  return found;
}

module.exports = { newUploadToken, findMemberByToken };
