/**
 * Office Tools — Grin Server
 *
 * Donation endpoints (use wallet HTTP APIs — no subprocess, no file-lock conflict):
 *   POST /api/donate/receive   — decode slatepack → Foreign API receive_tx → return response slatepack
 *   POST /api/donate/invoice   — Owner API issue_invoice_tx → return invoice slatepack
 *   POST /api/donate/finalize  — decode slatepack → Owner API finalize_tx → broadcast
 *
 * Tools API:
 *   POST/GET /api/tools/s   — URL shortener
 *   POST/GET /api/tools/p   — Pastebin
 *   POST/GET /api/tools/f   — File share
 *
 * Requires: .env (copy from .env.example)
 */

'use strict';
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const Database  = require('better-sqlite3');
const multer    = require('multer');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Config ────────────────────────────────────────────────────
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:8080').split(',').map(s => s.trim());

// ── Grin API config ───────────────────────────────────────────
const FOREIGN_API_URL         = process.env.GRIN_FOREIGN_API            || 'http://127.0.0.1:3415/v2/foreign';
const OWNER_API_URL           = process.env.GRIN_OWNER_API              || 'http://127.0.0.1:3420/v3/owner';
const FOREIGN_SECRET_FILE     = process.env.GRIN_API_SECRET_FILE        || '/opt/office-tools/cmdgrinwallet/wallet_data/.api_secret';
const OWNER_SECRET_FILE       = process.env.GRIN_OWNER_API_SECRET_FILE  || '/opt/office-tools/cmdgrinwallet/.owner_api_secret';
const PASS_FILE               = process.env.GRIN_WALLET_PASS_FILE       || '/opt/office-tools/data/.temp';

// Read wallet passphrase from disk on each call so a re-saved passphrase
// takes effect without restarting the server.
function readWalletPass() {
  try {
    return fs.readFileSync(PASS_FILE, 'utf8').replace(/[\r\n]/g, '') || '';
  } catch { return ''; }
}

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

// ── Grin API helpers ──────────────────────────────────────────

function foreignAuthHeader() {
  try {
    const secret = fs.readFileSync(FOREIGN_SECRET_FILE, 'utf8').trim();
    if (secret) return { Authorization: 'Basic ' + Buffer.from('grin:' + secret).toString('base64') };
  } catch {}
  return {};
}

function ownerAuthHeader() {
  try {
    const secret = fs.readFileSync(OWNER_SECRET_FILE, 'utf8').trim();
    if (secret) return { Authorization: 'Basic ' + Buffer.from('grin:' + secret).toString('base64') };
  } catch {}
  return {};
}

/**
 * Call the Foreign API (port 3415) — plain JSON-RPC, no encryption.
 * Does NOT conflict with the wallet file lock.
 */
async function foreignApiCall(method, params = []) {
  const res = await fetch(FOREIGN_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...foreignAuthHeader() },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Foreign API ${method}: ${json.error.message || JSON.stringify(json.error)}`);
  if (json.result && json.result.Err) throw new Error(`Foreign API ${method}: ${JSON.stringify(json.result.Err)}`);
  return json.result && json.result.Ok !== undefined ? json.result.Ok : json.result;
}

/**
 * Open an Owner API v3 session — ECDH handshake + open_wallet.
 * Returns { headers, sharedKey, token } for use with encryptedOwnerCall().
 *
 * Encryption scheme (per https://grincc.github.io/grin-wallet-api-tutorial/):
 *   AES-256-GCM, 12-byte nonce, base64(ciphertext + 16-byte auth_tag)
 *   Nonce is also used as the JSON-RPC id.
 */
async function ownerApiSession() {
  const headers = { 'Content-Type': 'application/json', ...ownerAuthHeader() };

  // Step 1 — ECDH handshake (unencrypted, plain JSON-RPC)
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.generateKeys();
  const ourPubKey = ecdh.getPublicKey('hex', 'compressed');

  const initRes = await fetch(OWNER_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'init_secure_api', params: { ecdh_pubkey: ourPubKey } }),
    signal: AbortSignal.timeout(10000),
  });
  const initJson = await initRes.json();
  if (initJson.error) throw new Error('init_secure_api: ' + (initJson.error.message || JSON.stringify(initJson.error)));

  const serverPubKeyHex = initJson.result.Ok || initJson.result;
  const sharedKey = ecdh.computeSecret(Buffer.from(serverPubKeyHex, 'hex')); // 32-byte secp256k1 x-coord

  // Step 2 — open_wallet to get session token
  const token = await encryptedOwnerCall(headers, sharedKey, 'open_wallet', { name: null, password: readWalletPass() });

  return { headers, sharedKey, token };
}

/**
 * Send one encrypted call to the Owner API v3.
 * body_enc = base64(AES-256-GCM(inner_json) + auth_tag)
 * nonce is also used as the JSON-RPC id.
 */
async function encryptedOwnerCall(headers, sharedKey, method, params) {
  const nonce    = crypto.randomBytes(12);
  const nonceHex = nonce.toString('hex');
  const inner    = JSON.stringify({ jsonrpc: '2.0', id: nonceHex, method, params });

  const cipher  = crypto.createCipheriv('aes-256-gcm', sharedKey, nonce);
  const enc     = Buffer.concat([cipher.update(inner, 'utf8'), cipher.final()]);
  const body_enc = Buffer.concat([enc, cipher.getAuthTag()]).toString('base64'); // base64, not hex

  const encRes = await fetch(OWNER_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: nonceHex, method: 'encrypted_request_v3', params: { nonce: nonceHex, body_enc } }),
    signal: AbortSignal.timeout(30000),
  });
  const encJson = await encRes.json();
  if (encJson.error) throw new Error(`encrypted_request_v3 (${method}): ${encJson.error.message || JSON.stringify(encJson.error)}`);

  const { nonce: rNonce, body_enc: rBodyEnc } = encJson.result.Ok || encJson.result;
  const rBuf     = Buffer.from(rBodyEnc, 'base64'); // base64, not hex
  const decipher = crypto.createDecipheriv('aes-256-gcm', sharedKey, Buffer.from(rNonce, 'hex'));
  decipher.setAuthTag(rBuf.slice(-16));
  const plain  = Buffer.concat([decipher.update(rBuf.slice(0, -16)), decipher.final()]).toString('utf8');

  const inner2 = JSON.parse(plain);
  if (inner2.error) throw new Error(`Owner API ${method}: ${inner2.error.message || JSON.stringify(inner2.error)}`);
  if (inner2.result && inner2.result.Err) throw new Error(`Owner API ${method}: ${JSON.stringify(inner2.result.Err)}`);
  return inner2.result && inner2.result.Ok !== undefined ? inner2.result.Ok : inner2.result;
}

// ── Donation routes ───────────────────────────────────────────

/**
 * POST /api/donate/receive
 * Method 2 — user ran `grin-wallet send -d <our_address> <amount>` and pastes the slatepack.
 * Flow:
 *   1. Owner API: slate_from_slatepack_message → decode to slate JSON
 *   2. Foreign API: receive_tx(slate) → response slate JSON (no lock conflict)
 *   3. Owner API: create_slatepack_message → encode response back to slatepack
 * User then runs: grin-wallet finalize -i response.slatepack
 */
app.post('/api/donate/receive', async (req, res) => {
  try {
    const { slatepack } = req.body;
    if (!slatepack?.trim()) return res.status(400).json({ error: 'slatepack required' });

    // Open an Owner API session (ECDH + open_wallet token)
    const session = await ownerApiSession();
    const { headers, sharedKey, token } = session;

    // 1. Decode incoming slatepack → slate JSON
    const slate = await encryptedOwnerCall(headers, sharedKey, 'slate_from_slatepack_message', {
      token,
      secret_indices: [0],
      message: slatepack.trim(),
    });

    // 2. Foreign API receive_tx — params: [slate, dest_acct_name, message]
    const responseSlate = await foreignApiCall('receive_tx', [slate, null, null]);

    // 3. Encode response slate → slatepack
    const responseSlatepack = await encryptedOwnerCall(headers, sharedKey, 'create_slatepack_message', {
      token,
      sender_index: 0,
      recipients: [],
      slate: responseSlate,
    });

    res.json({ slatepack: responseSlatepack });
  } catch (err) {
    console.error('[donate/receive]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/donate/invoice
 * Method 3 step 1 — we create an invoice for `amount` GRIN directed to `address`.
 * Body: { amount: number (GRIN), address: string (user's Grin address) }
 * Returns the invoice slatepack for the user to pay with `grin-wallet pay`.
 * Flow:
 *   1. Owner API: issue_invoice_tx → invoice slate JSON
 *   2. Owner API: create_slatepack_message → encode to slatepack
 */
app.post('/api/donate/invoice', async (req, res) => {
  try {
    const { amount, address } = req.body;
    const amt = parseFloat(amount);
    if (!amt || isNaN(amt) || amt < 1) return res.status(400).json({ error: 'Amount must be at least 1 GRIN' });
    if (!address?.trim()) return res.status(400).json({ error: 'Grin address required' });

    const { headers, sharedKey, token } = await ownerApiSession();

    // 1. Create invoice — amount in nanogrin (1 GRIN = 1_000_000_000)
    const slate = await encryptedOwnerCall(headers, sharedKey, 'issue_invoice_tx', {
      token,
      args: {
        amount: String(Math.round(amt * 1_000_000_000)),
        dest_acct_name: null,
        target_slate_version: null,
        address: address.trim(),
      },
    });

    // 2. Encode to slatepack
    const slatepack = await encryptedOwnerCall(headers, sharedKey, 'create_slatepack_message', {
      token,
      sender_index: 0,
      recipients: [],
      slate,
    });

    res.json({ slatepack });
  } catch (err) {
    console.error('[donate/invoice]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/donate/finalize
 * Method 3 step 2 — user ran `grin-wallet pay` on our invoice and pastes their response slatepack.
 * Flow:
 *   1. Owner API: slate_from_slatepack_message → decode to slate JSON
 *   2. Owner API: finalize_tx → finalize and broadcast
 */
app.post('/api/donate/finalize', async (req, res) => {
  try {
    const { slatepack } = req.body;
    if (!slatepack?.trim()) return res.status(400).json({ error: 'slatepack required' });

    const { headers, sharedKey, token } = await ownerApiSession();

    // 1. Decode slatepack → slate JSON
    const slate = await encryptedOwnerCall(headers, sharedKey, 'slate_from_slatepack_message', {
      token,
      secret_indices: [0],
      message: slatepack.trim(),
    });

    // 2. Finalize and broadcast
    await encryptedOwnerCall(headers, sharedKey, 'finalize_tx', { token, slate });

    res.json({ success: true });
  } catch (err) {
    console.error('[donate/finalize]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Tools API: URL Shortener ──────────────────────────────────

app.post('/api/tools/s', (req, res) => {
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

app.post('/api/tools/p', (req, res) => {
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

app.post('/api/tools/f', upload.single('file'), (req, res) => {
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

// ── Wallet status — used by donate page badge ─────────────────
// Checks whether grin-wallet listener is running by probing port 3415
const GRIN_LISTEN_PORT = parseInt(process.env.GRIN_LISTEN_PORT || '3415', 10);
const GRIN_LISTEN_HOST = process.env.GRIN_LISTEN_HOST || '127.0.0.1';

function checkWalletPort() {
  return new Promise(resolve => {
    const net = require('net');
    const sock = new net.Socket();
    sock.setTimeout(3000);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error',   () => { sock.destroy(); resolve(false); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(GRIN_LISTEN_PORT, GRIN_LISTEN_HOST);
  });
}

app.get('/api/wallet/status', async (req, res) => {
  const up = await checkWalletPort();
  if (up) {
    res.json({ status: 'ok' });
  } else {
    res.status(503).json({
      status:  'error',
      message: `grin-wallet not listening on ${GRIN_LISTEN_HOST}:${GRIN_LISTEN_PORT}`,
    });
  }
});

// ── Port Checker — DNS resolve + TCP connect probe ───────────
const net = require('net');
const dns = require('dns');

app.get('/api/resolve', (req, res) => {
  const host = String(req.query.host || '').trim();
  if (!host) return res.status(400).json({ error: 'Missing host' });
  dns.lookup(host, (err, address) => {
    if (err) return res.json({ host, ip: null });
    res.json({ host, ip: address });
  });
});
app.get('/api/portcheck', (req, res) => {
  const host = String(req.query.host || '').trim();
  const port = parseInt(req.query.port, 10);
  if (!host || isNaN(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'Invalid host or port' });
  }
  const TIMEOUT = 4000;
  const socket  = new net.Socket();
  let done = false;
  function finish(open) {
    if (done) return; done = true;
    socket.destroy();
    res.json({ host, port, open });
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

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Office Tools server running on port ${PORT}`);
  console.log(`Foreign API:  ${FOREIGN_API_URL}`);
  console.log(`Owner API:    ${OWNER_API_URL}`);
  const _wp = readWalletPass();
  console.log(`Wallet pass:  ${_wp ? `loaded from ${PASS_FILE}` : `not set (${PASS_FILE} missing or empty)`}`);
});
