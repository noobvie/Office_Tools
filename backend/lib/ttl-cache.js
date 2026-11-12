'use strict';

// Bounded in-memory TTL cache (Map insertion order = age order).
//
//   const c = makeTtlCache({ ttlMs: 3_600_000, maxEntries: 5000 });
//   c.get(k) → value | null      c.set(k, v)
//
// At `maxEntries` the oldest entry is evicted; expired entries are dropped on read
// and by a periodic sweep (unref'd, so it never keeps the process alive).

function makeTtlCache({ ttlMs, maxEntries = 5000, sweepMs = 600_000 }) {
  const map = new Map();

  function get(k) {
    const e = map.get(k);
    if (!e) return null;
    if (Date.now() - e.ts > ttlMs) { map.delete(k); return null; }
    return e.d;
  }

  function set(k, d) {
    map.delete(k);                      // re-insert at the young end
    while (map.size >= maxEntries) map.delete(map.keys().next().value);
    map.set(k, { d, ts: Date.now() });
  }

  function sweep() {
    const now = Date.now();
    for (const [k, e] of map) {
      if (now - e.ts > ttlMs) map.delete(k);
      else break;                       // insertion order = age order: the rest are younger
    }
  }

  const timer = setInterval(sweep, sweepMs);
  timer.unref?.();

  return { get, set, sweep, map };
}

module.exports = { makeTtlCache };
