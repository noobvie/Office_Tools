'use strict';

// Server-issued "a + b = ?" challenge for the create forms (short URL, paste, file
// share) and the feedback box.
//
//   const cap = makeCaptcha();
//   GET  /api/captcha  → cap.issue()            → { a, b, token }
//   POST …             → cap.verify(ans, token) → 'ok' | 'bad' | 'missing'
//
// The token is opaque to the page: base64url("<expiry-ms>.<nonce>.<mac>") where
// mac = HMAC-SHA256(secret, "<answer>.<expiry-ms>.<nonce>"). The answer is never in
// the token, so the page must actually show a and b to a person. The secret is random
// per process: a restart invalidates challenges still on screen (the visitor is told
// the answer was wrong or expired and gets a fresh one).
//
// Single use: a nonce that verified once is remembered until its expiry, so a solved
// token cannot be replayed. That memory is bounded (`maxUsed`); when it is full of
// unexpired nonces, verification fails closed ('bad') rather than forgetting one —
// reaching the bound needs that many SOLVED challenges inside one TTL, and every route
// that verifies sits behind a per-IP create limit.

const crypto = require('crypto');

const TTL_MS = 10 * 60_000;

function makeCaptcha({ ttlMs = TTL_MS, maxUsed = 100_000, secret = crypto.randomBytes(32), now = Date.now } = {}) {
  const used = new Map();   // nonce → expiry ms

  function mac(answer, exp, nonce) {
    return crypto.createHmac('sha256', secret).update(`${answer}.${exp}.${nonce}`).digest();
  }

  function issue() {
    const a = crypto.randomInt(1, 10);
    const b = crypto.randomInt(1, 10);
    const exp = now() + ttlMs;
    const nonce = crypto.randomBytes(12).toString('base64url');
    const token = Buffer.from(`${exp}.${nonce}.${mac(a + b, exp, nonce).toString('base64url')}`)
      .toString('base64url');
    return { a, b, token };
  }

  function sweep(t = now()) {
    for (const [n, exp] of used) if (exp <= t) used.delete(n);
  }

  // `ans` arrives as a JSON number or a (multipart / JSON) string.
  function parseAnswer(ans) {
    if (typeof ans === 'number') return Number.isInteger(ans) && ans >= 0 && ans < 1000 ? ans : null;
    if (typeof ans === 'string' && /^\s*\d{1,3}\s*$/.test(ans)) return parseInt(ans, 10);
    return null;
  }

  function verify(ans, token) {
    if (token === undefined || token === null || token === '') return 'missing';
    if (typeof token !== 'string' || token.length > 256) return 'bad';
    const answer = parseAnswer(ans);
    if (answer === null) return 'bad';

    let parts;
    try { parts = Buffer.from(token, 'base64url').toString('utf8').split('.'); }
    catch { return 'bad'; }
    if (parts.length !== 3) return 'bad';
    const [expStr, nonce, macStr] = parts;
    if (!/^\d{1,16}$/.test(expStr) || !/^[A-Za-z0-9_-]{8,32}$/.test(nonce)) return 'bad';
    const exp = Number(expStr);
    const t = now();
    if (exp <= t || exp > t + ttlMs) return 'bad';

    const given = Buffer.from(macStr, 'base64url');
    const want = mac(answer, exp, nonce);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return 'bad';

    if (used.has(nonce)) return 'bad';
    if (used.size >= maxUsed) {
      sweep(t);
      if (used.size >= maxUsed) return 'bad';
    }
    used.set(nonce, exp);
    return 'ok';
  }

  // Expired nonces are useless (the token is rejected on expiry anyway) — drop them.
  const timer = setInterval(() => sweep(), 60_000);
  timer.unref?.();

  return { issue, verify, sweep, used };
}

// The two failure bodies the pages understand (js/common.js keys on `code`).
const CAPTCHA_ERRORS = {
  bad:     { error: 'Incorrect or expired answer to the math question. Please try again.', code: 'captcha' },
  missing: { error: 'Please reload this page (Ctrl+F5) and try again.', code: 'captcha_reload' },
};

module.exports = { makeCaptcha, CAPTCHA_ERRORS, CAPTCHA_TTL_MS: TTL_MS };
