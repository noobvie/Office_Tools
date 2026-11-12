'use strict';

// Small load guards shared by the outbound routes (proxy, uptime, ping, traceroute,
// portcheck, ai-suggest). Every limit here is GLOBAL, i.e. the one limit a visitor cannot
// get round by changing address — the per-IP limiters (lib/rate-limit.js) stay in front.
//
//   const proxySlots = makeInFlight(128);
//   const release = proxySlots.tryAcquire();       // null when full → answer 503
//   try { … } finally { release(); }               // release is idempotent
//
//   const sockets = makeSemaphore({ max: 256, maxQueue: 1024 });
//   if (!sockets.canQueue(n)) → 503;  const release = await sockets.acquire();
//
//   const gone = watchClientClose(res);            // before the first await
//   gone.signal → AbortSignal for the outbound call; gone.closed() → client left; gone.dispose()
//
//   const budget = makeDailyBudget(500);           // budget.take() → false once spent (UTC day)
//
//   takeMany(limiter, key, n)                      // n hits on a makeRateLimiter bucket
//
//   proxySelfBase(req, origins)                    // validated `self` for /api/net/proxy

// At most `max` holders at once; tryAcquire() never waits.
function makeInFlight(max) {
  let n = 0;
  function tryAcquire() {
    if (n >= max) return null;
    n++;
    let done = false;
    return () => { if (!done) { done = true; n--; } };
  }
  return { tryAcquire, count: () => n, max };
}

// At most `max` holders; further acquire() calls wait in FIFO order. canQueue(k) says
// whether k more waiters would still fit under `maxQueue`, so a caller can refuse a whole
// request up front instead of half-running it.
function makeSemaphore({ max, maxQueue = Infinity }) {
  let n = 0;
  const waiters = [];
  function grant() {
    n++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      n--;
      const next = waiters.shift();
      if (next) next(grant());
    };
  }
  function acquire() {
    if (n < max) return Promise.resolve(grant());
    return new Promise(resolve => waiters.push(resolve));
  }
  function canQueue(k) {
    const free = Math.max(0, max - n);
    return waiters.length + Math.max(0, k - free) <= maxQueue;
  }
  return { acquire, canQueue, active: () => n, queued: () => waiters.length, max, maxQueue };
}

// 'close' before the response was written = the client disconnected (on Node 24 both
// req and res 'close' fire only then; res is used because writableEnded is the test that
// matters). Register it BEFORE the first await, so a client that leaves during DNS
// resolution is seen too.
function watchClientClose(res) {
  const ac = new AbortController();
  const onClose = () => { if (!res.writableEnded) ac.abort(); };
  res.on('close', onClose);
  return {
    signal: ac.signal,
    closed: () => ac.signal.aborted,
    dispose: () => res.off('close', onClose),
  };
}

// A counter that resets at 00:00 UTC.
function makeDailyBudget(max, now = () => Date.now()) {
  let day = '', used = 0;
  function roll() {
    const d = new Date(now()).toISOString().slice(0, 10);
    if (d !== day) { day = d; used = 0; }
  }
  function take() {
    roll();
    if (used >= max) return false;
    used++;
    return true;
  }
  return { take, used: () => { roll(); return used; }, max };
}

// Count n hits on one makeRateLimiter() bucket. true when all n fit. A key already over
// the limit is refused without counting further, so a refused caller does not extend the
// cost to others.
function takeMany(limiter, key, n) {
  if (limiter.blocked(key)) return false;
  let ok = true;
  for (let i = 0; i < n; i++) ok = limiter.allow(key) && ok;
  return ok;
}

// /api/net/proxy rewrites every link of a page to `${self}?url=…`, so `self` decides where
// a visitor's clicks go. tools/web-proxy sends its own public endpoint
// (`${API_SERVER_URL}/api/net/proxy`, e.g. https://tools.grin.money/tools-api/api/net/proxy).
// It is accepted only when it parses as an http(s) URL whose origin is one of the site's
// CORS origins or this request's own host, whose path ends in /api/net/proxy, and which
// carries no query, fragment, credentials, quotes, angle brackets or whitespace.
// Anything else gets the server-derived value.
function proxySelfBase(req, origins) {
  const host = String(req.get?.('host') || req.headers?.host || '');
  const fallback = `${req.headers?.['x-forwarded-proto'] || req.protocol}://${host}/api/net/proxy`;
  const raw = req.query?.self;
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  if (!s || s.length > 512 || /["'<>`\\\s]/.test(s)) return fallback;
  let u;
  try { u = new URL(s); } catch { return fallback; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return fallback;
  if (u.username || u.password || u.search || u.hash || s.includes('?') || s.includes('#')) return fallback;
  if (!/\/api\/net\/proxy$/.test(u.pathname)) return fallback;
  const okOrigin = (origins || []).includes(u.origin) || (!!host && u.host.toLowerCase() === host.toLowerCase());
  return okOrigin ? u.origin + u.pathname : fallback;
}

module.exports = { makeInFlight, makeSemaphore, watchClientClose, makeDailyBudget, takeMany, proxySelfBase };
