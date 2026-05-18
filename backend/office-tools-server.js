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
const fs        = require('fs');
const path      = require('path');
const Database  = require('better-sqlite3');
const multer    = require('multer');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Config ────────────────────────────────────────────────────
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:8080').split(',').map(s => s.trim());

// ── SQLite tools DB ───────────────────────────────────────────
const TOOLS_DB_PATH = process.env.TOOLS_DB    || '/opt/office-tools/data/tools.db';
const UPLOADS_DIR   = process.env.UPLOADS_DIR || '/opt/office-tools/data/uploads';
fs.mkdirSync(path.dirname(TOOLS_DB_PATH), { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(TOOLS_DB_PATH);
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
`);

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, genId()),
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: CORS_ORIGINS, methods: ['GET','POST','DELETE'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// ── Shared: creation rate limit + CAPTCHA ────────────────────
const _createRateMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _createRateMap) { if (now > v.resetAt) _createRateMap.delete(k); }
}, 300_000);
function _createAllow(ip) {
  const now = Date.now();
  let e = _createRateMap.get(ip);
  if (!e || now > e.resetAt) e = { count: 0, resetAt: now + 3_600_000 };
  e.count++;
  _createRateMap.set(ip, e);
  return e.count <= 10;
}
function _checkCaptcha(body) {
  const ca  = parseInt(body?.ca,  10);
  const cb  = parseInt(body?.cb,  10);
  const ans = parseInt(body?.ans, 10);
  return !isNaN(ca) && !isNaN(cb) && !isNaN(ans) && ca + cb === ans;
}
function createRLMiddleware(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  if (!_createAllow(ip)) return res.status(429).json({ error: 'Rate limit: 10 creates per hour. Try again later.' });
  next();
}

// ── Tools API: URL Shortener ──────────────────────────────────

app.post('/api/tools/s', createRLMiddleware, (req, res) => {
  if (!_checkCaptcha(req.body)) return res.status(400).json({ error: 'Incorrect answer to the math question.' });
  const { code, long_url, expires } = req.body;
  if (!code || !long_url) return res.status(400).json({ error: 'code and long_url required' });
  try { const u = new URL(long_url); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); }
  catch { return res.status(400).json({ error: 'long_url must start with http:// or https://' }); }
  try {
    db.prepare('INSERT INTO short_urls (code, long_url, expires) VALUES (?, ?, ?)').run(code, long_url, expires || '');
    res.json({ code });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Code already taken' });
    res.status(500).json({ error: err.message });
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
  if (!_checkCaptcha(req.body)) return res.status(400).json({ error: 'Incorrect answer to the math question.' });
  const { code, title, content, syntax, expires, burn_after_read } = req.body;
  if (!code || !content) return res.status(400).json({ error: 'code and content required' });
  const id = genId();
  try {
    db.prepare('INSERT INTO pastes (id, code, title, content, syntax, expires, burn_after_read) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, code, title || '', content, syntax || 'plain', expires || '', burn_after_read ? 1 : 0
    );
    res.json({ code, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  if (!_checkCaptcha(req.body)) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Incorrect answer to the math question.' });
  }
  const { code, original_name, file_size, expires } = req.body;
  if (!code || !req.file) return res.status(400).json({ error: 'code and file required' });
  const id = genId();
  try {
    db.prepare('INSERT INTO file_shares (id, code, original_name, file_size, file_path, expires) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, code, original_name || req.file.originalname || '', parseInt(file_size) || req.file.size, req.file.path, expires || ''
    );
    res.json({ code, id, original_name: original_name || req.file.originalname, file_size: req.file.size });
  } catch (err) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message });
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
  next(err);
});

// ── Popular tools — click-based view tracking ─────────────────
const _viewRateMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _viewRateMap) { if (now > v.resetAt) _viewRateMap.delete(k); }
}, 300_000);

function _viewAllow(ip) {
  const now = Date.now();
  let e = _viewRateMap.get(ip);
  if (!e || now > e.resetAt) e = { count: 0, resetAt: now + 60_000 };
  e.count++;
  _viewRateMap.set(ip, e);
  return e.count <= 60;
}

app.post('/api/tools/view', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  if (!_viewAllow(ip)) return res.status(429).json({ error: 'Too many requests' });
  const tool = String(req.body?.tool || '').trim();
  if (!tool || !/^[a-z0-9-]+$/.test(tool) || tool.length > 60) {
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

app.get('/api/resolve', netRLMiddleware, (req, res) => {
  const host = String(req.query.host || '').trim();
  if (!host) return res.status(400).json({ error: 'Missing host' });

  // Raw IPv4 address
  if (net.isIPv4(host)) {
    return res.json({ host, addresses: [{ ip: host, family: 'IPv4' }] });
  }
  // Raw IPv6 address (with or without brackets)
  const ipv6 = host.replace(/^\[|\]$/g, '');
  if (net.isIPv6(ipv6)) {
    return res.json({ host, addresses: [{ ip: ipv6, family: 'IPv6' }] });
  }

  // Hostname — resolve both A and AAAA records in parallel
  let v4 = [], v6 = [], done = 0;
  const finish = () => {
    if (++done < 2) return;
    const addresses = [
      ...v4.map(ip => ({ ip, family: 'IPv4' })),
      ...v6.map(ip => ({ ip, family: 'IPv6' })),
    ];
    res.json({ host, addresses: addresses.length ? addresses : [] });
  };
  dns.resolve4(host, (err, addrs) => { v4 = err ? [] : addrs; finish(); });
  dns.resolve6(host, (err, addrs) => { v6 = err ? [] : addrs; finish(); });
});

app.get('/api/portcheck', netRLMiddleware, (req, res) => {
  const hostInput = String(req.query.host || '').trim();
  const port = parseInt(req.query.port, 10);
  if (!hostInput || isNaN(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'Invalid host or port' });
  }

  // Strip brackets from IPv6 addresses so both [::1] and ::1 work
  const host = hostInput.replace(/^\[|\]$/g, '');

  const TIMEOUT = 4000;
  const socket  = new net.Socket();
  let done = false;
  function finish(open) {
    if (done) return; done = true;
    socket.destroy();
    res.json({ host: hostInput, port, open });
  }
  socket.setTimeout(TIMEOUT);
  socket.once('connect', () => finish(true));
  socket.once('timeout',  () => finish(false));
  socket.once('error',    () => finish(false));
  socket.connect(port, host);
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
// Requires: npm install whois   (already in package.json)
// Optional env vars: GEMINI_API_KEY (AI suggest), VIEWDNS_API_KEY / WHOXY_API_KEY (history)

const whoisPkg   = require('whois');
const { promisify } = require('util');
const whoisLookup  = promisify(whoisPkg.lookup);

// Per-IP rate limiter (domain routes only)
const _domainRateMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _domainRateMap) { if (now > v.resetAt) _domainRateMap.delete(k); }
}, 300_000);

function _domainAllow(ip) {
  const now = Date.now();
  let e = _domainRateMap.get(ip);
  if (!e || now > e.resetAt) e = { count: 0, resetAt: now + 60_000 };
  e.count++;
  _domainRateMap.set(ip, e);
  return e.count <= 15;
}

function domainRLMiddleware(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (!_domainAllow(ip)) return res.status(429).json({ error: 'Rate limit: 15 requests/minute. Please wait.' });
  next();
}

// In-memory result cache (1 h TTL)
const _domCache = new Map();
const _DOM_TTL  = 3_600_000;
function dcGet(k) {
  const e = _domCache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > _DOM_TTL) { _domCache.delete(k); return null; }
  return e.d;
}
function dcSet(k, d) { _domCache.set(k, { d, ts: Date.now() }); }

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

// GET /api/domain/whois
app.get('/api/domain/whois', domainRLMiddleware, async (req, res) => {
  const domain = String(req.query.domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!validDomain(domain)) return res.status(400).json({ error: 'Invalid domain name' });

  const ck = 'whois:' + domain;
  const cached = dcGet(ck);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const raw    = await whoisLookup(domain, { timeout: 12000 });
    const parsed = parseWhoisText(raw);
    const data   = { domain, raw, parsed };
    dcSet(ck, data);
    res.json(data);
  } catch (err) {
    console.error('[domain/whois]', err.message);
    res.status(500).json({ error: err.message });
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
    if (!r.ok) return res.status(r.status).json({ error: `RDAP returned HTTP ${r.status}` });

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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// POST /api/domain/ai-suggest  { keyword: string, context?: string }
const _GEMINI_KEY = process.env.GEMINI_API_KEY || '';

app.post('/api/domain/ai-suggest', domainRLMiddleware, async (req, res) => {
  if (!_GEMINI_KEY) {
    return res.status(503).json({ error: 'AI suggestions not configured (GEMINI_API_KEY missing in .env)' });
  }
  const keyword = String(req.body.keyword || '').trim().slice(0, 100);
  const context = String(req.body.context || '').trim().slice(0, 300);
  if (!keyword) return res.status(400).json({ error: 'keyword is required' });

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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${_GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 400, temperature: 0.85 },
        }),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: errBody.error?.message || `Gemini API error ${r.status}` });
    }
    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return res.status(500).json({ error: 'Could not parse AI response', raw: text });

    let suggestions;
    try {
      suggestions = JSON.parse(match[0]);
      if (!Array.isArray(suggestions)) throw new Error('not array');
      suggestions = suggestions
        .map(s => String(s).trim().toLowerCase())
        .filter(s => /^[a-z0-9][a-z0-9-]*\.[a-z]{2,}$/.test(s))
        .slice(0, 15);
    } catch {
      return res.status(500).json({ error: 'Could not parse AI suggestions', raw: text });
    }

    res.json({ keyword, suggestions });
  } catch (err) {
    console.error('[domain/ai-suggest]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Network Toolkit — ping, traceroute, reverse DNS ──────────
const { spawn } = require('child_process');
const _isWin = process.platform === 'win32';

function validNetHost(h) {
  return h.length > 0 && h.length <= 253 && /^[a-zA-Z0-9.\-:\[\]_]+$/.test(h);
}

const _netRateMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _netRateMap) { if (now > v.resetAt) _netRateMap.delete(k); }
}, 300_000);

function _netAllow(ip) {
  const now = Date.now();
  let e = _netRateMap.get(ip);
  if (!e || now > e.resetAt) e = { count: 0, resetAt: now + 60_000 };
  e.count++;
  _netRateMap.set(ip, e);
  return e.count <= 10;
}

function netRLMiddleware(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (!_netAllow(ip)) return res.status(429).json({ error: 'Rate limit: 10 requests/minute. Please wait.' });
  next();
}

// GET /api/net/ping?host=&count=&family=   (SSE stream)
app.get('/api/net/ping', netRLMiddleware, (req, res) => {
  const host  = String(req.query.host || '').trim().replace(/^\[|\]$/g, '');
  const count = Math.min(10, Math.max(1, parseInt(req.query.count, 10) || 4));
  const fam   = String(req.query.family || 'auto'); // 'auto' | '4' | '6'

  if (!validNetHost(host)) return res.status(400).json({ error: 'Invalid host' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let cmd, args;
  if (_isWin) {
    cmd  = 'ping';
    args = ['-n', String(count)];
    if (fam === '6') args.push('-6');
    args.push(host);
  } else {
    cmd  = 'ping';
    args = ['-c', String(count)];
    if (fam === '4') args.push('-4');
    else if (fam === '6') args.push('-6');
    args.push(host);
  }

  const proc = spawn(cmd, args, { timeout: 30000 });
  const send = chunk => chunk.toString().split(/\r?\n/).filter(l => l.trim())
    .forEach(l => res.write(`data: ${JSON.stringify(l)}\n\n`));

  proc.stdout.on('data', send);
  proc.stderr.on('data', send);
  proc.on('close', () => { res.write('data: "[DONE]"\n\n'); res.end(); });
  proc.on('error', err => {
    res.write(`data: ${JSON.stringify('Error: ' + err.message)}\n\n`);
    res.write('data: "[DONE]"\n\n');
    res.end();
  });
  req.on('close', () => proc.kill());
});

// GET /api/net/traceroute?host=&maxhops=&family=   (SSE stream)
app.get('/api/net/traceroute', netRLMiddleware, (req, res) => {
  const host    = String(req.query.host || '').trim().replace(/^\[|\]$/g, '');
  const maxhops = Math.min(30, Math.max(1, parseInt(req.query.maxhops, 10) || 30));
  const fam     = String(req.query.family || 'auto');

  if (!validNetHost(host)) return res.status(400).json({ error: 'Invalid host' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let cmd, args;
  if (_isWin) {
    cmd  = 'tracert';
    args = ['-h', String(maxhops)];
    if (fam === '6') args.push('-6');
    args.push(host);
  } else {
    cmd  = 'traceroute';
    args = ['-m', String(maxhops)];
    if (fam === '4') args.push('-4');
    else if (fam === '6') args.push('-6');
    args.push(host);
  }

  const proc = spawn(cmd, args, { timeout: 120000 });
  const send = chunk => chunk.toString().split(/\r?\n/).filter(l => l.trim())
    .forEach(l => res.write(`data: ${JSON.stringify(l)}\n\n`));

  proc.stdout.on('data', send);
  proc.stderr.on('data', send);
  proc.on('close', () => { res.write('data: "[DONE]"\n\n'); res.end(); });
  proc.on('error', err => {
    res.write(`data: ${JSON.stringify('Error: ' + err.message)}\n\n`);
    res.write('data: "[DONE]"\n\n');
    res.end();
  });
  req.on('close', () => proc.kill());
});

// GET /api/net/ptr?ip=
app.get('/api/net/ptr', netRLMiddleware, (req, res) => {
  const ip = String(req.query.ip || '').trim().replace(/^\[|\]$/g, '');
  if (!net.isIPv4(ip) && !net.isIPv6(ip)) {
    return res.status(400).json({ error: 'Invalid IP address (IPv4 or IPv6 required)' });
  }
  dns.reverse(ip, (err, hostnames) => {
    if (err) {
      if (err.code === 'ENOTFOUND' || err.code === 'ENODATA' || err.code === 'ENONAME') {
        return res.json({ ip, hostnames: [], found: false });
      }
      return res.status(500).json({ error: err.message });
    }
    res.json({ ip, hostnames, found: hostnames.length > 0 });
  });
});

// ── Feedback ───────────────────────────────────────────────────
function _sendmailNotify(to, subject, body) {
  const { spawn } = require('child_process');
  const proc = spawn('sendmail', ['-t'], { timeout: 10_000 });
  const mail = `To: ${to}\nFrom: noreply@grin.money\nSubject: ${subject}\n\n${body}`;
  proc.stdin.write(mail);
  proc.stdin.end();
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d; });
  proc.on('error',  err  => console.error(`[sendmail] spawn error → ${err.message}`));
  proc.on('close',  code => {
    if (code !== 0) console.error(`[sendmail] exited ${code} stderr: ${stderr.trim()}`);
    else            console.log(`[sendmail] delivered to ${to}`);
  });
}

const _fbRateMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _fbRateMap) { if (now > v.resetAt) _fbRateMap.delete(k); }
}, 300_000);
function _fbAllow(ip) {
  const now = Date.now();
  let e = _fbRateMap.get(ip);
  if (!e || now > e.resetAt) e = { count: 0, resetAt: now + 86_400_000 }; // 24 hours
  e.count++;
  _fbRateMap.set(ip, e);
  return e.count <= 3;
}

// POST /api/feedback  { message, page, ca, cb, ans }
app.post('/api/feedback', (req, res) => {
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';

  // CAPTCHA check
  const ca  = parseInt(req.body?.ca,  10);
  const cb  = parseInt(req.body?.cb,  10);
  const ans = parseInt(req.body?.ans, 10);
  if (isNaN(ca) || isNaN(cb) || isNaN(ans) || ca + cb !== ans) {
    return res.status(400).json({ error: 'Incorrect answer to the math question.' });
  }

  if (!_fbAllow(clientIp)) return res.status(429).json({ error: 'Limit reached: 3 messages per 24 hours.' });

  const message = String(req.body?.message || '').trim().slice(0, 2000);
  const page    = String(req.body?.page    || '').trim().slice(0, 200);

  if (message.length < 10) return res.status(400).json({ error: 'Message too short (minimum 10 characters).' });

  // Block duplicate messages submitted in the last 24 hours
  const duplicate = db.prepare(
    "SELECT 1 FROM feedback WHERE message = ? AND created >= datetime('now', '-24 hours') LIMIT 1"
  ).get(message);
  if (duplicate) return res.status(400).json({ error: 'This message was already submitted recently.' });

  db.prepare('INSERT INTO feedback (id, page, message, ip) VALUES (?, ?, ?, ?)')
    .run(genId(), page, message, clientIp);

  // Email notification via OS sendmail (fire-and-forget)
  const _fbSubject = `[Office Tools Feedback] ${page || 'unknown page'}`;
  const _fbBody    = `Page: ${page}\nIP: ${clientIp}\n\n${message}`;
  if (process.env.NOTIFY_EMAIL)   _sendmailNotify(process.env.NOTIFY_EMAIL,   _fbSubject, _fbBody);
  if (process.env.NOTIFY_EMAIL_2) _sendmailNotify(process.env.NOTIFY_EMAIL_2, _fbSubject, _fbBody);

  res.json({ ok: true });
});

// ── IP Geolocation proxy ──────────────────────────────────────
// ip-api.com free tier only allows HTTP, not HTTPS — proxy it server-side
const _geoRateMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _geoRateMap) { if (now > v.resetAt) _geoRateMap.delete(k); }
}, 300_000);
function _geoAllow(ip) {
  const now = Date.now();
  let s = _geoRateMap.get(ip);
  if (!s || now > s.resetAt) { s = { count: 0, resetAt: now + 60_000 }; _geoRateMap.set(ip, s); }
  s.count++;
  return s.count <= 20;
}

const _GEO_FIELDS = 'status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,query';

app.get('/api/ip/geo', async (req, res) => {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
  if (!_geoAllow(clientIp)) return res.status(429).json({ error: 'Rate limit exceeded' });

  const target = (req.query.ip || '').trim();
  if (!target) return res.status(400).json({ error: 'Missing ip parameter' });

  // strip brackets from IPv6
  const clean = target.replace(/^\[|\]$/g, '');
  if (!/^[a-zA-Z0-9.\-:_]+$/.test(clean)) return res.status(400).json({ error: 'Invalid IP or host' });

  try {
    const r = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(clean)}?fields=${_GEO_FIELDS}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Geo lookup failed: ' + err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Office Tools server running on port ${PORT}`);
  if (!process.env.NOTIFY_EMAIL) console.warn('[config] NOTIFY_EMAIL not set — feedback emails will not be sent');
  else                           console.log(`[config] Feedback emails → ${process.env.NOTIFY_EMAIL}`);
});
