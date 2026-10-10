'use strict';

// GET /api/net/redirects?url= — the URL Expander's handler, kept out of
// office-tools-server.js so the tests can drive it without app.listen. The server
// mounts it behind its own rate limiter; this module owns the input checks, the
// global in-flight cap and the client-disconnect abort.
//
//   const { makeRedirectsHandler } = require('./lib/redirects-route');
//   const redirects = makeRedirectsHandler();             // the real safe-fetch policy
//   app.get('/api/net/redirects', redirectRL.middleware, redirects);
//
// Test seam: makeRedirectsHandler({ fetcher }) takes a createSafeFetcher() instance,
// the same D7 seam the lib's own tests use. There is no switch that turns the guard off.
//
// Response (200): { input, start, hops[], final|null, stop, stopDetail|null,
// jsRedirectHint|null, totalMs } — traceRedirects' result with `input` first. Facts
// only: every warning flag is the page's job. A public URL that redirects somewhere
// private is a 200 with stop:'blocked' (the hops up to the refusal are the answer); a
// private INPUT is a 403, because nothing was fetched at all.
// Errors: 400 { error } bad input, 403 { error, url } private input, 503 { error:'busy' }
// past the in-flight cap. Request URLs are never logged.

const net = require('net');
const safeFetch = require('./safe-fetch');

const MAX_INPUT = 2048;

function makeRedirectsHandler({ fetcher = safeFetch, maxInFlight = 16, traceOpts = {} } = {}) {
  let inFlight = 0;

  async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const q = req.query?.url;
    if (Array.isArray(q)) return res.status(400).json({ error: 'Give one url' });
    const raw = String(q ?? '').trim();
    if (!raw) return res.status(400).json({ error: 'Missing url' });
    if (raw.length > MAX_INPUT) return res.status(400).json({ error: `URL too long (max ${MAX_INPUT} characters)` });

    let url;
    try { ({ url } = safeFetch.normalizeUserUrl(raw)); }
    catch (e) { return res.status(400).json({ error: e?.message || 'Invalid URL' }); }

    // The one limit a spoofed X-Forwarded-For cannot get round (the per-IP limiter can).
    if (inFlight >= maxInFlight) return res.status(503).json({ error: 'busy' });
    inFlight++;
    // 'close' before the response was written = the client disconnected, so the trace
    // (up to 25 s of outbound requests) is abandoned. On Node 24 req and res 'close' both
    // fire only then (measured); res is used because writableEnded is the test that matters.
    const ac = new AbortController();
    const onClose = () => { if (!res.writableEnded) ac.abort(); };
    res.on('close', onClose);
    try {
      let t;
      try { t = await fetcher.traceRedirects(url, { ...traceOpts, signal: ac.signal }); }
      catch (e) {
        if (e?.code === 'ERR_ABORTED') return;           // client gone: nothing to send
        return res.status(500).json({ error: 'Trace failed' });
      }
      if (ac.signal.aborted) return;
      if (t.stop === 'blocked' && t.hops.length === 0) {
        const literal = net.isIP(url.hostname.replace(/^\[|\]$/g, ''));
        return res.status(403).json({
          error: literal ? 'Refusing to fetch a private / internal address'
                         : 'Host resolves to a private / internal address',
          url: url.href,
        });
      }
      return res.json({ input: raw, ...t });
    } finally {
      inFlight--;
      res.off('close', onClose);
    }
  }

  handler.inFlight = () => inFlight;
  return handler;
}

module.exports = { makeRedirectsHandler, MAX_INPUT };
