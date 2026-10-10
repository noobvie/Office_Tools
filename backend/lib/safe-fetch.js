'use strict';

// SSRF-safe outbound HTTP for every server-side request to a USER-INFLUENCED address.
//
// The rule: an address is validated at CONNECT time, on the exact answer the socket
// connects to. A check-then-fetch pair (resolve, validate, then let fetch() resolve
// again) leaves a DNS-rebinding window, and `redirect: 'follow'` skips the check on
// every hop after the first. Here every hop is a separate request through the guard.
//
//   const sf = require('./lib/safe-fetch');
//   const { url } = sf.normalizeUserUrl(req.query.url);       // throws SafeFetchError (400)
//   const r = await sf.safeRequest(url, { maxBytes: 12 << 20 });  // one hop, no redirects
//   const f = await sf.fetchFollow(url, { maxBytes: 12 << 20 });  // 3xx followed, each hop guarded
//   const t = await sf.traceRedirects(url);                     // every hop, validated
//   const cert = await sf.certInfo(t.final.url, t.final.ip);    // TLS to the PINNED ip
//
// Traps this module exists to handle (each has a test in test/safe-fetch.test.js):
// - An IP-literal host never calls `lookup`, so literals are classified before the request.
// - With autoSelectFamily (default since Node 20) `lookup` is called with {all:true} and
//   must answer with an array; without it, (err, address, family). Both are honoured.
// - node:http does not decompress. The byte cap applies to DECODED bytes, or a 10 KB gzip
//   bomb becomes gigabytes in memory.
// - net.BlockList matches ::ffff:a.b.c.d against IPv4 rules, and ALSO matches every
//   plain IPv4 address against a ::ffff:0:0/96 IPv6 rule. Embedded IPv4 (mapped, NAT64,
//   6to4) is therefore decoded explicitly and the mapped prefix is never put in a list.
//
// Test seam: createSafeFetcher({ classify, resolve }). A test widens `classify` to allow
// its own fixture port; there is deliberately NO env var or global that turns the guard off.

const net   = require('net');
const dns   = require('dns');
const http  = require('http');
const https = require('https');
const tls   = require('tls');
const zlib  = require('zlib');

const PROXY_UA = 'Mozilla/5.0 (X11; Linux x86_64; OfficeToolsProxy/1.0; +https://tools.grin.money)';

class SafeFetchError extends Error {
  constructor(code, message, url) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
    if (url) this.url = url;
  }
}

// ── IP classification ─────────────────────────────────────────

const V4_BLOCK = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],   // 240/4 includes 255.255.255.255
]) V4_BLOCK.addSubnet(addr, prefix, 'ipv4');

// Second layer for IPv6. The primary rule (below) only admits global unicast 2000::/3,
// which already excludes most of these; the list keeps the D3 ranges explicit.
// NEVER add ::ffff:0:0/96 here — see the BlockList note in the header.
const V6_BLOCK = new net.BlockList();
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['2001::', 32], ['2001:db8::', 32],
  ['100::', 64], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) V6_BLOCK.addSubnet(addr, prefix, 'ipv6');

function _bare(host) { return String(host || '').replace(/^\[|\]$/g, ''); }

// 16 bytes for a string net.isIPv6() already accepted (no zone id).
function _v6Bytes(ip) {
  let s = ip.toLowerCase();
  const tail = [];
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : [];
  const r = rest !== undefined ? (rest ? rest.split(':') : []) : null;
  const groups = r === null ? h : [...h, ...Array(8 - h.length - r.length).fill('0'), ...r];
  for (const g of groups) { const n = parseInt(g, 16); tail.push(n >> 8, n & 0xff); }
  return tail;
}

function _v4Public(a, b, c, d) { return !V4_BLOCK.check(`${a}.${b}.${c}.${d}`, 'ipv4'); }

// true only for an address it is safe to fetch from server-side. Anything that is not a
// canonical IP literal (a hostname, '127.1', a zone id) is NOT public.
function isPublicIp(ip) {
  const s = _bare(ip);
  if (s.includes('%')) return false;                       // zone id: link-scoped by definition
  if (net.isIPv4(s)) return !V4_BLOCK.check(s, 'ipv4');
  if (!net.isIPv6(s)) return false;
  if (V6_BLOCK.check(s, 'ipv6')) return false;
  const b = _v6Bytes(s);
  const w = i => (b[i] << 8) | b[i + 1];
  if (b.slice(0, 10).every(x => x === 0)) {
    // ::ffff:0:0/96 mapped → IPv4 rules. Everything else in ::/80 (::, ::1, deprecated
    // IPv4-compatible ::a.b.c.d, SIIT) is refused.
    return w(10) === 0xffff && _v4Public(b[12], b[13], b[14], b[15]);
  }
  if (w(0) === 0x0064 && w(2) === 0xff9b) {
    // NAT64 well-known 64:ff9b::/96 → embedded IPv4. Any other 64:ff9b::/32 address,
    // including local-use 64:ff9b:1::/48 (prefix length is operator-chosen, so the
    // embedded address cannot be located reliably), is refused.
    return w(4) === 0 && w(6) === 0 && w(8) === 0 && w(10) === 0 && _v4Public(b[12], b[13], b[14], b[15]);
  }
  if ((b[0] & 0xe0) !== 0x20) return false;                // only global unicast 2000::/3
  if (w(0) === 0x2002) return _v4Public(b[2], b[3], b[4], b[5]);   // 6to4 → embedded IPv4
  return true;
}

// ── URL normalisation ─────────────────────────────────────────

// User text → { url: URL (http/https, userinfo removed), userinfo: '' | 'user[:pw]' }.
// Scheme-less input gets https://. WHATWG URL canonicalises every IPv4 spelling
// (2130706433, 0x7f.1, 017700000001, 127.1 → 127.0.0.1) and backslashes, so the
// hostname that reaches the classifier is always canonical.
function normalizeUserUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new SafeFetchError('ERR_BAD_URL', 'Missing url');
  let withScheme;
  if (/^https?:/i.test(s)) withScheme = s;
  else if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) throw new SafeFetchError('ERR_UNSUPPORTED_PROTOCOL', 'Only http:// and https:// URLs are allowed');
  else withScheme = 'https://' + s.replace(/^[/\\]+/, '');
  let url;
  try { url = new URL(withScheme); } catch { throw new SafeFetchError('ERR_BAD_URL', 'Invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('ERR_UNSUPPORTED_PROTOCOL', 'Only http:// and https:// URLs are allowed');
  }
  if (!_bare(url.hostname)) throw new SafeFetchError('ERR_BAD_URL', 'Missing host in URL');
  const userinfo = _stripUserinfo(url);
  return { url, userinfo };
}

function _stripUserinfo(url) {
  if (!url.username && !url.password) return '';
  const info = url.password ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : decodeURIComponent(url.username);
  url.username = '';
  url.password = '';
  return info;
}

function _toUrl(input) {
  if (input instanceof URL) return new URL(input.href);
  try { return new URL(String(input)); } catch { throw new SafeFetchError('ERR_BAD_URL', 'Invalid URL'); }
}

// ── Redirect-trace parsing helpers (pure) ─────────────────────

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const SNIFF_BYTES = 64 * 1024;

function _decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => _cp(parseInt(h, 16), m))
    .replace(/&#(\d{1,7});/g, (m, d) => _cp(parseInt(d, 10), m))
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}
function _cp(n, fallback) { try { return String.fromCodePoint(n); } catch { return fallback; } }

// HTML "shared declarative refresh steps", used for both the Refresh header and
// <meta http-equiv=refresh content>. → { delay, url } (url '' = reload) or null.
function parseRefresh(value) {
  const WS = /^[\t\n\f\r ]+/;
  let s = String(value ?? '').replace(WS, '');
  if (!s) return null;
  const m = /^(\d*)[\d.]*/.exec(s);
  if (!m[1] && s[0] !== '.') return null;               // no time → not a refresh
  const delay = m[1] ? parseInt(m[1], 10) : 0;
  s = s.slice(m[0].length);
  if (s) {
    if (!/^[;,\t\n\f\r ]/.test(s)) return null;         // "5x" → not a refresh
    s = s.replace(WS, '');
    if (s[0] === ';' || s[0] === ',') s = s.slice(1);
    s = s.replace(WS, '');
  }
  let url = s;
  const kw = /^url[\t\n\f\r ]*=[\t\n\f\r ]*/i.exec(s);
  if (kw) url = s.slice(kw[0].length);
  if ((kw || !/^url/i.test(s)) && (url[0] === '"' || url[0] === "'")) {
    const q = url[0];
    const end = url.indexOf(q, 1);
    url = end === -1 ? url.slice(1) : url.slice(1, end);
  }
  return { delay, url: url.trim() };
}

function _attrs(tagInner) {
  const out = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(tagInner))) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = _decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

function _stripComments(html) { return html.replace(/<!--[\s\S]*?(?:-->|$)/g, ''); }

// First <meta http-equiv="refresh"> → parseRefresh() result, or null.
function findMetaRefresh(html) {
  const re = /<meta\b([^>]*)>/gi;
  let m;
  const text = _stripComments(html);
  while ((m = re.exec(text))) {
    const a = _attrs(m[1]);
    if ((a['http-equiv'] || '').trim().toLowerCase() === 'refresh' && 'content' in a) {
      const r = parseRefresh(a.content);
      if (r) return r;
    }
  }
  return null;
}

function findTitle(html) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(_stripComments(html));
  if (!m) return null;
  const t = _decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 300) : null;
}

// JavaScript is NEVER executed. A literal-URL redirect pattern is reported, not followed.
const JS_HINTS = [
  ['location.replace', /\blocation\s*\.\s*(?:replace|assign)\s*\(\s*(['"`])([^'"`\s]{1,2048})\1/i],
  ['location.href',    /\blocation(?:\s*\.\s*href)?\s*=\s*(['"`])([^'"`\s]{1,2048})\1/i],
  ['window.open',      /\bwindow\s*\.\s*open\s*\(\s*(['"`])([^'"`\s]{1,2048})\1/i],
];
function findJsRedirect(html, baseUrl) {
  let best = null;
  for (const [via, re] of JS_HINTS) {
    const m = re.exec(html);
    if (m && (!best || m.index < best.index)) best = { index: m.index, via, raw: m[2] };
  }
  if (!best) return null;
  let url = best.raw;
  try { url = new URL(best.raw, baseUrl).href; } catch { /* keep the literal */ }
  return { via: best.via, url };
}

function _charset(contentType, buf) {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || '');
  if (fromHeader) return fromHeader[1];
  const head = buf.subarray(0, 1024).toString('latin1');
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  return fromMeta ? fromMeta[1] : 'utf-8';
}
function _decodeText(buf, contentType) {
  try { return new TextDecoder(_charset(contentType, buf)).decode(buf); }
  catch { return new TextDecoder('utf-8').decode(buf); }
}

function _mime(ct) { return ct ? String(ct).split(';')[0].trim().toLowerCase() || null : null; }
function _isHtml(ct) { return /^(text\/html|application\/xhtml\+xml)$/.test(_mime(ct) || ''); }

const _ERR_TEXT = {
  ENOTFOUND: 'Could not resolve host',
  EAI_AGAIN: 'Could not resolve host (temporary DNS failure)',
  ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection reset',
  EHOSTUNREACH: 'Host unreachable',
  ENETUNREACH: 'Network unreachable',
  ERR_DECODE: 'Could not decode the compressed response',
  ERR_BAD_REDIRECT: 'Invalid redirect target',
};
// A short, safe description: an error code mapped to text, never a response body or a
// resolved internal address.
function _errText(err) {
  const code = err?.code || '';
  if (_ERR_TEXT[code]) return _ERR_TEXT[code];
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO|HOSTNAME|ALTNAME/i.test(code)) return `TLS certificate error (${code})`;
  if (code === 'HPE_HEADER_OVERFLOW') return 'Response headers too large';
  if (/^HPE_/.test(code)) return `Malformed HTTP response (${code})`;
  return code ? `Request failed (${code})` : 'Request failed';
}

// ── The fetcher ───────────────────────────────────────────────

// classify(ip, port) → true when the server may connect there. The default ignores the
//   port; a test passes `(ip, port) => (ip === '127.0.0.1' && port === FIXTURE) || isPublicIp(ip)`.
// resolve(hostname, { all: true, ... }, cb) — dns.lookup-compatible.
function createSafeFetcher({ classify = (ip) => isPublicIp(ip), resolve = dns.lookup, userAgent = PROXY_UA } = {}) {

  function _blocked(where) {
    return new SafeFetchError('ERR_SSRF_BLOCKED', 'Refusing to connect to a private / internal address', where);
  }

  function _makeLookup(port) {
    return function guardedLookup(hostname, options, cb) {
      if (typeof options === 'function') { cb = options; options = {}; }
      else if (typeof options === 'number') options = { family: options };
      else options = options || {};
      const wantAll = !!options.all;
      resolve(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err);
        if (!Array.isArray(addrs) || !addrs.length) {
          const e = new Error('Could not resolve host'); e.code = 'ENOTFOUND';
          return cb(e);
        }
        // ANY non-public address in the answer refuses the whole host: with Happy
        // Eyeballs the socket may try every address, so "pick a public one" is unsafe.
        if (addrs.some(a => !classify(a.address, port))) return cb(_blocked(hostname));
        if (wantAll) return cb(null, addrs);
        cb(null, addrs[0].address, addrs[0].family);
      });
    };
  }

  // dns.lookup-shaped guard for callers that open their own sockets.
  const guardedLookup = _makeLookup(undefined);

  // One request, no redirect following. Resolves
  //   { status, headers, body: Buffer|null, truncated, decoded, remoteAddress, remoteFamily, url }
  // readBody: boolean, or (status, headers) => boolean decided once headers arrive.
  // maxBytes caps DECODED bytes: over it → reject ERR_BODY_TOO_LARGE, or with
  // truncate:true resolve with the first maxBytes and truncated:true.
  // Rejects SafeFetchError: ERR_BAD_URL, ERR_UNSUPPORTED_PROTOCOL, ERR_SSRF_BLOCKED,
  // ERR_HOP_TIMEOUT, ERR_BODY_TOO_LARGE, ERR_DECODE, ERR_ABORTED; or a socket error (ECONN…).
  function safeRequest(input, {
    method = 'GET', headers = {}, timeoutMs = 8000, maxBytes = 1024 * 1024,
    readBody = true, truncate = false, signal,
  } = {}) {
    return new Promise((resolveP, rejectP) => {
      let url;
      try { url = _toUrl(input); } catch (e) { return rejectP(e); }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return rejectP(new SafeFetchError('ERR_UNSUPPORTED_PROTOCOL', 'Only http:// and https:// URLs are allowed', url.href));
      }
      _stripUserinfo(url);
      url.hash = '';
      const isHttps = url.protocol === 'https:';
      const host = _bare(url.hostname);
      const port = Number(url.port) || (isHttps ? 443 : 80);
      if (!host) return rejectP(new SafeFetchError('ERR_BAD_URL', 'Missing host in URL', url.href));
      // A literal never reaches `lookup` — classify it here or not at all.
      if (net.isIP(host) && !classify(host, port)) return rejectP(_blocked(url.href));
      if (signal?.aborted) return rejectP(new SafeFetchError('ERR_ABORTED', 'Request aborted', url.href));

      let req = null, res = null, decoder = null, timer = null, settled = false;
      const onAbort = () => fail(new SafeFetchError('ERR_ABORTED', 'Request aborted', url.href));
      function cleanup() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (decoder) decoder.destroy();
        if (res) res.destroy();
        if (req) req.destroy();
      }
      function fail(err) { if (settled) return; settled = true; cleanup(); rejectP(err); }
      function done(v) { if (settled) return; settled = true; cleanup(); resolveP(v); }

      timer = setTimeout(() => fail(new SafeFetchError('ERR_HOP_TIMEOUT', `No complete response within ${timeoutMs} ms`, url.href)), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });

      const h = {
        'User-Agent': userAgent,
        'Accept': '*/*',
        ...headers,
        'Accept-Encoding': 'gzip, deflate, br',   // only what we can decode
      };
      try {
        req = (isHttps ? https : http).request({
          protocol: url.protocol, hostname: host, port, method,
          path: url.pathname + url.search, headers: h,
          agent: false,                       // no socket shared across requests or users
          lookup: net.isIP(host) ? undefined : _makeLookup(port),
          maxHeaderSize: 16 * 1024,
          // TLS verification stays ON; SNI + cert check use `hostname`, lookup pins the IP.
        });
      } catch (e) { return fail(e); }

      req.on('error', fail);
      req.on('response', r => {
        res = r;
        const remoteAddress = r.socket?.remoteAddress ?? null;
        const remoteFamily = r.socket?.remoteFamily ?? null;
        const base = { status: r.statusCode, headers: r.headers, remoteAddress, remoteFamily, url: url.href };
        let want;
        try { want = typeof readBody === 'function' ? !!readBody(r.statusCode, r.headers) : !!readBody; }
        catch (e) { return fail(e); }
        if (!want) return done({ ...base, body: null, truncated: false, decoded: true });

        const enc = String(r.headers['content-encoding'] || '').trim().toLowerCase();
        let decoded = true;
        if (enc === 'gzip' || enc === 'x-gzip') decoder = zlib.createGunzip();
        else if (enc === 'deflate') decoder = zlib.createInflate();
        else if (enc === 'br') decoder = zlib.createBrotliDecompress();
        else if (enc && enc !== 'identity') decoded = false;   // unknown coding: raw bytes, still capped

        const clen = parseInt(r.headers['content-length'] || '', 10);
        if (!decoder && !truncate && Number.isFinite(clen) && clen > maxBytes) {
          return fail(new SafeFetchError('ERR_BODY_TOO_LARGE', `Response larger than ${maxBytes} bytes`, url.href));
        }

        const chunks = [];
        let total = 0;
        const src = decoder ? r.pipe(decoder) : r;
        r.on('error', fail);
        r.on('close', () => {
          if (!r.complete) fail(Object.assign(new Error('Connection closed before the body completed'), { code: 'ECONNRESET' }));
        });
        if (decoder) decoder.on('error', () => fail(new SafeFetchError('ERR_DECODE', 'Could not decode the compressed response', url.href)));
        src.on('data', c => {
          if (settled) return;
          total += c.length;
          if (total > maxBytes) {
            if (!truncate) return fail(new SafeFetchError('ERR_BODY_TOO_LARGE', `Response larger than ${maxBytes} bytes`, url.href));
            chunks.push(c.subarray(0, c.length - (total - maxBytes)));
            return done({ ...base, body: Buffer.concat(chunks), truncated: true, decoded });
          }
          chunks.push(c);
        });
        src.on('end', () => done({ ...base, body: Buffer.concat(chunks), truncated: false, decoded }));
      });
      req.end();
    });
  }

  // Follow a URL hop by hop (D4) and return the D5 contract minus `input`:
  //   { start, hops[], final|null, stop, stopDetail|null, jsRedirectHint|null, totalMs }
  // hops[] holds every response that pointed somewhere else. When stop !== 'final' the
  // last hop's `next` is the target that was NOT fetched (or, for 'blocked', refused).
  // `next` is reported as the server sent it (userinfo included); the request to it is
  // made with userinfo stripped. Rejects only on ERR_ABORTED (signal) or a bad input URL.
  async function traceRedirects(input, {
    maxHops = 10, hopTimeoutMs = 8000, totalTimeoutMs = 25000, signal,
  } = {}) {
    const startedAt = Date.now();
    let current = _toUrl(input);
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new SafeFetchError('ERR_UNSUPPORTED_PROTOCOL', 'Only http:// and https:// URLs are allowed', current.href);
    }
    _stripUserinfo(current);
    current.hash = '';
    const out = {
      start: current.href, hops: [], final: null, stop: 'final',
      stopDetail: null, jsRedirectHint: null, totalMs: 0,
    };
    const seen = new Set([current.href]);
    const finish = (stop, detail) => { out.stop = stop; out.stopDetail = detail ?? null; out.totalMs = Date.now() - startedAt; return out; };

    for (;;) {
      const remaining = totalTimeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) return finish('timeout', `${current.href} — total time limit (${Math.round(totalTimeoutMs / 1000)} s) reached, not fetched`);
      const hopBudget = Math.min(hopTimeoutMs, remaining);
      const hopStart = Date.now();
      let r;
      try {
        r = await safeRequest(current, {
          method: 'GET',
          headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
          timeoutMs: hopBudget, maxBytes: SNIFF_BYTES, truncate: true, signal,
          // A redirect's body is never read; neither is anything that is not HTML.
          readBody: (status, h) => {
            if (REDIRECT_CODES.has(status) && h.location) return false;
            const rf = h.refresh ? parseRefresh(h.refresh) : null;
            if (rf && rf.url) return false;
            return _isHtml(h['content-type']);
          },
        });
      } catch (e) {
        if (e?.code === 'ERR_ABORTED') throw e;
        if (e?.code === 'ERR_SSRF_BLOCKED') return finish('blocked', `${current.href} — private / internal address, not fetched`);
        if (e?.code === 'ERR_HOP_TIMEOUT') {
          const total = hopBudget < hopTimeoutMs;
          return finish('timeout', total
            ? `${current.href} — total time limit (${Math.round(totalTimeoutMs / 1000)} s) reached`
            : `${current.href} — no complete response within ${Math.round(hopTimeoutMs / 1000)} s`);
        }
        return finish('error', `${current.href} — ${_errText(e)}`);
      }
      const ms = Date.now() - hopStart;

      // Where does this response point?
      let kind = null, rawNext = null;
      if (REDIRECT_CODES.has(r.status) && r.headers.location) {
        kind = 'http'; rawNext = String(r.headers.location);
      } else {
        const rf = r.headers.refresh ? parseRefresh(r.headers.refresh) : null;
        if (rf && rf.url) { kind = 'refresh-header'; rawNext = rf.url; }
        else if (r.body && _isHtml(r.headers['content-type'])) {
          const html = _decodeText(r.body, r.headers['content-type']);
          const mr = findMetaRefresh(html);
          if (mr && mr.url) { kind = 'meta-refresh'; rawNext = mr.url; }
          r.html = html;
        }
      }

      let nextUrl = null;
      if (kind) {
        try { nextUrl = new URL(rawNext, current); } catch { nextUrl = null; }
        // A refresh that points back at this same page is a reload, not a redirect.
        if (kind !== 'http' && nextUrl) {
          const probe = new URL(nextUrl.href); probe.hash = '';
          if (probe.href === current.href) kind = null;
        }
      }

      if (!kind) {
        out.final = {
          url: current.href, status: r.status, contentType: _mime(r.headers['content-type']),
          title: r.html ? findTitle(r.html) : null, ip: r.remoteAddress,
          server: r.headers.server || null,
        };
        if (r.html) out.jsRedirectHint = findJsRedirect(r.html, current);
        return finish('final');
      }

      out.hops.push({
        n: out.hops.length + 1, url: current.href, host: current.hostname, ip: r.remoteAddress,
        status: r.status, kind, next: nextUrl ? nextUrl.href : rawNext, ms, server: r.headers.server || null,
      });

      if (!nextUrl) return finish('error', `${rawNext} — ${_ERR_TEXT.ERR_BAD_REDIRECT}`);
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
        return finish('non-web-scheme', nextUrl.href);
      }
      const target = new URL(nextUrl.href);
      _stripUserinfo(target);
      target.hash = '';
      if (seen.has(target.href)) return finish('loop', target.href);
      // maxHops redirects are followed; the (maxHops+1)th is recorded, not followed.
      if (out.hops.length > maxHops) return finish('max-hops', `${target.href} — more than ${maxHops} redirects, not fetched`);
      seen.add(target.href);
      current = target;
    }
  }

  // GET `input` and follow HTTP 3xx + Location (only those; a Refresh or meta refresh is
  // the caller's page, not a hop) up to maxRedirects, every hop a separate guarded
  // safeRequest. Resolves the final safeRequest result, whose `url` is the final URL, plus
  // `redirects` (count). A redirect's body is never read. One budget covers the whole
  // chain. Rejects like safeRequest, plus ERR_TOO_MANY_REDIRECTS, ERR_BAD_REDIRECT and
  // ERR_UNSUPPORTED_PROTOCOL (a Location to a non-web scheme). ERR_SSRF_BLOCKED carries
  // `redirects` so a caller can tell a private INPUT (0) from a private redirect target.
  async function fetchFollow(input, {
    headers = {}, maxBytes = 1024 * 1024, maxRedirects = 10, totalTimeoutMs = 15000, signal,
  } = {}) {
    const startedAt = Date.now();
    let current = _toUrl(input);
    for (let redirects = 0; ; redirects++) {
      const remaining = totalTimeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) throw new SafeFetchError('ERR_HOP_TIMEOUT', `No complete response within ${totalTimeoutMs} ms`, current.href);
      let r;
      try {
        r = await safeRequest(current, {
          headers, maxBytes, timeoutMs: remaining, signal,
          readBody: (status, h) => !(REDIRECT_CODES.has(status) && h.location),
        });
      } catch (e) {
        if (e && typeof e === 'object') e.redirects = redirects;
        throw e;
      }
      if (!(REDIRECT_CODES.has(r.status) && r.headers.location)) return { ...r, redirects };
      if (redirects >= maxRedirects) {
        throw Object.assign(new SafeFetchError('ERR_TOO_MANY_REDIRECTS', `More than ${maxRedirects} redirects`, current.href), { redirects });
      }
      let next;
      try { next = new URL(String(r.headers.location), current); }
      catch { throw Object.assign(new SafeFetchError('ERR_BAD_REDIRECT', _ERR_TEXT.ERR_BAD_REDIRECT, current.href), { redirects }); }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw Object.assign(new SafeFetchError('ERR_UNSUPPORTED_PROTOCOL', 'Redirect to a non-web scheme', current.href), { redirects });
      }
      current = next;
    }
  }

  // TLS certificate of `url`'s host, read from the ALREADY-VALIDATED remoteAddress with
  // SNI = hostname. It never resolves the name again (a third resolution would be a
  // rebinding window of its own). → { validTo, daysLeft, issuer } or null.
  function certInfo(input, remoteAddress, { timeoutMs = 8000 } = {}) {
    return new Promise(resolveP => {
      let url;
      try { url = _toUrl(input); } catch { return resolveP(null); }
      if (url.protocol !== 'https:') return resolveP(null);
      const ip = _bare(remoteAddress);
      const port = Number(url.port) || 443;
      if (!net.isIP(ip) || !classify(ip, port)) return resolveP(null);
      const name = _bare(url.hostname);
      let settled = false, socket = null, timer = null;
      const done = v => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (socket) socket.destroy();
        resolveP(v);
      };
      timer = setTimeout(() => done(null), timeoutMs);
      try {
        socket = tls.connect({
          host: ip, port,
          servername: net.isIP(name) ? undefined : name,
          rejectUnauthorized: false,           // reporting expiry, not trusting the peer
          lookup: (h, o, cb) => cb(_blocked(h)),   // unreachable for an IP host; belt and braces
        }, () => {
          const c = socket.getPeerCertificate();
          if (!c || !c.valid_to) return done(null);
          done({
            validTo: c.valid_to,
            daysLeft: Math.round((new Date(c.valid_to) - Date.now()) / 86_400_000),
            issuer: c.issuer?.O || null,
          });
        });
        socket.once('error', () => done(null));
      } catch { done(null); }
    });
  }

  return { classify, guardedLookup, safeRequest, fetchFollow, traceRedirects, certInfo };
}

const _default = createSafeFetcher();

module.exports = {
  PROXY_UA,
  SafeFetchError,
  isPublicIp,
  normalizeUserUrl,
  createSafeFetcher,
  guardedLookup:  _default.guardedLookup,
  safeRequest:    _default.safeRequest,
  fetchFollow:    _default.fetchFollow,
  traceRedirects: _default.traceRedirects,
  certInfo:       _default.certInfo,
  // pure parsers, exported for tests and the route layer
  parseRefresh,
  findMetaRefresh,
  findTitle,
  findJsRedirect,
};
