/**
 * Office Tools — Grin Server
 *
 * Donation endpoints:
 *   POST /api/donate/receive   — user sends a slate; we run grin-wallet receive → return response slatepack
 *   POST /api/donate/invoice   — we create an invoice for the user to pay → return invoice slatepack
 *   POST /api/donate/finalize  — user paid the invoice; we run grin-wallet finalize
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
const express       = require('express');
const cors          = require('cors');
const { execFile }  = require('child_process');
const { promisify } = require('util');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const readline      = require('readline');
const Database      = require('better-sqlite3');
const multer        = require('multer');

const execFileAsync = promisify(execFile);
const app  = express();
const PORT = process.env.PORT || 3001;

// ── Config ────────────────────────────────────────────────────
const GRIN_WALLET_BIN      = process.env.GRIN_WALLET_BIN      || 'grin-wallet';
const GRIN_WALLET_FALLBACK = process.env.GRIN_WALLET_FALLBACK || '/opt/grin/cmdwallet/mainnet/grin-wallet';

// Passphrase is resolved at startup — see loadPassphrase() below
let GRIN_WALLET_PASS = '';
const CORS_ORIGINS     = (process.env.CORS_ORIGINS || 'http://localhost:8080').split(',').map(s => s.trim());

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
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: CORS_ORIGINS, methods: ['GET','POST','DELETE'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// ── Grin wallet helpers ───────────────────────────────────────
async function grinWallet(args) {
  const baseArgs   = GRIN_WALLET_PASS ? ['-p', GRIN_WALLET_PASS, ...args] : args;
  // Try primary binary first; on ENOENT fall back to the known install location
  const candidates = GRIN_WALLET_BIN !== GRIN_WALLET_FALLBACK
    ? [GRIN_WALLET_BIN, GRIN_WALLET_FALLBACK]
    : [GRIN_WALLET_BIN];

  for (const bin of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(bin, baseArgs, {
        timeout: 60000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout + (stderr || '');
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.warn(`[grin-wallet] binary not found at "${bin}", trying next…`);
        continue; // try the next candidate
      }
      // Real execution error — don't try fallback
      const out = (err.stdout || '') + (err.stderr || '');
      throw new Error(`grin-wallet ${args[0]} failed: ${err.message}\n${out}`);
    }
  }

  throw new Error(
    `grin-wallet binary not found. Tried: ${candidates.join(', ')}. ` +
    `Set GRIN_WALLET_BIN= or GRIN_WALLET_FALLBACK= in .env`
  );
}

function extractSlatepack(output) {
  const m = output.match(/(BEGINSLATEPACK[\s\S]+?ENDSLATEPACK\.)/);
  if (!m) throw new Error('No slatepack found in wallet output:\n' + output.slice(0, 500));
  return m[1];
}

// ── Donation routes ───────────────────────────────────────────

/**
 * POST /api/donate/receive
 * Option 2 — user ran `grin-wallet send -d <our_address> <amount>` and pastes the resulting slate.
 * We run `grin-wallet receive -i <slate>` and return our response slatepack.
 * User then runs `grin-wallet finalize` with our response.
 */
app.post('/api/donate/receive', async (req, res) => {
  try {
    const { slatepack } = req.body;
    if (!slatepack?.trim()) return res.status(400).json({ error: 'slatepack required' });

    const tmpIn = path.join(os.tmpdir(), `grin_donate_rcv_${Date.now()}.slatepack`);
    fs.writeFileSync(tmpIn, slatepack.trim());
    try {
      const out = await grinWallet(['receive', '-i', tmpIn]);
      const response = extractSlatepack(out);
      res.json({ slatepack: response });
    } finally {
      fs.unlink(tmpIn, () => {});
    }
  } catch (err) {
    console.error('[donate/receive]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/donate/invoice
 * Option 3 step 1 — we create an invoice requesting `amount` GRIN payable by `address`.
 * Body: { amount: number (GRIN), address: string (user's Grin address) }
 * Returns the invoice slatepack for the user to pay with `grin-wallet pay`.
 */
app.post('/api/donate/invoice', async (req, res) => {
  try {
    const { amount, address } = req.body;
    const amt = parseFloat(amount);
    if (!amt || isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Valid amount required' });
    if (!address?.trim()) return res.status(400).json({ error: 'Grin address required' });

    const out = await grinWallet(['invoice', '-d', address.trim(), String(amt)]);
    const slatepack = extractSlatepack(out);
    res.json({ slatepack });
  } catch (err) {
    console.error('[donate/invoice]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/donate/finalize
 * Option 3 step 2 — user ran `grin-wallet pay` on our invoice and pastes their response.
 * We finalize and broadcast.
 */
app.post('/api/donate/finalize', async (req, res) => {
  try {
    const { slatepack } = req.body;
    if (!slatepack?.trim()) return res.status(400).json({ error: 'slatepack required' });

    const tmpFile = path.join(os.tmpdir(), `grin_donate_fin_${Date.now()}.slatepack`);
    fs.writeFileSync(tmpFile, slatepack.trim());
    try {
      await grinWallet(['finalize', '-i', tmpFile]);
      res.json({ success: true });
    } finally {
      fs.unlink(tmpFile, () => {});
    }
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
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 1 GB)' });
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

// ── Health ────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Passphrase loading ────────────────────────────────────────
/**
 * Priority order:
 *   1. GRIN_WALLET_PASS_KEYRING=1  — OS keyring via secret-tool (most secure)
 *   2. GRIN_WALLET_PASS_FILE       — path to a plain-text file (chmod 640, root:grin)
 *   3. GRIN_WALLET_PASS            — env var (visible in /proc/<pid>/environ)
 *   4. Interactive TTY prompt      — typed once, lives in memory only
 *   5. Empty string                — wallet has no passphrase
 */
async function loadPassphrase() {
  // Priority 1: OS keyring via secret-tool
  //   Setup once: secret-tool store --label="Grin wallet" service grin-wallet account mainnet
  if (process.env.GRIN_WALLET_PASS_KEYRING === '1') {
    try {
      const { execFileSync } = require('child_process');
      const out = execFileSync('secret-tool', ['lookup', 'service', 'grin-wallet', 'account', 'mainnet'], {
        timeout: 5000,
      });
      GRIN_WALLET_PASS = out.toString().trim();
      console.log('Grin wallet passphrase loaded from OS keyring.');
      return;
    } catch (e) {
      console.error('OS keyring lookup failed:', e.message);
      console.error('Run: secret-tool store --label="Grin wallet" service grin-wallet account mainnet');
      process.exit(1);
    }
  }

  // Priority 2: Passphrase file (set GRIN_WALLET_PASS_FILE=/opt/office-tools/data/.temp)
  if (process.env.GRIN_WALLET_PASS_FILE) {
    try {
      GRIN_WALLET_PASS = fs.readFileSync(process.env.GRIN_WALLET_PASS_FILE, 'utf8').trim();
      console.log(`Grin wallet passphrase loaded from file (${process.env.GRIN_WALLET_PASS_FILE}).`);
      return;
    } catch (e) {
      console.error(`Failed to read GRIN_WALLET_PASS_FILE (${process.env.GRIN_WALLET_PASS_FILE}):`, e.message);
      process.exit(1);
    }
  }

  // Priority 3: Env var
  if (process.env.GRIN_WALLET_PASS) {
    GRIN_WALLET_PASS = process.env.GRIN_WALLET_PASS;
    console.log('Grin wallet passphrase loaded from environment variable.');
    return;
  }

  // Priority 4: Interactive prompt — typed once, kept in memory only
  if (process.stdin.isTTY) {
    GRIN_WALLET_PASS = await promptPassphrase();
    if (GRIN_WALLET_PASS) console.log('Grin wallet passphrase loaded from prompt (in memory only).');
    return;
  }

  // No passphrase
  console.log('No Grin wallet passphrase set (wallet assumed to have none).');
}

function promptPassphrase() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Suppress echo so the passphrase isn't visible on screen
    rl._writeToOutput = () => {};
    process.stdout.write('Grin wallet passphrase (Enter for none): ');
    rl.question('', pass => {
      process.stdout.write('\n');
      rl.close();
      resolve(pass);
    });
  });
}

// ── Start ─────────────────────────────────────────────────────
async function main() {
  await loadPassphrase();
  app.listen(PORT, () => {
    console.log(`Office Tools server running on port ${PORT}`);
    console.log(`Grin wallet:  ${GRIN_WALLET_BIN} (fallback: ${GRIN_WALLET_FALLBACK})`);
    if (process.env.GRIN_WALLET_PASS_KEYRING === '1') {
      console.log(`Passphrase:   from OS keyring`);
    } else if (process.env.GRIN_WALLET_PASS_FILE) {
      console.log(`Passphrase:   from file (${process.env.GRIN_WALLET_PASS_FILE})`);
    } else if (process.env.GRIN_WALLET_PASS) {
      console.log(`Passphrase:   from environment variable`);
    } else if (GRIN_WALLET_PASS) {
      console.log(`Passphrase:   from interactive prompt (in memory only)`);
    } else {
      console.log(`Passphrase:   none`);
    }
  });
}

main();
