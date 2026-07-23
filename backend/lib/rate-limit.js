'use strict';

// Shared per-IP fixed-window rate limiter.
//
// Replaces the ~9 hand-rolled `_xxxRateMap` / `_xxxAllow` / `xxxRLMiddleware`
// triples that used to be copy-pasted through office-tools-server.js — identical
// fixed-window-counter behaviour, defined once.
//
//   const lim = makeRateLimiter({ windowMs: 60_000, max: 15, message: '…' });
//   app.get('/x', lim.middleware, handler);   // → 429 { error: message } when over
//   if (!lim.allow(ip)) …                      // inline form with a caller-chosen key

// Client IP = first X-Forwarded-For hop (nginx / Cloudflare), else the socket
// address. Matches the key every former limiter used ('' vs 'unknown' fallbacks
// were equivalent — each limiter has its own map, so no-IP requests only ever
// collapse into one bucket within that single limiter).
function rateLimitIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress || 'unknown';
}

function makeRateLimiter({ windowMs, max, message = 'Rate limit exceeded. Please wait.' }) {
  const map = new Map();
  // Prune expired buckets every 5 min (same cadence as the originals).
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of map) if (now > v.resetAt) map.delete(k);
  }, 300_000);

  function allow(ip) {
    const now = Date.now();
    let e = map.get(ip);
    if (!e || now > e.resetAt) e = { count: 0, resetAt: now + windowMs };
    e.count++;
    map.set(ip, e);
    return e.count <= max;
  }

  function middleware(req, res, next) {
    if (!allow(rateLimitIp(req))) return res.status(429).json({ error: message });
    next();
  }

  return { allow, middleware, map };
}

module.exports = { makeRateLimiter, rateLimitIp };
