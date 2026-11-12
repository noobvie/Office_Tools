/**
 * Office Tools — API Server
 *
 * Tools API:
 *   POST/GET /api/tools/s        — URL shortener
 *   POST/GET /api/tools/p        — Pastebin
 *   POST/GET /api/tools/f        — File share
 *   POST     /api/tools/view     — Record tool click (popular tracking)
 *   GET      /api/tools/popular  — Top tools by click count
 *
 * Network API:
 *   GET /api/resolve, /api/portcheck
 *   GET /api/net/ping, /api/net/traceroute, /api/net/ptr
 *   GET /api/domain/whois, /api/domain/rdap, /api/domain/dns, /api/domain/availability
 *   POST /api/domain/ai-suggest
 *
 * Requires: .env (copy from .env.example)
 */

'use strict';
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
// Node's built-in SQLite (Node 24+). Replaced better-sqlite3 to drop the native
// addon: its prebuilt .node is ABI-locked to a Node version, so a Node upgrade on
// this box (the co-located Grin mining pool requires Node 24+) broke `require` with
// ERR_DLOPEN_FAILED / NODE_MODULE_VERSION mismatch and crash-looped the service.
// DatabaseSync exposes the same exec()/prepare()/run/get/all subset this file uses.
const { DatabaseSync } = require('node:sqlite');
const multer    = require('multer');
const { makeRateLimiter } = require('./lib/rate-limit');
const { clientIp, rateKey } = require('./lib/client-ip');
const { makeCaptcha, CAPTCHA_ERRORS } = require('./lib/captcha');
const { str, stripCtl, cleanHeaderText, safeFileName, validMailbox } = require('./lib/sanitize');
const shares = require('./lib/shares');
const { guardAsyncRoutes, finalErrorHandler, installProcessGuards } = require('./lib/http-guards');
const { emptyDirInside } = require('./lib/fs-safe');
const { makeTtlCache } = require('./lib/ttl-cache');
const safeFetch = require('./lib/safe-fetch');
const proxyRewrite = require('./lib/proxy-rewrite');
const { makeRedirectsHandler } = require('./lib/redirects-route');
const { makeInFlight, makeSemaphore, watchClientClose, makeDailyBudget, takeMany, proxySelfBase } = require('./lib/outbound-guards');
const { newUploadToken, findMemberByToken } = require('./lib/chat-upload-token');

installProcessGuards();

const app  = express();
// Every async route handler is wrapped (lib/http-guards.js): a rejection answers 500
// JSON instead of becoming an unhandled rejection that would end the process.
guardAsyncRoutes(app);
const PORT = process.env.PORT || 3001;

// ── Config ────────────────────────────────────────────────────
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:8080').split(',').map(s => s.trim());

// ── SQLite tools DB ───────────────────────────────────────────
const TOOLS_DB_PATH = process.env.TOOLS_DB    || '/opt/office-tools/data/tools.db';
const UPLOADS_DIR   = process.env.UPLOADS_DIR || '/opt/office-tools/data/uploads';
fs.mkdirSync(path.dirname(TOOLS_DB_PATH), { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new DatabaseSync(TOOLS_DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS short_urls (
    code     TEXT PRIMARY KEY,
    long_url TEXT NOT NULL,
    expires  TEXT DEFAULT '',
    created  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pastes (
    id              TEXT PRIMARY KEY,
    code            TEXT UNIQUE NOT NULL,
    title           TEXT DEFAULT '',
    content         TEXT NOT NULL,
    syntax          TEXT DEFAULT 'plain',
    expires         TEXT DEFAULT '',
    burn_after_read INTEGER DEFAULT 0,
    created         TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS file_shares (
    id            TEXT PRIMARY KEY,
    code          TEXT UNIQUE NOT NULL,
    original_name TEXT DEFAULT '',
    file_size     INTEGER DEFAULT 0,
    file_path     TEXT NOT NULL,
    expires       TEXT DEFAULT '',
    created       TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tool_views (
    tool_id TEXT PRIMARY KEY,
    count   INTEGER DEFAULT 0,
    updated TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS feedback (
    id      TEXT PRIMARY KEY,
    page    TEXT DEFAULT '',
    message TEXT NOT NULL,
    ip      TEXT DEFAULT '',
    created TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS temp_inbox (
    address TEXT PRIMARY KEY,
    ip      TEXT DEFAULT '',
    expires TEXT NOT NULL,
    created TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS temp_mail (
    id       TEXT PRIMARY KEY,
    address  TEXT NOT NULL,
    mail_from TEXT DEFAULT '',
    subject  TEXT DEFAULT '',
    body_text TEXT DEFAULT '',
    body_html TEXT DEFAULT '',
    received TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_temp_mail_address ON temp_mail(address);
`);

// Ids double as bearer secrets (upload file names, File Drop / chat client ids, chat
// file ids), so the random part comes from crypto: time prefix + 6 chars of [0-9a-z].
const _ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
function _randChars(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += _ID_ALPHABET[crypto.randomInt(_ID_ALPHABET.length)];
  return s;
}
function genId() {
  return Date.now().toString(36) + _randChars(6);
}

// File Share form (tools/file-share): code, original_name, file_size, expires, the
// captcha fields and the file — limits leave headroom over that, not more.
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, genId()),
  }),
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 16, fieldSize: 8 * 1024, parts: 20, headerPairs: 100 },
});

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: CORS_ORIGINS, methods: ['GET','POST','DELETE'], allowedHeaders: ['Content-Type'] }));
// The temp-inbox ingest route parses its own (larger) body after checking its secret.
const _jsonDefault = express.json();
app.use((req, res, next) => (req.path === '/api/email/inbox/ingest' ? next() : _jsonDefault(req, res, next)));

// ── Shared: creation rate limit + CAPTCHA ────────────────────
const createRLMiddleware = makeRateLimiter({
  windowMs: 3_600_000, max: 10,
  message: 'Rate limit: 10 creates per hour. Try again later.',
}).middleware;

// Server-issued challenge (lib/captcha.js): GET /api/captcha → { a, b, token }; the
// form posts back `ans` + `ctoken` (JSON body or multipart fields).
const _captcha = makeCaptcha();
const _captchaRL = makeRateLimiter({ windowMs: 60_000, max: 30, message: 'Too many requests. Please wait a minute.' });
app.get('/api/captcha', _captchaRL.middleware, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(_captcha.issue());
});
// → null when solved, else the 400 body to send.
function _captchaFail(body) {
  const r = _captcha.verify(body?.ans, body?.ctoken);
  return r === 'ok' ? null : (r === 'missing' ? CAPTCHA_ERRORS.missing : CAPTCHA_ERRORS.bad);
}

// ── Tools API: URL Shortener ──────────────────────────────────

app.post('/api/tools/s', createRLMiddleware, (req, res) => {
  const capErr = _captchaFail(req.body);
  if (capErr) return res.status(400).json(capErr);
  const code = str(req.body?.code), rawUrl = str(req.body?.long_url);
  if (!code || !rawUrl) return res.status(400).json({ error: 'code and long_url required' });
  if (!shares.validShareCode(code)) return res.status(400).json({ error: 'Alias must be 4–20 characters: letters, numbers, hyphens only.' });
  const longUrl = shares.normaliseLongUrl(rawUrl);
  if (!longUrl) return res.status(400).json({ error: `long_url must be a valid http:// or https:// URL (max ${shares.LONG_URL_MAX} characters)` });
  const expires = shares.optionalExpiry(req.body?.expires);
  if (expires === null) return res.status(400).json({ error: 'Invalid expiry' });
  try {
    db.prepare('INSERT INTO short_urls (code, long_url, expires) VALUES (?, ?, ?)').run(code, longUrl, expires);
    res.json({ code });
  } catch (err) {
    if (String(err?.message).includes('UNIQUE')) return res.status(409).json({ error: 'Code already taken' });
    console.error('[short_urls]', err?.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/tools/s/:code', (req, res) => {
  const row = db.prepare('SELECT * FROM short_urls WHERE code = ?').get(req.params.code);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.expires && new Date(row.expires) < new Date()) return res.status(410).json({ error: 'Expired' });
  res.json(row);
});

// ── Tools API: Pastebin ───────────────────────────────────────

app.post('/api/tools/p', createRLMiddleware, (req, res) => {
  const capErr = _captchaFail(req.body);
  if (capErr) return res.status(400).json(capErr);
  const code = str(req.body?.code), content = str(req.body?.content);
  const title = str(req.body?.title), syntax = str(req.body?.syntax);
  if (!code || !content) return res.status(400).json({ error: 'code and content required' });
  if (!shares.validShareCode(code)) return res.status(400).json({ error: 'Invalid code' });
  const expires = shares.optionalExpiry(req.body?.expires);
  if (expires === null) return res.status(400).json({ error: 'Invalid expiry' });
  const id = genId();
  try {
    db.prepare('INSERT INTO pastes (id, code, title, content, syntax, expires, burn_after_read) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, code, title, content, syntax || 'plain', expires, req.body?.burn_after_read ? 1 : 0
    );
    res.json({ code, id });
  } catch (err) {
    if (String(err?.message).includes('UNIQUE')) return res.status(409).json({ error: 'Code already taken' });
    console.error('[pastes]', err?.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/tools/p/:code', (req, res) => {
  const row = db.prepare('SELECT * FROM pastes WHERE code = ?').get(req.params.code);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.expires && new Date(row.expires) < new Date()) return res.status(410).json({ error: 'Expired' });
  if (row.burn_after_read) db.prepare('DELETE FROM pastes WHERE code = ?').run(req.params.code);
  res.json({ ...row, burn_after_read: !!row.burn_after_read });
});

// ── Tools API: File Share ─────────────────────────────────────

app.post('/api/tools/f', createRLMiddleware, upload.single('file'), (req, res) => {
  const drop = () => { if (req.file?.path) fs.unlink(req.file.path, () => {}); };
  const capErr = _captchaFail(req.body);
  if (capErr) { drop(); return res.status(400).json(capErr); }
  const code = str(req.body?.code);
  if (!code || !req.file) { drop(); return res.status(400).json({ error: 'code and file required' }); }
  if (!shares.validShareCode(code)) { drop(); return res.status(400).json({ error: 'Invalid code' }); }
  // The server decides expiry (≤ 50 days) and size; the client's file_size is ignored.
  const expires = shares.fileShareExpiry(req.body?.expires);
  const originalName = safeFileName(str(req.body?.original_name)) || safeFileName(req.file.originalname) || 'file';
  const id = genId();
  try {
    db.prepare('INSERT INTO file_shares (id, code, original_name, file_size, file_path, expires) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, code, originalName, req.file.size, req.file.path, expires
    );
    res.json({ code, id, original_name: originalName, file_size: req.file.size });
  } catch (err) {
    drop();
    if (String(err?.message).includes('UNIQUE')) return res.status(409).json({ error: 'Code already taken' });
    console.error('[file_shares]', err?.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/tools/f/:code', (req, res) => {
  const row = db.prepare('SELECT id, code, original_name, file_size, expires, created FROM file_shares WHERE code = ?').get(req.params.code);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.expires && new Date(row.expires) < new Date()) return res.status(410).json({ error: 'Expired' });
  res.json(row);
});

app.get('/api/tools/f/:code/download', (req, res) => {
  const row = db.prepare('SELECT * FROM file_shares WHERE code = ?').get(req.params.code);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.expires && new Date(row.expires) < new Date()) return res.status(410).json({ error: 'Expired' });
  res.download(row.file_path, row.original_name);
});

// ── Multer error handler ──────────────────────────────────────
app.use((err, _req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 100 MB)' });
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'Unexpected file field' });
  if (err.name === 'MulterError') return res.status(400).json({ error: 'Upload rejected: too many or too large form fields' });
  next(err);
});

// ── Expiry sweeper: file shares, pastes, short URLs ───────────
// Deletes expired rows and their uploaded files (lib/shares.js sweepExpired). Short
// URLs / pastes with no expiry ("Never") are kept. Never throws.
function _sweepShares() {
  try {
    const n = shares.sweepExpired(db, { uploadsDir: UPLOADS_DIR });
    if (n.files || n.pastes || n.shortUrls) console.log(`[sweep] removed ${n.files} file(s), ${n.pastes} paste(s), ${n.shortUrls} short URL(s)`);
  } catch (e) { console.error('[sweep]', e?.message); }
}
setImmediate(_sweepShares);
setInterval(_sweepShares, 600_000).unref();

// ── Popular tools — click-based view tracking ─────────────────
const _viewRL = makeRateLimiter({ windowMs: 60_000, max: 60 });

// Known tool ids = the directory names under the deployed web root's tools/. Read at
// boot and every 10 min, so a deploy that adds a tool is picked up without a restart.
// Candidates: TOOLS_DIR (env), deploy.sh's WEB_ROOT, then the repo checkout next to
// this backend (local dev). If none is readable the id-shape check alone applies.
const _TOOLS_DIR_CANDIDATES = [
  (process.env.TOOLS_DIR || '').trim(),
  '/var/www/office-tools/tools',
  path.join(__dirname, '..', 'tools'),
].filter(Boolean);
let _knownTools = null;   // Set<string> | null
function _loadKnownTools() {
  for (const dir of _TOOLS_DIR_CANDIDATES) {
    try {
      const names = fs.readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^[a-z0-9-]+$/.test(d.name)).map(d => d.name);
      if (names.length) { _knownTools = new Set(names); return; }
    } catch { /* try the next candidate */ }
  }
  _knownTools = null;
}
_loadKnownTools();
setInterval(_loadKnownTools, 600_000).unref();

app.post('/api/tools/view', (req, res) => {
  if (!_viewRL.allow(rateKey(clientIp(req)))) return res.status(429).json({ error: 'Too many requests' });
  const tool = str(req.body?.tool).trim();
  if (!tool || !/^[a-z0-9-]+$/.test(tool) || tool.length > 60 || (_knownTools && !_knownTools.has(tool))) {
    return res.status(400).json({ error: 'Invalid tool id' });
  }
  db.prepare(`
    INSERT INTO tool_views (tool_id, count, updated) VALUES (?, 1, datetime('now'))
    ON CONFLICT(tool_id) DO UPDATE SET count = count + 1, updated = datetime('now')
  `).run(tool);
  res.json({ ok: true });
});

app.get('/api/tools/popular', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 20);
  const rows = db.prepare('SELECT tool_id, count FROM tool_views ORDER BY count DESC LIMIT ?').all(limit);
  res.json({ tools: rows });
});

// ── Port Checker — DNS resolve (IPv4 + IPv6) + TCP connect probe ───────────
const net = require('net');
const dns = require('dns');

// ── Public probe service (portcheck / portcheckbatch) ─────────
// These GET routes are a PUBLIC service so any solo-pool setup page on any domain can
// verify its own stratum port. Open CORS only on these read-only routes — the global
// allowlist still guards every write route (uploads, pastes, payment, AI). No cookies
// are used, so Access-Control-Allow-Origin:* is safe here.
function publicCors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// SSRF guard: a public TCP-connect endpoint must never be usable to probe the server's
// own internal network or cloud metadata. Addresses are classified by the ONE shared
// classifier, safeFetch.isPublicIp (lib/safe-fetch.js) — the same list the HTTP routes
// use. Hostnames are resolved first and we connect to the VALIDATED public IP, which
// defeats DNS rebinding to 127.0.0.1 / 169.254.169.254 / 10.x etc. Unlike the HTTP
// routes (which refuse a host if ANY answer is private), a probe picks one public
// address from a mixed answer: it connects to that IP only, never to the name.

// Resolve host → a public IP to connect to, or throw: safeFetch.resolvePublicTarget.
// It is shared with ping / traceroute, which pass the IP (never the name) to the child.
const resolvePublicTarget = safeFetch.resolvePublicTarget;

// Per-IP limiter for the public probe endpoints (a setup page may check a few hosts ×
// ports and reload). Kept separate from ping/resolve (netRL, 10/min). The cap keys on the
// VISITOR's IP (lib/client-ip.js; an IPv6 visitor's /64), so it's per browsing user — NOT per pool
// deployment; many solo/public-pool sites do not share one bucket. Default 600/min
// comfortably covers many miners behind a single shared NAT/VPN while keeping this
// CORS-open TCP-connect endpoint from becoming a high-throughput port scanner. Tune
// in production without a code change via env PROBE_RATE_PER_MIN — no redeploy needed.
// Clamped to a sane floor/ceiling.
const PROBE_RATE_PER_MIN = Math.min(2000, Math.max(10,
  parseInt(process.env.PROBE_RATE_PER_MIN, 10) || 600));
const probeRLMiddleware = makeRateLimiter({
  windowMs: 60_000, max: PROBE_RATE_PER_MIN,
  message: `Rate limit: ${PROBE_RATE_PER_MIN} requests/minute. Please wait.`,
}).middleware;

// Only PUBLIC addresses are returned: the server's own resolver may know provider-internal
// names, and the probes refuse a private target anyway. An empty list is the normal
// "nothing usable" answer — tools/port-checker then falls back to the typed host.
app.get('/api/resolve', netRLMiddleware, (req, res) => {
  const host = String(req.query.host || '').trim();
  if (!host) return res.status(400).json({ error: 'Missing host' });
  const pub = ip => safeFetch.isPublicIp(ip);

  // Raw IPv4 address
  if (net.isIPv4(host)) {
    return res.json({ host, addresses: pub(host) ? [{ ip: host, family: 'IPv4' }] : [] });
  }
  // Raw IPv6 address (with or without brackets)
  const ipv6 = host.replace(/^\[|\]$/g, '');
  if (net.isIPv6(ipv6)) {
    return res.json({ host, addresses: pub(ipv6) ? [{ ip: ipv6, family: 'IPv6' }] : [] });
  }

  // Hostname — resolve both A and AAAA records in parallel
  let v4 = [], v6 = [], done = 0;
  const finish = () => {
    if (++done < 2) return;
    const addresses = [
      ...v4.filter(pub).map(ip => ({ ip, family: 'IPv4' })),
      ...v6.filter(pub).map(ip => ({ ip, family: 'IPv6' })),
    ];
    res.json({ host, addresses });
  };
  dns.resolve4(host, (err, addrs) => { v4 = err ? [] : addrs; finish(); });
  dns.resolve6(host, (err, addrs) => { v6 = err ? [] : addrs; finish(); });
});

// Two global guards on top of the per-visitor limiter, so that no combination of visitors
// can turn the public probe into a scanner of one destination or exhaust sockets here:
// - per DESTINATION (rateKey of the resolved IP: an IPv4 address, or an IPv6 /64), counted
//   per port probed, across every caller: PROBE_TARGET_PER_10MIN (default 1200). A pool
//   setup page checking 3–4 stratum ports per visitor fits ~300 page loads per 10 min;
//   one sweep of all 65 535 ports would take over 9 hours.
// - at most PROBE_MAX_SOCKETS (default 256) probe sockets open at once; more probes wait
//   their turn (FIFO). A request whose probes would push the waiting line past
//   PROBE_MAX_QUEUE (default 1024, i.e. at most ~16 s of waiting at the 4 s probe timeout)
//   is answered 503 instead. A single batch of 60 always fits.
const PROBE_TARGET_PER_10MIN = Math.min(100_000, Math.max(60,
  parseInt(process.env.PROBE_TARGET_PER_10MIN, 10) || 1200));
const _probeTargetRL = makeRateLimiter({ windowMs: 600_000, max: PROBE_TARGET_PER_10MIN });
const _PROBE_TARGET_MSG = 'This destination has had too many port checks in the last 10 minutes. Please try again later.';
const _probeSockets = makeSemaphore({
  max: Math.min(4096, Math.max(64, parseInt(process.env.PROBE_MAX_SOCKETS, 10) || 256)),
  maxQueue: Math.min(16_384, Math.max(60, parseInt(process.env.PROBE_MAX_QUEUE, 10) || 1024)),
});
const _PROBE_BUSY_MSG = 'The port checker is busy right now. Please try again in a few seconds.';
const _PROBE_TIMEOUT_MS = 4000;

// One TCP connect to an already-validated IP → { port, open }. Holds a socket slot for
// its whole life; every outcome (connect, timeout, error) releases it exactly once.
async function _probePort(port, target) {
  const release = await _probeSockets.acquire();
  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;
    function finish(open) {
      if (done) return; done = true;
      socket.destroy();
      release();
      resolve({ port, open });
    }
    socket.setTimeout(_PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout',  () => finish(false));
    socket.once('error',    () => finish(false));
    try { socket.connect(port, target); } catch { finish(false); }
  });
}

// Shared admission for both probe routes: → null when the n probes may run, else the
// [status, message] to answer with. The per-destination count is taken only once the
// request is otherwise admissible.
function _probeAdmit(target, n) {
  if (!_probeSockets.canQueue(n)) return [503, _PROBE_BUSY_MSG];
  if (!takeMany(_probeTargetRL, rateKey(target), n)) return [429, _PROBE_TARGET_MSG];
  return null;
}

app.get('/api/portcheck', publicCors, probeRLMiddleware, async (req, res) => {
  const hostInput = String(req.query.host || '').trim();
  const port = parseInt(req.query.port, 10);
  if (!hostInput || isNaN(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'Invalid host or port' });
  }

  let target;
  try { target = await resolvePublicTarget(hostInput); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const refused = _probeAdmit(target, 1);
  if (refused) return res.status(refused[0]).json({ error: refused[1] });

  const { open } = await _probePort(port, target);
  res.json({ host: hostInput, port, open });
});

// Batch port checker — all ports probed concurrently, within the global socket cap
// (public, CORS-open, probe limiter)
app.get('/api/portcheckbatch', publicCors, probeRLMiddleware, async (req, res) => {
  const hostInput = String(req.query.host || '').trim();
  const portsParam = String(req.query.ports || '').trim();
  if (!hostInput || !portsParam) return res.status(400).json({ error: 'Missing host or ports' });

  const portNums = [...new Set(
    portsParam.split(',').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p) && p >= 1 && p <= 65535)
  )];
  if (!portNums.length) return res.status(400).json({ error: 'No valid ports' });
  if (portNums.length > 60) return res.status(400).json({ error: 'Max 60 ports per batch' });

  let target;
  try { target = await resolvePublicTarget(hostInput); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const refused = _probeAdmit(target, portNums.length);
  if (refused) return res.status(refused[0]).json({ error: refused[1] });

  const results = await Promise.all(portNums.map(p => _probePort(p, target)));
  res.json({ host: hostInput, results });
});

// ── Health ────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Domain Checker API ────────────────────────────────────────
//
//   GET  /api/domain/whois?domain=      raw WHOIS + parsed fields
//   GET  /api/domain/rdap?domain=       RDAP lookup (registrar, dates, nameservers)
//   GET  /api/domain/dns?domain=&type=  DNS-over-HTTPS proxy (A/AAAA/MX/NS/TXT/CNAME/SOA/CAA)
//   GET  /api/domain/availability?domain=  check base name across 8 common TLDs
//   POST /api/domain/ai-suggest         { keyword } → AI domain name suggestions (Gemini Flash)
//
// Rate limit: 15 req/min per IP. In-memory cache: 1 h TTL.
// Optional env vars: GEMINI_API_KEY (AI suggest), VIEWDNS_API_KEY / WHOXY_API_KEY (history)

// Per-IP rate limiter (domain routes only)
const domainRLMiddleware = makeRateLimiter({
  windowMs: 60_000, max: 15,
  message: 'Rate limit: 15 requests/minute. Please wait.',
}).middleware;

// In-memory result cache (1 h TTL), bounded: oldest entry evicted at 5 000, expired
// entries swept every 10 min (lib/ttl-cache.js).
const _domCache = makeTtlCache({ ttlMs: 3_600_000, maxEntries: 5000 });
function dcGet(k) { return _domCache.get(k); }
function dcSet(k, d) { _domCache.set(k, d); }

// Validate a domain name label (no scheme, no path, no port)
function validDomain(d) {
  if (!d || d.length > 253) return false;
  return /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(d);
}

// Parse the most useful fields out of raw WHOIS text
function parseWhoisText(raw) {
  function pick(...labels) {
    for (const l of labels) {
      const m = raw.match(new RegExp('^' + l + ':\\s*(.+)$', 'im'));
      if (m) return m[1].trim();
    }
    return null;
  }
  const ns = [...raw.matchAll(/^(?:Name Server|nserver):\s*(.+)$/gim)]
    .map(m => m[1].trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
  return {
    registrar:  pick('Registrar', 'Registrar Name', 'registrar'),
    created:    pick('Creation Date', 'Created Date', 'Domain Registration Date', 'created', 'Registered On', 'registration'),
    updated:    pick('Updated Date', 'Last Updated On', 'Last Modified', 'updated', 'last-update'),
    expires:    pick('Registry Expiry Date', 'Expiration Date', 'Expiry Date', 'expires', 'Registrar Registration Expiration Date', 'paid-till'),
    status:     pick('Domain Status', 'Status', 'status'),
    dnssec:     pick('DNSSEC', 'dnssec'),
    registrant: pick('Registrant Name', 'Registrant Organization', 'Registrant'),
    nameservers: [...new Set(ns)],
  };
}

// GET /api/domain/whois — uses HackerTarget HTTP API (avoids TCP port 43 firewall issues)
app.get('/api/domain/whois', domainRLMiddleware, async (req, res) => {
  const domain = String(req.query.domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!validDomain(domain)) return res.status(400).json({ error: 'Invalid domain name' });

  const ck = 'whois:' + domain;
  const cached = dcGet(ck);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const r = await fetch(`https://api.hackertarget.com/whois/?q=${encodeURIComponent(domain)}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`WHOIS API returned HTTP ${r.status}`);
    const raw = await r.text();
    if (raw.includes('API count exceeded')) {
      console.error('[domain/whois] upstream quota exceeded');
      return res.status(500).json({ error: 'The WHOIS service has reached its daily limit. Please try again later.' });
    }
    if (/^error /i.test(raw)) throw new Error(raw.trim().slice(0, 200));
    const parsed = parseWhoisText(raw);
    const data   = { domain, raw, parsed };
    dcSet(ck, data);
    res.json(data);
  } catch (err) {
    // The upstream text stays in the log; the visitor gets a stable message.
    console.error('[domain/whois]', err.message);
    res.status(500).json({ error: 'WHOIS lookup failed — the WHOIS service did not answer. Please try again later.' });
  }
});

// GET /api/domain/rdap
app.get('/api/domain/rdap', domainRLMiddleware, async (req, res) => {
  const domain = String(req.query.domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!validDomain(domain)) return res.status(400).json({ error: 'Invalid domain name' });

  const ck = 'rdap:' + domain;
  const cached = dcGet(ck);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const r = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { Accept: 'application/rdap+json' },
      signal: AbortSignal.timeout(10000),
    });

    if (r.status === 404) {
      const data = { domain, found: false };
      dcSet(ck, data);
      return res.json(data);
    }
    if (!r.ok) return res.status(r.status).json({ error: `RDAP lookup failed (the registry answered HTTP ${r.status}). Please try again later.` });

    const raw = await r.json();

    // Normalize events → { registration, 'last changed', expiration }
    const events = {};
    for (const e of (raw.events || [])) events[e.eventAction] = e.eventDate;

    // Extract registrar name from entities
    const regEntity = (raw.entities || []).find(e => (e.roles || []).includes('registrar'));
    const regName   = regEntity?.vcardArray?.[1]?.find(f => f[0] === 'fn')?.[3]
                   || regEntity?.handle || null;

    const data = {
      domain,
      found:       true,
      status:      raw.status || [],
      created:     events['registration']   || null,
      updated:     events['last changed']   || null,
      expires:     events['expiration']     || null,
      registrar:   regName,
      nameservers: (raw.nameservers || []).map(ns => ns.ldhName?.toLowerCase()).filter(Boolean),
      dnssec:      raw.secureDNS?.delegationSigned ? 'Signed' : 'Unsigned',
      raw,
    };
    dcSet(ck, data);
    res.json(data);
  } catch (err) {
    console.error('[domain/rdap]', err.message);
    // On timeout or network error, fall back to WHOIS instead of hard-failing
    if (err.name === 'TimeoutError' || err.name === 'AbortError' ||
        err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') {
      return res.json({ domain, found: false });
    }
    res.status(500).json({ error: 'RDAP lookup failed. Please try again later.' });
  }
});

// GET /api/domain/dns
const _DNS_ALLOWED_TYPES = new Set(['A','AAAA','MX','NS','TXT','CNAME','SOA','CAA']);

app.get('/api/domain/dns', domainRLMiddleware, async (req, res) => {
  const domain = String(req.query.domain || '').trim().toLowerCase().replace(/^www\./, '');
  const type   = String(req.query.type   || 'A').toUpperCase();
  if (!validDomain(domain)) return res.status(400).json({ error: 'Invalid domain name' });
  if (!_DNS_ALLOWED_TYPES.has(type)) return res.status(400).json({ error: 'Unsupported record type' });

  const ck = `dns:${domain}:${type}`;
  const cached = dcGet(ck);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const r = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${encodeURIComponent(type)}`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return res.status(r.status).json({ error: `DNS query failed: ${r.status}` });
    const data = await r.json();
    dcSet(ck, data);
    res.json(data);
  } catch (err) {
    console.error('[domain/dns]', err.message);
    res.status(500).json({ error: 'DNS query failed — the DNS service did not answer. Please try again.' });
  }
});

// GET /api/domain/availability?domain=mybrand  (strip TLD if user includes one)
const _AVAIL_TLDS = ['.com', '.net', '.org', '.io', '.co', '.app', '.dev', '.info'];

app.get('/api/domain/availability', domainRLMiddleware, async (req, res) => {
  let base = String(req.query.domain || '').trim().toLowerCase().replace(/^www\./, '');
  // Strip TLD so user can pass either "example" or "example.com"
  const dot = base.lastIndexOf('.');
  if (dot > 0) base = base.slice(0, dot);
  if (!base || !/^[a-z0-9][a-z0-9-]*$/.test(base) || base.length > 63) {
    return res.status(400).json({ error: 'Invalid domain base name' });
  }

  async function checkOne(domain) {
    const ck = 'avail:' + domain;
    const cached = dcGet(ck);
    if (cached) return cached;

    // Try RDAP: 404 = not found in registry = available
    try {
      const r = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
        headers: { Accept: 'application/rdap+json' },
        signal: AbortSignal.timeout(7000),
      });
      const result = { domain, available: r.status === 404, method: 'rdap' };
      dcSet(ck, result);
      return result;
    } catch { /* fall through to DNS */ }

    // Fallback: no NS records in DNS → likely available
    try {
      const r2 = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=NS`,
        { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) }
      );
      const dns = await r2.json();
      const result = { domain, available: !(dns.Answer && dns.Answer.length > 0), method: 'dns' };
      dcSet(ck, result);
      return result;
    } catch {
      return { domain, available: null, error: 'Check failed' };
    }
  }

  try {
    const results = await Promise.all(_AVAIL_TLDS.map(tld => checkOne(base + tld)));
    res.json({ base, results });
  } catch (err) {
    console.error('[domain/availability]', err.message);
    res.status(500).json({ error: 'Availability check failed. Please try again.' });
  }
});

// POST /api/domain/ai-suggest  { keyword: string, context?: string }
const _GEMINI_KEY = process.env.GEMINI_API_KEY || '';
// Every call spends the operator's Gemini quota, so on top of the shared domain limiter
// (15/min) the route has its own 5/min per visitor and a server-wide daily budget
// (AI_SUGGEST_DAILY_MAX, default 500 calls per UTC day).
const _aiSuggestRL = makeRateLimiter({
  windowMs: 60_000, max: 5,
  message: 'Rate limit: 5 AI suggestion requests/minute. Please wait a minute.',
});
const _aiSuggestBudget = makeDailyBudget(Math.max(1, parseInt(process.env.AI_SUGGEST_DAILY_MAX, 10) || 500));

app.post('/api/domain/ai-suggest', domainRLMiddleware, _aiSuggestRL.middleware, async (req, res) => {
  if (!_GEMINI_KEY) {
    return res.status(503).json({ error: 'AI suggestions not configured (GEMINI_API_KEY missing in .env)' });
  }
  const keyword = str(req.body?.keyword).trim().slice(0, 100);
  const context = str(req.body?.context).trim().slice(0, 300);
  if (!keyword) return res.status(400).json({ error: 'keyword is required' });
  if (!_aiSuggestBudget.take()) {
    return res.status(429).json({ error: "AI suggestions have reached today's limit. Please try again tomorrow." });
  }

  const prompt = `Suggest 12 creative, brandable domain names for a project or business related to: "${keyword}"${context ? '. Extra context: ' + context : ''}.

Rules:
- Mix short names (6-12 chars) and longer descriptive names
- Suggest real TLD variants (.com .io .app .co .net .dev etc.)
- No hyphens, no leading numbers, use real words or clever portmanteaus
- Include the TLD in each suggestion (e.g. "brandname.io")
- Return ONLY a raw JSON array of strings — no markdown, no explanation.
Example: ["example.com","coolapp.io","mybrand.co"]`;

  try {
    const r = await fetch(
      // The key travels in the x-goog-api-key header (Gemini REST's documented form), not
      // in the URL, where proxies and error reports would record it.
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': _GEMINI_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 400, temperature: 0.85 },
        }),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      console.error('[domain/ai-suggest] upstream', r.status, String(errBody.error?.message || '').slice(0, 200));
      return res.status(r.status).json({ error: r.status === 429
        ? 'The AI service is busy right now. Please try again in a minute.'
        : 'AI suggestions are unavailable right now. Please try again later.' });
    }
    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const match = text.match(/\[[\s\S]*?\]/);
    // The model's text is never returned: on a parse failure the visitor gets a fixed message.
    if (!match) return res.status(500).json({ error: 'Could not read the AI response. Please try again.' });

    let suggestions;
    try {
      suggestions = JSON.parse(match[0]);
      if (!Array.isArray(suggestions)) throw new Error('not array');
      suggestions = suggestions
        .map(s => String(s).trim().toLowerCase())
        .filter(s => /^[a-z0-9][a-z0-9-]*\.[a-z]{2,}$/.test(s))
        .slice(0, 15);
    } catch {
      return res.status(500).json({ error: 'Could not read the AI response. Please try again.' });
    }

    res.json({ keyword, suggestions });
  } catch (err) {
    console.error('[domain/ai-suggest]', err.message);
    res.status(500).json({ error: 'AI suggestions are unavailable right now. Please try again later.' });
  }
});

// ── Network Toolkit — ping, traceroute, reverse DNS ──────────
const { spawn } = require('child_process');
const _isWin = process.platform === 'win32';

function validNetHost(h) {
  return h.length > 0 && h.length <= 253 && /^[a-zA-Z0-9.\-:\[\]_]+$/.test(h);
}

const _netRL = makeRateLimiter({
  windowMs: 60_000, max: 10,
  message: 'Rate limit: 10 requests/minute. Please wait.',
});
// Hoisted wrapper: /api/resolve (in the Port Checker section above) references
// this before this line runs, so it must be a function declaration, not a const.
function netRLMiddleware(req, res, next) { return _netRL.middleware(req, res, next); }

// At most 8 ping and 4 traceroute children run at once, server-wide (a traceroute lives up
// to 120 s). Past the cap the request still gets an SSE stream — the pages read errors
// only from the stream (an EventSource cannot see a JSON error body) — carrying one
// readable "busy" line and [DONE].
const _pingSlots  = makeInFlight(8);
const _traceSlots = makeInFlight(4);

function _sseStart(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}
function _sseBusy(res, what) {
  _sseStart(res);
  res.write(`data: ${JSON.stringify(`Error: the server is running too many ${what} right now. Please try again in a few seconds.`)}\n\n`);
  res.write('data: "[DONE]"\n\n');
  res.end();
}

// Streams one child process as SSE. `release` frees its slot and is called on every exit:
// the child closing, a spawn error, or a synchronous spawn throw (it is idempotent, so
// 'error' followed by 'close' is fine). A client that leaves kills the child, whose
// 'close' then releases; the spawn `timeout` kills it at the deadline the same way.
function _sseRunChild(res, gone, release, cmd, args, timeout) {
  let proc;
  try { proc = spawn(cmd, args, { timeout }); }
  catch (err) {
    release();
    res.write(`data: ${JSON.stringify('Error: ' + err.message)}\n\n`);
    res.write('data: "[DONE]"\n\n');
    return res.end();
  }
  const send = chunk => chunk.toString().split(/\r?\n/).filter(l => l.trim())
    .forEach(l => res.write(`data: ${JSON.stringify(l)}\n\n`));

  proc.stdout.on('data', send);
  proc.stderr.on('data', send);
  proc.on('close', () => { release(); gone.dispose(); res.write('data: "[DONE]"\n\n'); res.end(); });
  proc.on('error', err => {
    release();
    res.write(`data: ${JSON.stringify('Error: ' + err.message)}\n\n`);
    res.write('data: "[DONE]"\n\n');
    res.end();
  });
  gone.signal.addEventListener('abort', () => proc.kill(), { once: true });
}

// GET /api/net/ping?host=&count=&family=   (SSE stream)
app.get('/api/net/ping', netRLMiddleware, async (req, res) => {
  const host  = String(req.query.host || '').trim().replace(/^\[|\]$/g, '');
  const count = Math.min(10, Math.max(1, parseInt(req.query.count, 10) || 4));
  const fam   = String(req.query.family || 'auto'); // 'auto' | '4' | '6'

  if (!validNetHost(host)) return res.status(400).json({ error: 'Invalid host' });
  const release = _pingSlots.tryAcquire();
  if (!release) return _sseBusy(res, 'pings');
  // Watched before the first await, so a client gone during resolution is seen too.
  const gone = watchClientClose(res);
  // SSRF: the child gets a validated PUBLIC IP, never the name (no second resolution).
  let target;
  try { target = await resolvePublicTarget(host, { family: fam }); }
  catch (e) { release(); gone.dispose(); return res.status(400).json({ error: e.message }); }
  if (gone.closed()) return release();

  _sseStart(res);

  let cmd, args;
  if (_isWin) {
    cmd  = 'ping';
    args = ['-n', String(count)];
    if (fam === '6') args.push('-6');
    args.push(target);
  } else {
    cmd  = 'ping';
    args = ['-c', String(count)];
    if (fam === '4') args.push('-4');
    else if (fam === '6') args.push('-6');
    args.push(target);
  }

  _sseRunChild(res, gone, release, cmd, args, 30000);
});

// GET /api/net/traceroute?host=&maxhops=&family=   (SSE stream)
app.get('/api/net/traceroute', netRLMiddleware, async (req, res) => {
  const host    = String(req.query.host || '').trim().replace(/^\[|\]$/g, '');
  const maxhops = Math.min(30, Math.max(1, parseInt(req.query.maxhops, 10) || 30));
  const fam     = String(req.query.family || 'auto');

  if (!validNetHost(host)) return res.status(400).json({ error: 'Invalid host' });
  const release = _traceSlots.tryAcquire();
  if (!release) return _sseBusy(res, 'traceroutes');
  const gone = watchClientClose(res);
  // SSRF: the child gets a validated PUBLIC IP, never the name (no second resolution).
  let target;
  try { target = await resolvePublicTarget(host, { family: fam }); }
  catch (e) { release(); gone.dispose(); return res.status(400).json({ error: e.message }); }
  if (gone.closed()) return release();

  _sseStart(res);

  let cmd, args;
  if (_isWin) {
    cmd  = 'tracert';
    args = ['-h', String(maxhops)];
    if (fam === '6') args.push('-6');
    args.push(target);
  } else {
    cmd  = 'traceroute';
    args = ['-m', String(maxhops)];
    if (fam === '4') args.push('-4');
    else if (fam === '6') args.push('-6');
    args.push(target);
  }

  _sseRunChild(res, gone, release, cmd, args, 120000);
});

// GET /api/net/ptr?ip=
// Public addresses only: the server's own resolver may hold provider-internal reverse
// zones (10.x, 172.16/12, …) that must not be readable from outside.
app.get('/api/net/ptr', netRLMiddleware, (req, res) => {
  const ip = String(req.query.ip || '').trim().replace(/^\[|\]$/g, '');
  if (!net.isIPv4(ip) && !net.isIPv6(ip)) {
    return res.status(400).json({ error: 'Invalid IP address (IPv4 or IPv6 required)' });
  }
  if (!safeFetch.isPublicIp(ip)) {
    return res.status(400).json({ error: 'Private or reserved address — reverse DNS is looked up only for public IPs.' });
  }
  dns.reverse(ip, (err, hostnames) => {
    if (err) {
      if (err.code === 'ENOTFOUND' || err.code === 'ENODATA' || err.code === 'ENONAME') {
        return res.json({ ip, hostnames: [], found: false });
      }
      console.error('[net/ptr]', err.code || err.message);
      return res.status(500).json({ error: 'Reverse DNS lookup failed. Please try again.' });
    }
    res.json({ ip, hostnames, found: hostnames.length > 0 });
  });
});

// ── Feedback ───────────────────────────────────────────────────
// The recipient is passed on argv (never `-t`, which would read recipients from the
// headers a visitor partly controls) and must be one plain operator-set address.
// Header values are sanitised by the caller (cleanHeaderText); the body follows the
// blank line and is free text.
function _sendmailNotify(to, subject, body) {
  if (!validMailbox(to)) { console.error('[sendmail] NOTIFY_EMAIL is not a single plain address — not sent'); return; }
  const { spawn } = require('child_process');
  const proc = spawn('sendmail', ['-i', '--', to], { timeout: 10_000 });
  const mail = `To: ${to}\nFrom: noreply@grin.money\nSubject: ${cleanHeaderText(subject, 250)}\n\n${body}`;
  proc.stdin.on('error', () => { /* reported by 'error' / 'close' below */ });
  proc.stdin.write(mail);
  proc.stdin.end();
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d; });
  proc.on('error',  err  => console.error(`[sendmail] spawn error → ${err.message}`));
  proc.on('close',  code => {
    if (code !== 0) console.error(`[sendmail] exited ${code} stderr: ${stderr.trim()}`);
    else            console.log('[sendmail] delivered');
  });
}

const _fbRL = makeRateLimiter({ windowMs: 86_400_000, max: 3 }); // 3 per 24 hours

// POST /api/feedback  { message, page, ans, ctoken }
app.post('/api/feedback', (req, res) => {
  const ip = clientIp(req);   // stored in full; the limit counts per rateKey

  const capErr = _captchaFail(req.body);
  if (capErr) return res.status(400).json(capErr);

  if (!_fbRL.allow(rateKey(ip))) return res.status(429).json({ error: 'Limit reached: 3 messages per 24 hours.' });

  const message = str(req.body?.message).trim().slice(0, 2000);
  // `page` lands in a mail Subject: no CR/LF or other control characters, ever.
  const page    = cleanHeaderText(req.body?.page, 200);

  if (message.length < 10) return res.status(400).json({ error: 'Message too short (minimum 10 characters).' });

  // Block duplicate messages submitted in the last 24 hours
  const duplicate = db.prepare(
    "SELECT 1 FROM feedback WHERE message = ? AND created >= datetime('now', '-24 hours') LIMIT 1"
  ).get(message);
  if (duplicate) return res.status(400).json({ error: 'This message was already submitted recently.' });

  db.prepare('INSERT INTO feedback (id, page, message, ip) VALUES (?, ?, ?, ?)')
    .run(genId(), page, message, ip);

  // Email notification via OS sendmail (fire-and-forget)
  const _fbSubject = `[Office Tools Feedback] ${page || 'unknown page'}`;
  const _fbBody    = `Page: ${page}\nIP: ${ip}\n\n${message}`;
  const _ne1 = (process.env.NOTIFY_EMAIL   || '').trim();
  const _ne2 = (process.env.NOTIFY_EMAIL_2 || '').trim();
  if (_ne1) _sendmailNotify(_ne1, _fbSubject, _fbBody);
  if (_ne2) _sendmailNotify(_ne2, _fbSubject, _fbBody);

  res.json({ ok: true });
});

// ── IP Geolocation proxy ──────────────────────────────────────
// ip-api.com free tier only allows HTTP, not HTTPS — proxy it server-side
const _geoRL = makeRateLimiter({ windowMs: 60_000, max: 20 });

const _GEO_FIELDS = 'status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,query';

// ip-api's free tier allows 45 requests/min for the WHOLE server, so answers are cached
// per looked-up address: a success for 1 h (geo data changes rarely), a "fail" answer
// (private range, invalid query) for 5 min.
const _geoOk   = makeTtlCache({ ttlMs: 3_600_000, maxEntries: 5000 });
const _geoFail = makeTtlCache({ ttlMs: 300_000, maxEntries: 2000 });

app.get('/api/ip/geo', async (req, res) => {
  if (!_geoRL.allow(rateKey(clientIp(req)))) return res.status(429).json({ error: 'Rate limit exceeded' });

  // `?ip[]=a` makes req.query.ip an array — str() reads anything but a string as missing.
  const target = str(req.query.ip).trim();
  if (!target) return res.status(400).json({ error: 'Missing ip parameter' });

  // strip brackets from IPv6
  const clean = target.replace(/^\[|\]$/g, '');
  if (!/^[a-zA-Z0-9.\-:_]+$/.test(clean)) return res.status(400).json({ error: 'Invalid IP or host' });

  const ck = clean.toLowerCase();
  const hit = _geoOk.get(ck) || _geoFail.get(ck);
  if (hit) return res.json(hit);

  try {
    const r = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(clean)}?fields=${_GEO_FIELDS}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await r.json();
    // Only a real ip-api answer is cached; an HTTP error (its 45/min quota) is not.
    if (r.ok && data?.status === 'success') _geoOk.set(ck, data);
    else if (r.ok && data?.status === 'fail') _geoFail.set(ck, data);
    res.json(data);
  } catch (err) {
    console.error('[ip/geo]', err.message);
    res.status(502).json({ error: 'Geo lookup failed. Please try again.' });
  }
});

// ── Public IP echo (ipify-style) ──────────────────────────────
// Returns ONLY the caller's public IP — the address the request arrived from, as
// seen server-side. Like api.ipify.org, so other tools / scripts can fetch their
// public IP in one line. Served at the short path /tools-api/ip (nginx strips the
// /tools-api/ prefix → backend /ip); /api/ip is kept as a back-compat alias.
// Open CORS (publicCors) + plain-text default so it's usable from any page or shell.
//
//   GET /ip                 → "203.0.113.7"          (text/plain, no newline)
//   GET /ip?format=json     → {"ip":"203.0.113.7","family":"ipv4","ipv4":"203.0.113.7","ipv6":null}
//   GET /ip?format=jsonp&callback=fn → fn({...same object...});
//   (only the connected family is filled; the other is null — see note below)
//
// IPv4 vs IPv6: this echoes whichever family the client physically connected over —
// a path/hostname cannot force a family the connection didn't use. From a shell, pin
// it with `curl -4`/`curl -6`; for a per-family hostname you need v4-only / v6-only
// DNS (the front-end's split display borrows api4./api6.ipify.org for this).
const _ipEchoRL = makeRateLimiter({ windowMs: 60_000, max: 60 });

// The echoed address is the FULL visitor IP (lib/client-ip.js, which also turns
// ::ffff:1.2.3.4 into 1.2.3.4); only the rate limit counts per rateKey.
app.get(['/ip', '/api/ip'], publicCors, (req, res) => {
  const ip = clientIp(req);
  if (!_ipEchoRL.allow(rateKey(ip))) return res.status(429).json({ error: 'Rate limit: 60 requests/minute. Please wait.' });

  res.setHeader('Cache-Control', 'no-store');
  const format = String(req.query.format || '').toLowerCase();

  if (format === 'json' || format === 'jsonp') {
    // Only the family the request physically arrived on can be known here; the
    // other stays null (filling both needs v4-only/v6-only hostnames). `family`
    // says which, so callers can read .ipv4 / .ipv6 without parsing the string.
    const family = net.isIPv6(ip) ? 'ipv6' : (net.isIPv4(ip) ? 'ipv4' : null);
    const payload = {
      ip,
      family,
      ipv4: family === 'ipv4' ? ip : null,
      ipv6: family === 'ipv6' ? ip : null,
    };
    if (format === 'json') return res.json(payload);
    const cb = String(req.query.callback || 'callback');
    // Only allow a safe JS identifier as the callback name.
    const safe = /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/.test(cb) ? cb : 'callback';
    res.setHeader('Content-Type', 'application/javascript');
    return res.send(`${safe}(${JSON.stringify(payload)});`);
  }
  res.type('text/plain').send(ip);
});

// ── Web Proxy & Website Status ────────────────────────────────
//
//   GET /api/net/uptime?url=        is a site up? status, latency, redirect, SSL expiry
//   GET /api/net/proxy?url=&self=&strip=   reader-mode fetch + HTML link/asset rewrite
//   GET /api/net/redirects?url=    every hop of a redirect chain (URL Expander)
//
// SSRF guard: all three routes go through lib/safe-fetch.js. Every hop — the first URL and
// every redirect target — is validated at CONNECT time on the exact address the socket
// uses (no check-then-fetch rebinding window), and a redirect to a private / loopback /
// link-local / cloud-metadata address is refused before any connection is made.
// Only http(s) URLs. Never call fetch() / http.request on a user URL in this section.

// Map a SafeFetchError from normalizeUserUrl (bad input) → 400 { error }.
function _badUrl(res, e) {
  return res.status(400).json({ error: e?.message || 'Invalid URL' });
}
// A private INPUT (nothing fetched) vs a public URL that redirected somewhere private.
function _blockedMsg(redirected, url) {
  if (redirected) return 'Redirect to a private / internal address refused';
  return net.isIP(url.hostname.replace(/^\[|\]$/g, ''))
    ? 'Refusing to fetch a private / internal address'
    : 'Host resolves to a private / internal address';
}

// Global in-flight caps (lib/outbound-guards.js), past which a request is answered 503
// with a readable { error } (both pages print `error` as given). They are the limits a
// spoofed or rotated client address cannot get round; the per-IP limiters stay in front.
// - uptime: 32 checks at once (one check is up to 25 s of outbound requests; netRL is
//   10/min per visitor, so 32 is several busy visitors at once).
// - proxy: 128 fetches at once. One proxied page fans out into one request per image,
//   stylesheet and font, and over HTTP/2 a browser sends dozens of them together, so the
//   cap is set well above what a single visitor's page view needs.
const _uptimeSlots = makeInFlight(32);
const _proxySlots  = makeInFlight(128);
const _NET_BUSY_MSG = 'The server is busy right now. Please try again in a few seconds.';

// GET /api/net/uptime?url=
// Follows the chain hop by hop (traceRedirects: HTTP 3xx, Refresh header, meta refresh).
// The response shape is what tools/website-status renders, plus `hops` (redirect count).
// The `error` reason (timeout / Connection refused / …) is shown by the page as the
// "Reason" a site is down, so it is passed through as traceRedirects words it.
app.get('/api/net/uptime', netRLMiddleware, async (req, res) => {
  const raw = String(req.query.url || '').trim();
  if (!raw) return res.status(400).json({ error: 'Missing url' });
  let url;
  try { ({ url } = safeFetch.normalizeUserUrl(raw)); }
  catch (e) { return _badUrl(res, e); }

  const release = _uptimeSlots.tryAcquire();
  if (!release) return res.status(503).json({ error: _NET_BUSY_MSG });
  // A client that leaves aborts the trace (up to 25 s of outbound requests).
  const gone = watchClientClose(res);
  try {
    await _uptimeCheck(res, url, gone);
  } finally {
    release();
    gone.dispose();
  }
});

async function _uptimeCheck(res, url, gone) {
  let t;
  try { t = await safeFetch.traceRedirects(url, { signal: gone.signal }); }
  catch (e) {
    if (e?.code === 'ERR_ABORTED') return;             // client gone: nothing to send
    return res.json({ url: url.href, up: false, responseMs: 0, error: e?.code || 'request failed' });
  }
  if (gone.closed()) return;

  if (t.stop === 'blocked') {
    return res.status(403).json({ error: _blockedMsg(t.hops.length > 0, url), url: url.href });
  }
  if (t.stop !== 'final') {
    // stopDetail is "<url> — <reason>" for timeout/error; loop / max-hops / non-web-scheme
    // are reported by name. Only the reason is returned, never a response body.
    const detail = String(t.stopDetail || '');
    const reason = t.stop === 'timeout' ? 'timeout'
      : t.stop === 'error' ? (detail.includes(' — ') ? detail.slice(detail.lastIndexOf(' — ') + 3) : 'connection failed')
      : t.stop === 'loop' ? 'redirect loop'
      : t.stop === 'max-hops' ? 'too many redirects'
      : t.stop === 'non-web-scheme' ? 'redirect to a non-web address'
      : t.stop;
    return res.json({ url: url.href, up: false, responseMs: t.totalMs, error: reason, hops: t.hops.length });
  }

  const f = t.final;
  // Certificate of the FINAL host, read from the IP that hop actually connected to.
  const cert = f.url.startsWith('https:') ? await safeFetch.certInfo(f.url, f.ip) : null;
  if (gone.closed()) return;
  res.json({
    url: url.href,
    finalUrl: f.url,
    status: f.status,
    up: true,
    ok: f.status < 400,
    responseMs: t.totalMs,
    redirected: t.hops.length > 0,
    server: f.server || null,
    contentType: f.contentType || null,
    cert,
    hops: t.hops.length,
  });
}

// Dedicated proxy rate limiter — one page pulls many assets, so allow more
const proxyRLMiddleware = makeRateLimiter({
  windowMs: 60_000, max: 240,
  message: 'Rate limit: 240 requests/minute. Please slow down.',
}).middleware;

const _PROXY_MAX_BYTES = 12 * 1024 * 1024; // 12 MB cap per resource

// HTML rewrite + response headers: lib/proxy-rewrite.js (linear patterns, sandboxed origin).

// GET /api/net/proxy?url=&self=&strip=
app.get('/api/net/proxy', proxyRLMiddleware, async (req, res) => {
  const raw = String(req.query.url || '').trim();
  if (!raw) return res.status(400).json({ error: 'Missing url' });
  const stripScripts = req.query.strip !== '0';
  // Where rewritten links should point back to (the public proxy endpoint): the page's
  // `self` only when it names this site (lib/outbound-guards.js proxySelfBase), else the
  // server-derived URL.
  const selfBase = proxySelfBase(req, CORS_ORIGINS);

  let url;
  try { ({ url } = safeFetch.normalizeUserUrl(raw)); }
  catch (e) { return _badUrl(res, e); }

  const release = _proxySlots.tryAcquire();
  if (!release) return res.status(503).json({ error: _NET_BUSY_MSG });
  // A client that leaves aborts the upstream fetch (up to 15 s and 12 MB).
  const gone = watchClientClose(res);
  try {
    await _proxyFetch(res, url, selfBase, stripScripts, gone);
  } finally {
    release();
    gone.dispose();
  }
});

// Socket-level failures (refused, reset, unreachable, timed out, TLS) are reported as one
// message: telling them apart would let the proxy map which ports of an arbitrary host
// are open. A failure after an HTTP answer (too many redirects, bad redirect, decode)
// keeps its own message.
const _PROXY_KEEP_MSG = new Set(['ERR_TOO_MANY_REDIRECTS', 'ERR_BAD_REDIRECT', 'ERR_UNSUPPORTED_PROTOCOL', 'ERR_DECODE', 'ERR_BAD_URL']);

async function _proxyFetch(res, url, selfBase, stripScripts, gone) {
  try {
    // Redirects are followed by the lib, one guarded hop at a time. The 12 MB cap is on
    // DECODED bytes and is enforced while streaming, never after buffering everything.
    const r = await safeFetch.fetchFollow(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      maxBytes: _PROXY_MAX_BYTES,
      totalTimeoutMs: 15000,
      signal: gone.signal,
    });
    if (gone.closed()) return;

    const ct = r.headers['content-type'] || '';
    const finalUrl = r.url;
    const buf = r.body;

    // Frame-safe headers so the result can render in our iframe
    res.removeHeader?.('X-Frame-Options');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const isHtml = /text\/html|application\/xhtml/i.test(ct);
    // Sandboxed (opaque origin): proxied content must never run as OUR origin.
    for (const [k, v] of Object.entries(proxyRewrite.proxyHeaders(isHtml))) res.setHeader(k, v);

    if (isHtml) {
      const html = proxyRewrite.rewriteHtml(buf.toString('utf8'), finalUrl, selfBase, stripScripts);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(r.status < 400 ? 200 : r.status).send(html);
    }

    // Non-HTML asset (image, css, font, …) — pass through with original type
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(buf);
  } catch (err) {
    if (err?.code === 'ERR_ABORTED' || gone.closed()) return;   // client gone: nothing to send
    if (err?.code === 'ERR_SSRF_BLOCKED') {
      return res.status(403).json({ error: _blockedMsg(err.redirects > 0, url) });
    }
    if (err?.code === 'ERR_BODY_TOO_LARGE') {
      return res.status(413).json({ error: 'Resource too large (max 12 MB)' });
    }
    // Our own message — never a response body, a resolved address or a socket error code.
    const reason = (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') ? 'could not resolve host'
      : (err instanceof safeFetch.SafeFetchError && _PROXY_KEEP_MSG.has(err.code)) ? err.message
      : 'could not connect to the site, or it did not answer in time';
    res.status(502).json({ error: 'Proxy fetch failed: ' + reason });
  }
}

// GET /api/net/redirects?url=   (URL Expander — tools/url-expander)
// Every hop of a redirect chain, facts only: lib/redirects-route.js (contract, input
// checks, the 16-request global in-flight cap, abort on client disconnect) over
// traceRedirects. Normal CORS_ORIGINS allowlist, NOT publicCors. Its own 12/min limiter:
// one expansion is up to 11 outbound requests, so it does not share netRL's budget.
const redirectRL = makeRateLimiter({
  windowMs: 60_000, max: 12,
  message: 'Rate limit: 12 expansions/minute. Please wait a minute.',
});
app.get('/api/net/redirects', redirectRL.middleware, makeRedirectsHandler());

// ── Email tools — validation, deliverability, DNSBL, disposable, temp inbox ──
//
//   GET  /api/email/validate?email=             syntax + MX + disposable + role check
//   GET  /api/email/disposable?email=|domain=   disposable-domain check only
//   GET  /api/email/deliverability?domain=&selector=   MX / SPF / DMARC / DKIM / MTA-STS / BIMI
//   GET  /api/email/dnsbl?ip=|host=             check an IP against common DNSBL zones
//   POST /api/email/inbox/new                   { local? } → create a throwaway address
//   GET  /api/email/inbox/:address/messages     poll an inbox (the address is the secret)
//   DELETE /api/email/inbox/:address            burn an inbox
//   POST /api/email/inbox/ingest                MTA webhook — store an inbound message
//
// Reuses domainRLMiddleware (15/min) + the _domCache. DNS via Cloudflare DoH
// (dohJson helper) except DNSBL, which uses the OS resolver — public DoH resolvers
// (1.1.1.1) refuse Spamhaus-style queries, so DNSBL must hit the server's own resolver.

// Small DoH-over-JSON helper (Cloudflare). Returns the parsed dns-json object.
async function dohJson(name, type) {
  const r = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
    { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) throw new Error(`DNS query failed: ${r.status}`);
  return r.json();
}

// Strip surrounding quotes and join the space-split chunks DoH returns for long TXT records.
function txtValue(answer) {
  return String(answer.data || '').replace(/^"|"$/g, '').replace(/"\s+"/g, '');
}

// Curated set of well-known disposable / throwaway email domains. Not exhaustive —
// extend on the server or swap for a maintained list file later.
const _DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','10minutemail.com','guerrillamail.com','guerrillamail.net','guerrillamail.org',
  'sharklasers.com','grr.la','spam4.me','temp-mail.org','tempmail.com','tempmailo.com','tmpmail.org',
  'tmpmail.net','tmail.ws','throwawaymail.com','getnada.com','nada.email','dispostable.com',
  'yopmail.com','yopmail.net','yopmail.fr','trashmail.com','trashmail.net','mailnesia.com',
  'maildrop.cc','mailcatch.com','mohmal.com','fakeinbox.com','fakemailgenerator.com','emailondeck.com',
  'mailtemp.net','tempr.email','discard.email','discardmail.com','spamgourmet.com','mintemail.com',
  'mailexpire.com','jetable.org','mytemp.email','1secmail.com','1secmail.net','1secmail.org',
  'emailfake.com','generator.email','inboxkitten.com','mailpoof.com','burnermail.io','33mail.com',
  'anonbox.net','deadaddress.com','despam.it','spambox.us','mailnull.com','tempinbox.com',
  'temp-mail.io','luxusmail.org','moakt.com','moakt.cc','mailbox.in.ua','vomoto.com','cock.li',
  'guerrillamailblock.com','pokemail.net','spam.la','incognitomail.org','mvrht.net','tempail.com',
  'mailde.de','mail-temp.com','tempemail.co','wegwerfmail.de','minuteinbox.com','mailto.plus',
  'fexbox.org','rover.info','inbox.lv','msgsafe.io','byom.de','spambog.com','harakirimail.com',
]);

// Common e-mail "role" local-parts (not a person — a function/department mailbox).
const _ROLE_LOCALS = new Set([
  'admin','administrator','postmaster','hostmaster','webmaster','abuse','noc','security','root',
  'info','support','help','helpdesk','contact','sales','billing','accounts','accounting','hr',
  'jobs','careers','marketing','press','media','legal','privacy','compliance','feedback',
  'noreply','no-reply','donotreply','do-not-reply','mailer-daemon','daemon','office','team',
  'hello','hi','enquiries','enquiry','inquiries','service','services','orders','order','newsletter',
]);

function _parseEmail(raw) {
  const email = String(raw || '').trim();
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const local  = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase().replace(/\.$/, '');
  return { email, local, domain };
}

// Fairly strict but practical RFC 5322-ish address syntax check.
const _EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// GET /api/email/validate
app.get('/api/email/validate', domainRLMiddleware, async (req, res) => {
  const parsed = _parseEmail(req.query.email);
  if (!parsed) return res.status(400).json({ error: 'Provide a full email address (name@domain)' });
  const { email, local, domain } = parsed;

  const out = {
    email, local, domain,
    syntax_valid: _EMAIL_RE.test(email) && email.length <= 254 && local.length <= 64,
    role_based:   _ROLE_LOCALS.has(local.toLowerCase()),
    disposable:   _DISPOSABLE_DOMAINS.has(domain),
    has_mx: false, mx: [], accepts_mail: false, warnings: [],
  };

  if (out.syntax_valid) {
    try {
      const mx = await dohJson(domain, 'MX');
      const ans = (mx.Answer || []).filter(a => a.type === 15);
      out.mx = ans
        .map(a => { const m = String(a.data).match(/^(\d+)\s+(.+?)\.?$/); return m ? { priority: +m[1], host: m[2] } : null; })
        .filter(Boolean).sort((a, b) => a.priority - b.priority);
      out.has_mx = out.mx.length > 0;
      if (out.has_mx) out.accepts_mail = true;
      else {
        // No MX → some domains still accept mail on their A/AAAA (implicit MX).
        const a = await dohJson(domain, 'A');
        if ((a.Answer || []).some(r => r.type === 1)) { out.accepts_mail = true; out.warnings.push('No MX record — domain may accept mail on its A record (implicit MX).'); }
        else out.warnings.push('No MX or A record — this domain cannot receive email.');
      }
    } catch { out.warnings.push('MX lookup failed — the DNS service did not answer. Please try again.'); }
  }

  if (out.disposable) out.warnings.push('Disposable / throwaway email provider.');
  if (out.role_based) out.warnings.push('Role-based address (a department/function, not a person).');

  out.deliverable = out.syntax_valid && out.accepts_mail && !out.disposable;
  res.json(out);
});

// GET /api/email/disposable
app.get('/api/email/disposable', domainRLMiddleware, (req, res) => {
  let domain = String(req.query.domain || '').trim().toLowerCase();
  if (req.query.email) { const p = _parseEmail(req.query.email); if (p) domain = p.domain; }
  domain = domain.replace(/^@/, '').replace(/\.$/, '');
  if (!validDomain(domain)) return res.status(400).json({ error: 'Provide an email or domain' });
  res.json({ domain, disposable: _DISPOSABLE_DOMAINS.has(domain) });
});

// GET /api/email/deliverability — MX / SPF / DMARC / DKIM / MTA-STS / BIMI
const _DKIM_SELECTORS = ['default','google','selector1','selector2','k1','k2','dkim','mail','s1','s2','mxvault','smtp','key1','protonmail','protonmail2','protonmail3','zoho','fm1','fm2','fm3'];

app.get('/api/email/deliverability', domainRLMiddleware, async (req, res) => {
  const domain = String(req.query.domain || '').trim().toLowerCase().replace(/^www\.|^@/, '').replace(/\.$/, '');
  if (!validDomain(domain)) return res.status(400).json({ error: 'Invalid domain name' });

  const userSel = str(req.query.selector).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 63);
  const ck = 'edeliv:' + domain + ':' + userSel;
  const cached = dcGet(ck);
  if (cached) return res.json({ ...cached, cached: true });

  const selectors = [...new Set([userSel, ..._DKIM_SELECTORS].filter(Boolean))].slice(0, 24);

  try {
    const [mxR, spfR, dmarcR, mtaStsR, bimiR] = await Promise.all([
      dohJson(domain, 'MX').catch(() => ({})),
      dohJson(domain, 'TXT').catch(() => ({})),
      dohJson('_dmarc.' + domain, 'TXT').catch(() => ({})),
      dohJson('_mta-sts.' + domain, 'TXT').catch(() => ({})),
      dohJson('default._bimi.' + domain, 'TXT').catch(() => ({})),
    ]);

    // MX
    const mx = (mxR.Answer || []).filter(a => a.type === 15)
      .map(a => { const m = String(a.data).match(/^(\d+)\s+(.+?)\.?$/); return m ? { priority: +m[1], host: m[2] } : null; })
      .filter(Boolean).sort((a, b) => a.priority - b.priority);

    // SPF — the TXT record starting v=spf1
    const txts = (spfR.Answer || []).filter(a => a.type === 16).map(txtValue);
    const spfRec = txts.find(t => /^v=spf1\b/i.test(t)) || null;

    // DMARC
    const dmarcTxts = (dmarcR.Answer || []).filter(a => a.type === 16).map(txtValue);
    const dmarcRec = dmarcTxts.find(t => /^v=DMARC1\b/i.test(t)) || null;
    let dmarcPolicy = null;
    if (dmarcRec) { const m = dmarcRec.match(/[;\s]p=([a-z]+)/i); dmarcPolicy = m ? m[1].toLowerCase() : null; }

    // MTA-STS / BIMI presence
    const mtaSts = (mtaStsR.Answer || []).filter(a => a.type === 16).map(txtValue).find(t => /^v=STSv1\b/i.test(t)) || null;
    const bimi   = (bimiR.Answer   || []).filter(a => a.type === 16).map(txtValue).find(t => /^v=BIMI1\b/i.test(t)) || null;

    // DKIM — probe common selectors until one returns a v=DKIM1 / p= TXT or CNAME
    let dkim = null;
    for (const sel of selectors) {
      try {
        const d = await dohJson(`${sel}._domainkey.${domain}`, 'TXT');
        const rec = (d.Answer || []).filter(a => a.type === 16).map(txtValue).find(t => /(^v=DKIM1\b|[;\s]?p=)/i.test(t));
        if (rec) { dkim = { selector: sel, record: rec }; break; }
        // some providers CNAME the selector to a hosted key
        const c = (d.Answer || []).find(a => a.type === 5);
        if (c) { dkim = { selector: sel, cname: String(c.data).replace(/\.$/, '') }; break; }
      } catch { /* try next selector */ }
    }

    const data = {
      domain,
      mx:     { found: mx.length > 0, records: mx },
      spf:    { found: !!spfRec, record: spfRec },
      dmarc:  { found: !!dmarcRec, record: dmarcRec, policy: dmarcPolicy },
      dkim:   { found: !!dkim, ...(dkim || {}), selectors_tried: selectors },
      mta_sts:{ found: !!mtaSts, record: mtaSts },
      bimi:   { found: !!bimi, record: bimi },
    };
    // Coarse 0–100 score: MX 25, SPF 20, DMARC 25 (+10 if enforcing), DKIM 20
    let score = 0;
    if (data.mx.found) score += 25;
    if (data.spf.found) score += 20;
    if (data.dmarc.found) score += (dmarcPolicy === 'reject' || dmarcPolicy === 'quarantine') ? 25 : 15;
    if (data.dkim.found) score += 20;
    if (data.mta_sts.found) score += 10;
    data.score = Math.min(100, score);
    dcSet(ck, data);
    res.json(data);
  } catch (err) {
    console.error('[email/deliverability]', err.message);
    res.status(500).json({ error: 'Deliverability check failed. Please try again.' });
  }
});

// GET /api/email/dnsbl — check an IPv4 against common DNS blocklists
const _DNSBL_ZONES = [
  'zen.spamhaus.org','bl.spamcop.net','b.barracudacentral.org','dnsbl.sorbs.net',
  'psbl.surriel.com','dnsbl-1.uceprotect.net','ix.dnsbl.manitu.net','bl.mailspike.net',
  'all.s5h.net','dnsbl.dronebl.org','spam.dnsbl.anonmails.de','db.wpbl.info',
];
const _dnsblResolver = new dns.promises.Resolver({ timeout: 4000, tries: 1 });

app.get('/api/email/dnsbl', domainRLMiddleware, async (req, res) => {
  let target = String(req.query.ip || req.query.host || '').trim().replace(/^\[|\]$/g, '');
  if (!target) return res.status(400).json({ error: 'Provide an ip or host' });

  // Resolve a hostname to its IPv4 first (DNSBLs are keyed on IPv4).
  if (!net.isIPv4(target)) {
    if (net.isIPv6(target)) return res.status(400).json({ error: 'DNSBL checks support IPv4 only' });
    if (!validDomain(target)) return res.status(400).json({ error: 'Invalid IP or hostname' });
    try { const a = await dohJson(target, 'A'); const ip = (a.Answer || []).find(r => r.type === 1); if (!ip) return res.status(404).json({ error: 'Host has no A record' }); target = ip.data; }
    catch { return res.status(502).json({ error: 'Could not resolve host — the DNS service did not answer. Please try again.' }); }
  }

  const reversed = target.split('.').reverse().join('.');
  const results = await Promise.all(_DNSBL_ZONES.map(async zone => {
    const query = `${reversed}.${zone}`;
    try {
      const codes = await _dnsblResolver.resolve4(query);
      let txt = null;
      try { txt = (await _dnsblResolver.resolveTxt(query)).map(c => c.join('')).join(' '); } catch { /* optional */ }
      return { zone, listed: true, codes, reason: txt };
    } catch (err) {
      if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') return { zone, listed: false };
      return { zone, listed: null, error: err.code || 'lookup failed' };
    }
  }));

  const listed = results.filter(r => r.listed === true).length;
  res.json({ ip: target, checked: results.length, listed, clean: listed === 0, results });
});

// ── Temp inbox (throwaway email) ──────────────────────────────
// Receives mail only after the operator points an MX at this box and pipes inbound
// messages to POST /api/email/inbox/ingest (shared-secret auth). Without that wiring
// the tool still generates addresses but no mail arrives — see the tool's About box.
const TEMP_INBOX_DOMAIN = (process.env.TEMP_INBOX_DOMAIN || '').trim().toLowerCase();
const INBOX_INGEST_SECRET = (process.env.INBOX_INGEST_SECRET || '').trim();
const _INBOX_TTL_MIN = parseInt(process.env.TEMP_INBOX_TTL_MIN, 10) || 60;

// Prune expired inboxes + their mail every 5 min.
function _pruneInboxes() {
  try {
    const dead = db.prepare("SELECT address FROM temp_inbox WHERE expires < datetime('now')").all();
    for (const r of dead) {
      db.prepare('DELETE FROM temp_mail  WHERE address = ?').run(r.address);
      db.prepare('DELETE FROM temp_inbox WHERE address = ?').run(r.address);
    }
  } catch (e) { console.error('[temp-inbox prune]', e.message); }
}
setInterval(_pruneInboxes, 300_000).unref();

// The address is the bearer secret for reading an inbox, so the random part is crypto:
// 10 chars of [0-9a-z].
function _randLocal() {
  return _randChars(10);
}

// Local parts that belong to the domain's operator, never to a throwaway inbox.
const _INBOX_RESERVED = new Set([
  'postmaster','abuse','admin','administrator','hostmaster','webmaster','root','security',
  'noreply','no-reply','mailer-daemon','ssladmin','sslwebmaster','info','support',
]);
const _INBOX_MAX_MAILS = 50;   // newest kept; the poll returns at most 50 anyway

// POST /api/email/inbox/new  { local? }
// Never takes over an address that is still live: a requested local part that is
// reserved or in use is answered with an error; a random one is re-drawn.
// (tools/temp-inbox sends {} and always gets a random address.)
app.post('/api/email/inbox/new', domainRLMiddleware, (req, res) => {
  if (!TEMP_INBOX_DOMAIN) return res.status(503).json({ error: 'Temp inbox not configured (TEMP_INBOX_DOMAIN missing in .env)' });
  let local = str(req.body?.local).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const requested = !!local && local.length >= 3 && local.length <= 32;
  if (requested && _INBOX_RESERVED.has(local)) return res.status(400).json({ error: 'That address is reserved. Pick another name.' });
  const ip = clientIp(req);
  const insert = db.prepare("INSERT INTO temp_inbox (address, ip, expires) VALUES (?, ?, datetime('now', ?))");
  const clearExpired = db.prepare("DELETE FROM temp_inbox WHERE address = ? AND expires < datetime('now')");
  const clearMail = db.prepare('DELETE FROM temp_mail WHERE address = ? AND NOT EXISTS (SELECT 1 FROM temp_inbox WHERE address = ?)');
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!requested) local = _randLocal();
    const address = `${local}@${TEMP_INBOX_DOMAIN}`;
    try {
      clearExpired.run(address);
      clearMail.run(address, address);       // an expired inbox's old mail never reaches the new owner
      insert.run(address, ip, `+${_INBOX_TTL_MIN} minutes`);
      return res.json({ address, ttl_minutes: _INBOX_TTL_MIN, domain: TEMP_INBOX_DOMAIN });
    } catch (e) {
      if (!String(e?.message).includes('UNIQUE')) {
        console.error('[temp-inbox new]', e?.message);
        return res.status(500).json({ error: 'Server error' });
      }
      if (requested) return res.status(409).json({ error: 'That address is already in use. Pick another name.' });
    }
  }
  res.status(503).json({ error: 'Could not allocate an address — please try again.' });
});

// GET /api/email/inbox/:address/messages — the address itself is the bearer secret
app.get('/api/email/inbox/:address/messages', domainRLMiddleware, (req, res) => {
  const address = String(req.params.address || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]+@[a-z0-9.-]+$/.test(address)) return res.status(400).json({ error: 'Invalid address' });
  const box = db.prepare("SELECT address, expires FROM temp_inbox WHERE address = ? AND expires >= datetime('now')").get(address);
  if (!box) return res.status(404).json({ error: 'Inbox not found or expired' });
  const msgs = db.prepare('SELECT id, mail_from, subject, body_text, body_html, received FROM temp_mail WHERE address = ? ORDER BY received DESC LIMIT 50').all(address);
  res.json({ address, expires: box.expires, count: msgs.length, messages: msgs });
});

// DELETE /api/email/inbox/:address
app.delete('/api/email/inbox/:address', domainRLMiddleware, (req, res) => {
  const address = String(req.params.address || '').trim().toLowerCase();
  db.prepare('DELETE FROM temp_mail  WHERE address = ?').run(address);
  db.prepare('DELETE FROM temp_inbox WHERE address = ?').run(address);
  res.json({ ok: true });
});

// POST /api/email/inbox/ingest — MTA webhook. Auth: X-Ingest-Secret header.
//   { to, from, subject, text, html }
// The secret is checked (constant time) BEFORE the body is read; the body limit is
// sized for the field caps below (300 000 chars; JSON may escape each to 6 bytes).
function _ingestAuth(req, res, next) {
  const got = req.headers['x-ingest-secret'];
  const ok = !!INBOX_INGEST_SECRET && typeof got === 'string' && (() => {
    const a = Buffer.from(got), b = Buffer.from(INBOX_INGEST_SECRET);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  })();
  if (!ok) return res.status(403).json({ error: 'Forbidden' });
  next();
}
app.post('/api/email/inbox/ingest', _ingestAuth, express.json({ limit: '2mb' }), (req, res) => {
  const to = str(req.body?.to).trim().toLowerCase();
  const address = (to.match(/[a-z0-9._-]+@[a-z0-9.-]+/) || [to])[0];
  if (!address) return res.status(400).json({ error: 'Missing recipient' });
  const box = db.prepare("SELECT address FROM temp_inbox WHERE address = ? AND expires >= datetime('now')").get(address);
  if (!box) return res.status(404).json({ error: 'No active inbox for recipient' });
  db.prepare('INSERT INTO temp_mail (id, address, mail_from, subject, body_text, body_html) VALUES (?, ?, ?, ?, ?, ?)')
    .run(genId(), address,
      str(req.body?.from).slice(0, 320),
      str(req.body?.subject).slice(0, 500),
      str(req.body?.text).slice(0, 100_000),
      str(req.body?.html).slice(0, 200_000));
  // Keep only the newest _INBOX_MAX_MAILS per inbox.
  db.prepare(`DELETE FROM temp_mail WHERE address = ? AND id NOT IN
    (SELECT id FROM temp_mail WHERE address = ? ORDER BY received DESC, rowid DESC LIMIT ?)`)
    .run(address, address, _INBOX_MAX_MAILS);
  res.json({ ok: true });
});

// ── File Drop — ICE / TURN credentials (/api/tools/turn) ──────
// Same-Wi-Fi transfers fail on routers with AP/client isolation and on
// restrictive NATs: STUN can only discover addresses, it cannot relay, and with
// no relay there is no fallback path. A TURN server relays the (already DTLS-
// encrypted) media when no direct route exists. To avoid baking a long-lived
// TURN password into public JS — which would let anyone abuse the relay — we
// hand out short-lived credentials using coturn's `use-auth-secret` REST scheme:
//   username   = <unix-expiry-timestamp>
//   credential = base64( HMAC-SHA1( TURN_SECRET, username ) )
// Configure via .env (seeded by deploy.sh): TURN_URLS (comma-separated turn:/
// turns: URIs), TURN_SECRET, optional TURN_TTL (seconds, default 3600) and
// STUN_URLS. With TURN_SECRET/TURN_URLS unset the response is STUN-only, so File
// Drop keeps working over direct P2P and nothing breaks before coturn exists.
const TURN_URLS   = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
const TURN_SECRET = (process.env.TURN_SECRET || '').trim();
const TURN_TTL    = Math.max(300, Math.min(86400, parseInt(process.env.TURN_TTL || '3600', 10) || 3600));
const STUN_URLS   = (process.env.STUN_URLS ||
  'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302')
  .split(',').map(s => s.trim()).filter(Boolean);

// File Drop fetches this once on load and then about once per TTL (it caches the
// answer until a minute before expiry), so 30/min per visitor is far above real use.
const _turnRL = makeRateLimiter({ windowMs: 60_000, max: 30, message: 'Too many requests. Please wait a minute.' });
app.get('/api/tools/turn', _turnRL.middleware, (_req, res) => {
  const iceServers = STUN_URLS.length ? [{ urls: STUN_URLS }] : [];
  if (TURN_URLS.length && TURN_SECRET) {
    const username   = String(Math.floor(Date.now() / 1000) + TURN_TTL);
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    iceServers.push({ urls: TURN_URLS, username, credential });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers, ttl: TURN_TTL });
});

// ── File Drop — WebRTC signaling relay (/drop-ws) ─────────────
// Serves tools/file-drop: browser-to-browser file transfer. This endpoint only
// relays the WebRTC handshake (SDP/ICE JSON, a few KB per session) — file bytes
// travel peer-to-peer over DataChannels and never touch this server.
// Discovery: peers sharing a public IP see each other ("nearby"); a 6-digit
// room code pairs devices across networks. nginx proxies /tools-api/drop-ws
// here with Upgrade headers (exact-match location in deploy.sh).
const { WebSocketServer } = require('ws');

const DROP_MAX_CONN_PER_IP = 8;
const DROP_MAX_CONN_TOTAL  = 400;
const DROP_ROOM_MAX        = 10;
const _dropClients = new Map();   // id  → client
const _dropByIp    = new Map();   // ip  → Set<client>
const _dropRooms   = new Map();   // code → Set<client>

const _DROP_ADJ    = ['Brave','Calm','Clever','Cosmic','Gentle','Golden','Happy','Lucky','Mellow','Nimble','Quick','Quiet','Royal','Sunny','Swift','Wild','Witty','Zen'];
const _DROP_ANIMAL = ['Fox','Panda','Otter','Falcon','Tiger','Dolphin','Koala','Lynx','Owl','Rabbit','Wolf','Heron','Gecko','Bison','Crane','Seal','Moose','Yak'];

// Same-network grouping uses the visitor's FULL address (lib/client-ip.js); the
// per-visitor connection caps count per rateKey (an IPv6 visitor's /64).
const _dropKeyCount = new Map();  // rateKey → open connections
function _dropName() {
  return _DROP_ADJ[Math.floor(Math.random() * _DROP_ADJ.length)] + ' ' +
         _DROP_ANIMAL[Math.floor(Math.random() * _DROP_ANIMAL.length)];
}

// Failed `join-room` guesses: a 6-digit code is enumerable, so misses are capped per
// connection and per visitor. Only misses count — a correct code always joins unless
// this visitor already burnt their miss budget for the window.
const DROP_JOIN_MISS_PER_CONN = 5;
const _dropJoinMissRL = makeRateLimiter({ windowMs: 600_000, max: 20 });

// Browser WebSockets always send Origin; both sockets are used only by this site's
// pages (tools/file-drop, tools/chat-room), so the Origin must be one of CORS_ORIGINS.
// A missing Origin is refused too — there is no non-browser client of these sockets.
const _WS_ORIGINS = new Set(CORS_ORIGINS.map(o => o.replace(/\/+$/, '')).filter(Boolean));
function _wsOriginAllowed(req) {
  const o = req.headers.origin;
  return typeof o === 'string' && _WS_ORIGINS.has(o);
}
function _wsReject(socket, status) {
  try { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
  try { socket.destroy(); } catch { /* gone */ }
}
// A frame must parse to a plain JSON object; anything else is ignored.
function _wsParse(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  return msg && typeof msg === 'object' && !Array.isArray(msg) ? msg : null;
}
function _dropPublic(c) { return { id: c.id, name: c.name, device: c.device }; }
function _dropVisible(c) {
  const seen = new Set();
  for (const set of [_dropByIp.get(c.ip), c.room ? _dropRooms.get(c.room) : null]) {
    if (set) for (const p of set) if (p !== c) seen.add(p);
  }
  return [...seen];
}
function _dropSend(c, obj) {
  if (c.ws.readyState === 1) { try { c.ws.send(JSON.stringify(obj)); } catch { /* closing */ } }
}
function _dropSyncPeers(clients) {
  for (const c of clients) _dropSend(c, { type: 'peers', peers: _dropVisible(c).map(_dropPublic) });
}
function _dropLeaveRoom(c) {
  const code = c.room;
  if (!code) return;
  c.room = null;
  const room = _dropRooms.get(code);
  if (!room) return;
  room.delete(c);
  if (!room.size) _dropRooms.delete(code);
  else _dropSyncPeers([...room]);
}

// ── Shared WebSocket upgrade router ───────────────────────────
// Node fires EVERY 'upgrade' listener for each upgrade event, so multiple ad-hoc
// listeners cannot each `socket.destroy()` the paths they don't own — that would
// kill another route's freshly-upgraded socket. One dispatcher owns the upgrade
// event and routes by pathname; unknown paths are destroyed exactly once.
const _wsRoutes = new Map(); // pathname → (req, socket, head) => void
let _wsRouterInstalled = false;
function _wsRegister(server, pathname, handler) {
  _wsRoutes.set(pathname, handler);
  if (_wsRouterInstalled) return;
  _wsRouterInstalled = true;
  server.on('upgrade', (req, socket, head) => {
    const p = (req.url || '').split('?')[0];
    const h = _wsRoutes.get(p);
    if (!h) { socket.destroy(); return; }
    h(req, socket, head);
  });
}

function attachDropSignaling(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

  _wsRegister(server, '/drop-ws', (req, socket, head) => {
    if (!_wsOriginAllowed(req)) { _wsReject(socket, '403 Forbidden'); return; }
    const key = rateKey(clientIp(req));
    const perKey = _dropKeyCount.get(key) || 0;
    if (_dropClients.size >= DROP_MAX_CONN_TOTAL || perKey >= DROP_MAX_CONN_PER_IP) {
      socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    const c = {
      ws,
      ip,
      key: rateKey(ip),
      id: genId() + genId(),
      name: _dropName(),
      device: '',
      room: null,
      _msgs: 0,
      _msgWindow: Date.now(),
      _joinMisses: 0,
      isAlive: true,
    };
    _dropClients.set(c.id, c);
    if (!_dropByIp.has(c.ip)) _dropByIp.set(c.ip, new Set());
    _dropByIp.get(c.ip).add(c);
    _dropKeyCount.set(c.key, (_dropKeyCount.get(c.key) || 0) + 1);

    _dropSend(c, { type: 'you', id: c.id, name: c.name });
    _dropSyncPeers([c, ..._dropVisible(c)]);

    ws.on('pong', () => { c.isAlive = true; });

    function tooManyMisses(message) {
      _dropSend(c, { type: 'room-error', message });
      try { ws.close(1008, 'too many wrong codes'); } catch { /* closing */ }
    }

    // One bad frame must never throw out of this handler (it would reach the process).
    function onMessage(raw) {
      const now = Date.now();
      if (now - c._msgWindow > 10_000) { c._msgWindow = now; c._msgs = 0; }
      if (++c._msgs > 300) { ws.close(1008, 'rate limit'); return; }

      const msg = _wsParse(raw);
      if (!msg) return;
      switch (msg.type) {
        case 'hello': {
          c.device = stripCtl(msg.device).slice(0, 60);
          _dropSyncPeers([c, ..._dropVisible(c)]);
          break;
        }
        case 'create-room': {
          _dropLeaveRoom(c);
          let code;
          do { code = String(crypto.randomInt(100000, 1000000)); } while (_dropRooms.has(code));
          _dropRooms.set(code, new Set([c]));
          c.room = code;
          _dropSend(c, { type: 'room', code });
          break;
        }
        case 'join-room': {
          if (_dropJoinMissRL.blocked(c.key)) {
            tooManyMisses('Too many wrong codes from your network — wait 10 minutes and try again.');
            break;
          }
          const code = str(msg.code).trim();
          const room = /^[0-9]{6}$/.test(code) ? _dropRooms.get(code) : null;
          if (!room) {
            _dropJoinMissRL.allow(c.key);
            if (++c._joinMisses >= DROP_JOIN_MISS_PER_CONN) {
              tooManyMisses('Too many wrong codes — check the code on the other device and try again.');
            } else {
              _dropSend(c, { type: 'room-error', message: 'Code not found — ask the other device for a fresh one' });
            }
            break;
          }
          if (room.size >= DROP_ROOM_MAX) { _dropSend(c, { type: 'room-error', message: 'Room is full' }); break; }
          _dropLeaveRoom(c);
          room.add(c);
          c.room = code;
          _dropSend(c, { type: 'room', code });
          _dropSyncPeers([...room]);
          break;
        }
        case 'leave-room': {
          _dropLeaveRoom(c);
          _dropSend(c, { type: 'room', code: null });
          _dropSyncPeers([c]);
          break;
        }
        case 'signal': {
          // relay SDP/ICE — only between peers that can currently see each other
          const to = _dropClients.get(str(msg.to));
          if (to && _dropVisible(c).includes(to)) {
            _dropSend(to, { type: 'signal', from: c.id, data: msg.data });
          }
          break;
        }
      }
    }
    ws.on('message', raw => {
      try { onMessage(raw); }
      catch (e) {
        console.error('[drop-ws] message handler:', e?.message);
        try { ws.close(1011, 'error'); } catch { /* closing */ }
      }
    });

    ws.on('close', () => {
      const affected = _dropVisible(c);
      _dropClients.delete(c.id);
      const ipSet = _dropByIp.get(c.ip);
      if (ipSet) { ipSet.delete(c); if (!ipSet.size) _dropByIp.delete(c.ip); }
      const n = (_dropKeyCount.get(c.key) || 1) - 1;
      if (n > 0) _dropKeyCount.set(c.key, n); else _dropKeyCount.delete(c.key);
      _dropLeaveRoom(c);
      _dropSyncPeers(affected);
    });
    ws.on('error', () => {});
  });

  // Keepalive ping (Cloudflare drops silent WebSockets at ~100 s) + reap dead clients
  setInterval(() => {
    for (const c of _dropClients.values()) {
      if (!c.isAlive) { c.ws.terminate(); continue; }
      c.isAlive = false;
      try { c.ws.ping(); } catch { /* closing */ }
    }
  }, 30_000).unref();
}

// ── Group Chat Rooms — /chat-ws relay + temp file attachments ─
// A no-registration, ephemeral group chat: create a room → get an 8-char code →
// anyone worldwide joins with the code. Text messages are relayed IN MEMORY and
// never written to disk. Attachments ARE stored on disk temporarily (a group of
// 3+ people plus 2 GB files cannot stream peer-to-peer) under
// UPLOADS_DIR/chat/<code>/ and are deleted, with the whole room, the moment the
// last member leaves (short grace for reconnects; an idle-age backstop reaps any
// room a ghost connection might otherwise keep alive, and no room outlives 24 h
// from creation). See CLAUDE.md.

const CHAT_UPLOADS_DIR      = path.join(UPLOADS_DIR, 'chat');
const CHAT_MAX_CONN_TOTAL   = 600;
const CHAT_MAX_CONN_PER_IP  = 12;
const CHAT_ROOM_MAX_MEMBERS = 50;
const CHAT_MAX_FILE_BYTES   = 2 * 1024 * 1024 * 1024;      // 2 GB per file
const CHAT_ROOM_MAX_FILES   = 40;
const CHAT_ROOM_MAX_BYTES   = 6 * 1024 * 1024 * 1024;      // 6 GB aggregate per room
const CHAT_MSG_MAXLEN       = 4000;
const CHAT_NAME_MAXLEN      = 32;
const CHAT_HISTORY_KEEP     = 60;                          // in-memory recent msgs for late joiners
const CHAT_EMPTY_GRACE_MS   = 20_000;                      // delete room this long after it empties
const CHAT_ROOM_MAX_AGE_MS  = 12 * 3_600_000;             // backstop against ghost-kept rooms
const CHAT_ROOM_HARD_AGE_MS = 24 * 3_600_000;             // no room lives longer, active or not
const CHAT_ROOM_MAX_UPLOADS = 10;                          // concurrent uploads per room
const CHAT_INFLIGHT_MAX_BYTES = 8 * 1024 * 1024 * 1024;    // all rooms' uploads in progress

// Rooms live only in memory, so anything under CHAT_UPLOADS_DIR at boot belongs to a
// room that no longer exists. emptyDirInside only ever deletes inside that directory.
emptyDirInside(CHAT_UPLOADS_DIR, UPLOADS_DIR);

// Denylist of executable / script extensions — everything else is allowed. The
// final extension is what matters (foo.pdf.exe → "exe" → blocked). Downloads are
// always served as an attachment (never inline), so a renamed file can still only
// land on the downloader's disk, never execute in-page.
const CHAT_BLOCKED_EXT = new Set([
  'exe','dll','com','bat','cmd','msi','msix','scr','pif','cpl','hta','vbs','vbe',
  'js','mjs','jse','wsf','wsh','ws','ps1','psm1','ps1xml','psc1','psd1','reg','inf',
  'lnk','sys','drv','ocx','efi','elf','so','dylib','jar','jnlp','sh','bash','zsh',
  'csh','ksh','run','bin','out','apk','app','deb','rpm','dmg','pkg','gadget','msc',
  'application','appref-ms','ade','adp','mde','mdb','vb','scf','shb','shs','u3p',
  'xbap','mst','isu','job','paf','rgs','crt','der','pcd','prg','ins','isp','vbscript',
]);
function chatExtOf(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}
function chatExtBlocked(name) { return CHAT_BLOCKED_EXT.has(chatExtOf(name)); }

const _chatRooms   = new Map();   // code → room
const _chatClients = new Set();   // every connected /chat-ws client (joined or not)

// Unguessable 8-char code from an unambiguous alphabet (no 0/O/1/I/L). 32^8 ≈
// 1.1e12 combinations — not enumerable, unlike a 6-digit File Drop code.
const _CHAT_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function _chatCode() {
  let code;
  do {
    const bytes = crypto.randomBytes(8);
    code = '';
    for (let i = 0; i < 8; i++) code += _CHAT_ALPHABET[bytes[i] % _CHAT_ALPHABET.length];
  } while (_chatRooms.has(code));
  return code;
}

function _chatSend(c, obj) {
  if (c.ws.readyState === 1) { try { c.ws.send(JSON.stringify(obj)); } catch { /* closing */ } }
}
function _chatBroadcast(room, obj, except) {
  for (const c of room.members.values()) if (c !== except) _chatSend(c, obj);
}
function _chatMemberList(room) {
  return [...room.members.values()].map(c => ({ id: c.id, name: c.name }));
}
function _chatFileList(room) {
  return [...room.files.values()].map(f => ({ id: f.id, name: f.name, size: f.size, mime: f.mime, by: f.by, ts: f.ts }));
}
function _chatSyncMembers(room) {
  _chatBroadcast(room, { type: 'members', members: _chatMemberList(room) });
}

function _chatRoomNew() {
  const code = _chatCode();
  const room = {
    code,
    members: new Map(),   // id → client
    files:   new Map(),   // fileId → { id, name, size, mime, path, by, ts }
    bytes: 0,
    reserved: 0,          // bytes of uploads in progress (Content-Length reservations)
    uploading: 0,         // uploads in progress
    history: [],         // recent { from, name, text, ts } — memory only, never persisted
    createdAt: Date.now(),
    lastActivity: Date.now(),
    emptyTimer: null,
  };
  _chatRooms.set(code, room);
  return room;
}

function _chatDeleteRoom(room, reason) {
  if (!_chatRooms.has(room.code)) return;
  _chatRooms.delete(room.code);
  if (room.emptyTimer) { clearTimeout(room.emptyTimer); room.emptyTimer = null; }
  for (const c of room.members.values()) {
    _chatSend(c, { type: 'room-closed', reason: reason || 'Room closed' });
    c.room = null;
    c.uploadToken = null;
    try { c.ws.close(1000, 'room closed'); } catch { /* already closing */ }
  }
  room.members.clear();
  room.files.clear();
  fs.rm(path.join(CHAT_UPLOADS_DIR, room.code), { recursive: true, force: true }, () => {});
}

function _chatArmEmpty(room) {
  if (room.members.size > 0 || room.emptyTimer) return;
  room.emptyTimer = setTimeout(() => {
    room.emptyTimer = null;
    if (room.members.size === 0) _chatDeleteRoom(room, 'Everyone left — files were deleted');
  }, CHAT_EMPTY_GRACE_MS);
}
function _chatCancelEmpty(room) {
  if (room.emptyTimer) { clearTimeout(room.emptyTimer); room.emptyTimer = null; }
}

function _chatLeave(c, notify) {
  const room = c.room ? _chatRooms.get(c.room) : null;
  c.room = null;
  c.uploadToken = null;
  if (!room) return;
  room.members.delete(c.id);
  room.lastActivity = Date.now();
  if (notify !== false) _chatBroadcast(room, { type: 'notice', event: 'leave', id: c.id, name: c.name, ts: Date.now() });
  if (room.members.size === 0) _chatArmEmpty(room);
  else _chatSyncMembers(room);
}

function _chatJoin(c, code) {
  const room = _chatRooms.get(code);
  if (!room)                                      { _chatSend(c, { type: 'error', message: 'Room not found. Check the code, or create a new room.' }); return; }
  if (room.members.size >= CHAT_ROOM_MAX_MEMBERS) { _chatSend(c, { type: 'error', message: 'This room is full.' }); return; }
  _chatLeave(c, true);
  _chatCancelEmpty(room);
  room.members.set(c.id, c);
  c.room = code;
  c.uploadToken = newUploadToken();
  room.lastActivity = Date.now();
  _chatSend(c, {
    type: 'joined', code, you: { id: c.id, name: c.name }, uploadToken: c.uploadToken,
    members: _chatMemberList(room),
    files:   _chatFileList(room),
    history: room.history.slice(-CHAT_HISTORY_KEEP),
  });
  _chatBroadcast(room, { type: 'notice', event: 'join', id: c.id, name: c.name, ts: Date.now() }, c);
  _chatSyncMembers(room);
}

function attachChatSignaling(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  _wsRegister(server, '/chat-ws', (req, socket, head) => {
    if (!_wsOriginAllowed(req)) { _wsReject(socket, '403 Forbidden'); return; }
    const key = rateKey(clientIp(req));
    let perKey = 0;
    for (const c of _chatClients) if (c.key === key) perKey++;
    if (_chatClients.size >= CHAT_MAX_CONN_TOTAL || perKey >= CHAT_MAX_CONN_PER_IP) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    const c = {
      ws, ip, key: rateKey(ip), id: genId() + genId(),
      name: _dropName(), room: null, uploadToken: null, isAlive: true,
      _msgs: 0, _msgWindow: Date.now(),
    };
    _chatClients.add(c);
    _chatSend(c, { type: 'you', id: c.id, name: c.name });

    ws.on('pong', () => { c.isAlive = true; });

    // One bad frame must never throw out of this handler (it would reach the process).
    function onMessage(raw) {
      const now = Date.now();
      if (now - c._msgWindow > 10_000) { c._msgWindow = now; c._msgs = 0; }
      if (++c._msgs > 240) { ws.close(1008, 'rate limit'); return; }

      const msg = _wsParse(raw);
      if (!msg) return;
      switch (msg.type) {
        case 'create': {
          _chatLeave(c, true);
          const room = _chatRoomNew();
          room.members.set(c.id, c);
          c.room = room.code;
          c.uploadToken = newUploadToken();
          _chatSend(c, { type: 'joined', code: room.code, you: { id: c.id, name: c.name }, uploadToken: c.uploadToken, members: _chatMemberList(room), files: [], history: [] });
          break;
        }
        case 'join': {
          const code = str(msg.code).trim().toUpperCase();
          if (!/^[A-Z0-9]{8}$/.test(code)) { _chatSend(c, { type: 'error', message: 'Enter the 8-character room code.' }); break; }
          _chatJoin(c, code);
          break;
        }
        case 'name': {
          const nm = stripCtl(msg.name).trim().slice(0, CHAT_NAME_MAXLEN);
          if (!nm) break;
          c.name = nm;
          const room = c.room ? _chatRooms.get(c.room) : null;
          if (room) _chatSyncMembers(room);
          break;
        }
        case 'msg': {
          const room = c.room ? _chatRooms.get(c.room) : null;
          if (!room) break;
          const text = str(msg.text).slice(0, CHAT_MSG_MAXLEN);
          if (!text.trim()) break;
          const ts = Date.now();
          const rec = { from: c.id, name: c.name, text, ts };
          room.history.push(rec);
          if (room.history.length > CHAT_HISTORY_KEEP) room.history.shift();
          room.lastActivity = ts;
          _chatBroadcast(room, { type: 'msg', ...rec });
          break;
        }
        case 'typing': {
          const room = c.room ? _chatRooms.get(c.room) : null;
          if (room) _chatBroadcast(room, { type: 'typing', id: c.id, name: c.name }, c);
          break;
        }
        case 'leave': {
          _chatLeave(c, true);
          _chatSend(c, { type: 'left' });
          break;
        }
      }
    }
    ws.on('message', raw => {
      try { onMessage(raw); }
      catch (e) {
        console.error('[chat-ws] message handler:', e?.message);
        try { ws.close(1011, 'error'); } catch { /* closing */ }
      }
    });

    ws.on('close', () => { _chatClients.delete(c); _chatLeave(c, true); });
    ws.on('error', () => {});
  });

  // Keepalive ping (Cloudflare idles silent sockets out ~100 s) + reap dead
  // clients; a terminated socket fires 'close' → member removal → empty cleanup.
  // Two age limits so a room can never keep 2 GB files forever: an idle backstop
  // (12 h old AND 12 h quiet) and a hard 24 h cap from creation, active or not.
  setInterval(() => {
    for (const c of _chatClients) {
      if (!c.isAlive) { try { c.ws.terminate(); } catch { /* gone */ } continue; }
      c.isAlive = false;
      try { c.ws.ping(); } catch { /* closing */ }
    }
    const now = Date.now();
    for (const room of [..._chatRooms.values()]) {
      if (now - room.createdAt > CHAT_ROOM_HARD_AGE_MS) {
        _chatDeleteRoom(room, 'Room expired — rooms last at most 24 hours; files were deleted');
      } else if (now - room.createdAt > CHAT_ROOM_MAX_AGE_MS && now - room.lastActivity > CHAT_ROOM_MAX_AGE_MS) {
        _chatDeleteRoom(room, 'Room expired');
      }
    }
  }, 30_000).unref();
}

// Streaming multipart upload straight to disk (never buffered in RAM). Room dir
// is created lazily per code; the extension denylist runs in fileFilter so a
// blocked type is rejected BEFORE any bytes are written. The page sends exactly
// name, by, file — the field limits leave a little headroom over that.
const chatUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const code = String(req.params.code || '').toUpperCase();
      const dir  = path.join(CHAT_UPLOADS_DIR, code);
      fs.mkdir(dir, { recursive: true }, err => cb(err, dir));
    },
    filename: (req, file, cb) => cb(null, genId() + genId()),
  }),
  limits: { fileSize: CHAT_MAX_FILE_BYTES, files: 1, fields: 8, fieldSize: 4 * 1024, parts: 10, headerPairs: 100 },
  fileFilter: (req, file, cb) => {
    if (chatExtBlocked(file.originalname)) {
      const e = new Error('blocked extension'); e.code = 'CHAT_BLOCKED_EXT'; return cb(e);
    }
    cb(null, true);
  },
});

// Per-visitor limits, generous: dropping a batch of files, or a whole office behind
// one NAT downloading every file in a room, stays far below them.
const _chatUploadRL   = makeRateLimiter({ windowMs: 600_000, max: 120, message: 'Too many uploads — please wait a few minutes.' });
const _chatDownloadRL = makeRateLimiter({ windowMs: 60_000,  max: 600, message: 'Too many downloads — please wait a minute.' });

// Bytes being received right now, reserved from Content-Length BEFORE multer writes
// anything, so parallel uploads cannot each pass the post-upload room quota check.
// A request without Content-Length reserves the per-file maximum.
let _chatInflightBytes = 0;

// POST /api/chat/:code/upload?t=<uploadToken> — form fields (before the file part):
// name, by. The token is the one the `joined` message handed this member; it travels in
// the query string so it is checked before multer reads a byte of the body, and so the
// request stays CORS-simple (a custom header would need a preflight and an allowedHeaders
// entry). The uploader's name comes from the matched member; the `by` field is ignored.
app.post('/api/chat/:code/upload', _chatUploadRL.middleware, (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const room = _chatRooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found or already closed.' });
  const member = findMemberByToken(room.members.values(), typeof req.query.t === 'string' ? req.query.t : '');
  if (!member) return res.status(403).json({ error: 'Join the room before uploading files.' });
  if (room.files.size >= CHAT_ROOM_MAX_FILES) return res.status(409).json({ error: 'This room has reached its file limit.' });

  const cl = parseInt(req.headers['content-length'], 10);
  const known = Number.isFinite(cl) && cl >= 0;
  const want = known ? cl : CHAT_MAX_FILE_BYTES;
  if (known && cl > CHAT_MAX_FILE_BYTES + 64 * 1024) return res.status(413).json({ error: 'File too large (max 2 GB).' });
  if (room.bytes + room.reserved + want > CHAT_ROOM_MAX_BYTES) return res.status(413).json({ error: 'Room storage limit reached.' });
  if (room.uploading >= CHAT_ROOM_MAX_UPLOADS) return res.status(429).json({ error: 'Too many uploads in progress in this room — wait for one to finish.' });
  if (_chatInflightBytes + want > CHAT_INFLIGHT_MAX_BYTES) return res.status(503).json({ error: 'The server is busy receiving other uploads — please try again shortly.' });
  room.uploading++;
  room.reserved += want;
  _chatInflightBytes += want;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    room.uploading--;
    room.reserved -= want;
    _chatInflightBytes -= want;
  };
  res.on('finish', release);
  res.on('close', release);

  chatUpload.single('file')(req, res, err => {
    if (err) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      if (err.code === 'LIMIT_FILE_SIZE')   return res.status(413).json({ error: 'File too large (max 2 GB).' });
      if (err.code === 'CHAT_BLOCKED_EXT')  return res.status(415).json({ error: 'That file type is blocked (executables and scripts are not allowed).' });
      return res.status(400).json({ error: 'Upload failed.' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received.' });

    // The room can vanish mid-upload if everyone left; drop the orphaned bytes.
    if (!_chatRooms.has(code)) { fs.unlink(req.file.path, () => {}); return res.status(410).json({ error: 'Room closed during upload.' }); }
    if (room.bytes + req.file.size > CHAT_ROOM_MAX_BYTES) {
      fs.unlink(req.file.path, () => {});
      return res.status(413).json({ error: 'Room storage limit reached.' });
    }

    // The SERVED name is the one the denylist must judge (fileFilter saw originalname).
    const name = safeFileName(str(req.body?.name)) || safeFileName(req.file.originalname) || 'file';
    if (chatExtBlocked(name)) {
      fs.unlink(req.file.path, () => {});
      return res.status(415).json({ error: 'That file type is blocked (executables and scripts are not allowed).' });
    }
    const id   = genId() + genId();
    const by   = safeFileName(member.name, CHAT_NAME_MAXLEN) || 'Someone';
    const f = { id, name, size: req.file.size, mime: req.file.mimetype || 'application/octet-stream', path: req.file.path, by, ts: Date.now() };
    room.files.set(id, f);
    room.bytes += req.file.size;
    room.lastActivity = Date.now();
    _chatBroadcast(room, { type: 'file', file: { id, name, size: f.size, mime: f.mime, by, ts: f.ts } });
    res.json({ ok: true, id, name, size: f.size });
  });
});

// GET /api/chat/:code/file/:id — always an attachment (never inline → no in-page
// execution of an uploaded HTML/SVG), with nosniff.
app.get('/api/chat/:code/file/:id', _chatDownloadRL.middleware, (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const room = _chatRooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found or closed.' });
  const f = room.files.get(String(req.params.id));
  if (!f) return res.status(404).json({ error: 'File not found or expired.' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.download(f.path, f.name);
});

// ── Final error handler (after every route) ───────────────────
// Malformed JSON, oversized bodies and anything a route threw: generic JSON, never
// Express's HTML stack-trace page (lib/http-guards.js).
app.use(finalErrorHandler);

// ── Start ─────────────────────────────────────────────────────
// HOST unset → Node's default (all interfaces), unchanged. Local smoke tests set
// HOST=127.0.0.1 so a test server is never reachable from the LAN.
const HOST = (process.env.HOST || '').trim() || undefined;
const server = app.listen(PORT, HOST, () => {
  console.log(`Office Tools server running on ${HOST ? HOST + ':' : 'port '}${PORT}`);
  const _cfgEmail = (process.env.NOTIFY_EMAIL || '').trim();
  if (!_cfgEmail) console.warn('[config] NOTIFY_EMAIL not set — feedback emails will not be sent');
  else            console.log('[config] Feedback emails enabled');
});
// The uncaughtException backstop keeps the process alive; a server that cannot
// listen (port in use) must still exit so systemd restarts it.
server.on('error', err => {
  console.error('[server] listen failed:', err?.message);
  process.exit(1);
});
attachDropSignaling(server);
attachChatSignaling(server);
