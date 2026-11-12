'use strict';

// Shared per-IP fixed-window rate limiter.
//
// One fixed-window counter, defined once for every route instead of a
// hand-rolled map per route.
//
//   const lim = makeRateLimiter({ windowMs: 60_000, max: 15, message: '…' });
//   app.get('/x', lim.middleware, handler);   // → 429 { error: message } when over
//   if (!lim.allow(key)) …                     // inline form with a caller-chosen key
//   if (lim.blocked(key)) …                    // already over the limit? (does not count)
//
// The middleware keys on rateKey(clientIp(req)) (lib/client-ip.js): the visitor's IPv4
// address, or the /64 of an IPv6 one. Inline callers pass a key built the same way.
//
// Memory bound: at most `maxKeys` buckets (default 50 000). When a new key arrives at
// the cap, expired buckets are swept first; if the map is still full the OLDEST bucket
// is evicted. Evicting (fail-open) rather than refusing new keys (fail-closed) is
// deliberate: anyone able to present 50 000 distinct keys inside one window already
// has 50 000 fresh quotas, so eviction gives them nothing extra — whereas refusing
// new keys would let that same flood lock every other visitor out for a full window.

const { clientIp, rateKey } = require('./client-ip');

const DEFAULT_MAX_KEYS = 50_000;

function makeRateLimiter({ windowMs, max, message = 'Rate limit exceeded. Please wait.', maxKeys = DEFAULT_MAX_KEYS }) {
  const map = new Map();

  function sweep(now = Date.now()) {
    for (const [k, v] of map) if (now > v.resetAt) map.delete(k);
  }
  // Prune expired buckets every 5 min; unref'd so it never keeps the process (or a test) alive.
  const timer = setInterval(() => sweep(), 300_000);
  timer.unref?.();

  function allow(key) {
    const k = String(key || 'unknown');
    const now = Date.now();
    let e = map.get(k);
    if (e && now > e.resetAt) e = null;
    if (!e) {
      if (!map.has(k) && map.size >= maxKeys) {
        sweep(now);
        while (map.size >= maxKeys) map.delete(map.keys().next().value);
      }
      e = { count: 0, resetAt: now + windowMs };
      map.set(k, e);
    }
    e.count++;
    return e.count <= max;
  }

  function blocked(key) {
    const e = map.get(String(key || 'unknown'));
    return !!e && Date.now() <= e.resetAt && e.count >= max;
  }

  function middleware(req, res, next) {
    if (!allow(rateKey(clientIp(req)))) return res.status(429).json({ error: message });
    next();
  }

  return { allow, blocked, middleware, map, sweep };
}

module.exports = { makeRateLimiter };
