/**
 * Office Tools — Grin Payment Server
 *
 * Flow:
 *   POST /api/payment/initiate  → creates Grin invoice slate, stores pending payment in PocketBase
 *   POST /api/payment/respond   → finalizes the transaction, activates subscription on success
 *   GET  /api/payment/status/:id → poll payment status
 *
 * Requires: .env (copy from .env.example)
 */

'use strict';
require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const fetch        = require('node-fetch');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs           = require('fs');
const os           = require('os');
const path         = require('path');

const execFileAsync = promisify(execFile);
const app  = express();
const PORT = process.env.PORT || 3001;

// ── Config ────────────────────────────────────────────────────
const PB_URL               = process.env.PB_URL                || 'http://127.0.0.1:8090';
const GRIN_WALLET_BIN      = process.env.GRIN_WALLET_BIN       || 'grin-wallet';
const GRIN_WALLET_PASS     = process.env.GRIN_WALLET_PASS      || '';
const GRIN_RECEIVING_ADDR  = process.env.GRIN_RECEIVING_ADDRESS || '';
const EXPIRY_MINS          = parseInt(process.env.PAYMENT_EXPIRY_MINUTES || '30', 10);
const CORS_ORIGINS   = (process.env.CORS_ORIGINS || 'http://localhost:8080').split(',').map(s => s.trim());

const PLAN_AMOUNTS = {
  pro_monthly: parseInt(process.env.PLAN_PRO_MONTHLY_NANOGRIN  || '10000000000',  10),
  pro_yearly:  parseInt(process.env.PLAN_PRO_YEARLY_NANOGRIN   || '100000000000', 10),
  lifetime:    parseInt(process.env.PLAN_LIFETIME_NANOGRIN      || '500000000000', 10),
};

const PLAN_EXPIRES = {
  pro_monthly: () => new Date(Date.now() + 30  * 86400000).toISOString(),
  pro_yearly:  () => new Date(Date.now() + 365 * 86400000).toISOString(),
  lifetime:    () => null,
};

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: CORS_ORIGINS, methods: ['GET','POST'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());

// ── PocketBase admin token (cached) ──────────────────────────
let pbAdminToken = null;
let pbAdminExpiry = 0;

async function getPbAdminToken() {
  if (pbAdminToken && Date.now() < pbAdminExpiry) return pbAdminToken;
  const res  = await fetch(`${PB_URL}/api/admins/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: process.env.PB_ADMIN_EMAIL, password: process.env.PB_ADMIN_PASSWORD }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('PocketBase admin auth failed: ' + data.message);
  pbAdminToken = data.token;
  pbAdminExpiry = Date.now() + 55 * 60 * 1000; // refresh 5 min before 1hr expiry
  return pbAdminToken;
}

async function pbPost(path, body) {
  const token = await getPbAdminToken();
  const res   = await fetch(`${PB_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': token },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'PocketBase error');
  return data;
}

async function pbPatch(path, body) {
  const token = await getPbAdminToken();
  const res   = await fetch(`${PB_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': token },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'PocketBase error');
  return data;
}

async function pbGet(path) {
  const token = await getPbAdminToken();
  const res   = await fetch(`${PB_URL}${path}`, {
    headers: { 'Authorization': token },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'PocketBase error');
  return data;
}

// ── PocketBase collection auto-init ──────────────────────────
const REQUIRED_COLLECTIONS = [
  { name: 'short_urls', fields: [
      { name: 'code',     type: 'text',   required: true  },
      { name: 'long_url', type: 'text',   required: true  },
      { name: 'expires',  type: 'date',   required: false },
  ]},
  { name: 'pastes', fields: [
      { name: 'code',            type: 'text',   required: true  },
      { name: 'title',           type: 'text',   required: false },
      { name: 'content',         type: 'text',   required: true  },
      { name: 'syntax',          type: 'text',   required: false },
      { name: 'expires',         type: 'date',   required: false },
      { name: 'burn_after_read', type: 'bool',   required: false },
  ]},
  { name: 'file_shares', fields: [
      { name: 'code',          type: 'text',   required: true  },
      { name: 'original_name', type: 'text',   required: false },
      { name: 'file_size',     type: 'number', required: false },
      { name: 'file',          type: 'file',   required: true,
        options: { maxSize: 1073741824, maxSelect: 1 } },
      { name: 'expires',       type: 'date',   required: false },
  ]},
];

async function initCollections() {
  try {
    const token = await getPbAdminToken();
    for (const col of REQUIRED_COLLECTIONS) {
      // Check if exists
      const check = await fetch(`${PB_URL}/api/collections/${col.name}`, {
        headers: { 'Authorization': token },
      });
      if (check.status === 200) {
        console.log(`[collections] ${col.name}: already exists`);
        continue;
      }
      // Create
      const res  = await fetch(`${PB_URL}/api/collections`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': token },
        body:    JSON.stringify({ name: col.name, type: 'base', fields: col.fields }),
      });
      const data = await res.json();
      if (res.ok) {
        console.log(`[collections] ${col.name}: created`);
      } else {
        console.warn(`[collections] ${col.name}: failed — ${data.message || JSON.stringify(data)}`);
      }
    }
  } catch (err) {
    console.warn('[collections] init skipped:', err.message);
  }
}

// ── Grin wallet CLI helpers ───────────────────────────────────
async function grinWallet(args) {
  const baseArgs = GRIN_WALLET_PASS ? ['-p', GRIN_WALLET_PASS, ...args] : args;
  try {
    const { stdout, stderr } = await execFileAsync(GRIN_WALLET_BIN, baseArgs, {
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout + (stderr || '');
  } catch (err) {
    const out = (err.stdout || '') + (err.stderr || '');
    throw new Error(`grin-wallet ${args[0]} failed: ${err.message}\n${out}`);
  }
}

function extractSlatepack(output) {
  const m = output.match(/(BEGINSLATEPACK[\s\S]+?ENDSLATEPACK\.)/);
  if (!m) throw new Error('No slatepack found in wallet output. Output was:\n' + output.slice(0, 500));
  return m[1];
}

async function grinInvoice(destAddress, amountGrin) {
  const out = await grinWallet(['invoice', '-d', destAddress, String(amountGrin)]);
  return extractSlatepack(out);
}

async function grinFinalize(responseSlatepack) {
  // Write response to temp file and finalize
  const tmpFile = path.join(os.tmpdir(), `grin_resp_${Date.now()}.slatepack`);
  fs.writeFileSync(tmpFile, responseSlatepack);
  try {
    await grinWallet(['finalize', '-i', tmpFile]);
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

// Verify user token against PocketBase
async function verifyUserToken(authHeader) {
  if (!authHeader) throw new Error('Missing Authorization header');
  const token = authHeader.replace(/^Bearer\s+/i, '');
  // Verify by fetching own user record
  const res = await fetch(`${PB_URL}/api/collections/users/records`, {
    headers: { 'Authorization': token },
  });
  if (!res.ok) throw new Error('Invalid user token');
  return token;
}

async function getUserFromToken(authHeader) {
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('Missing auth token');
  // Use admin to find user by token identity — decode JWT sub claim
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return { id: payload.id, email: payload.email };
  } catch { throw new Error('Invalid token format'); }
}

// ── Routes ────────────────────────────────────────────────────

/**
 * POST /api/payment/initiate
 * Body: { plan: 'pro_monthly' | 'pro_yearly' | 'lifetime' }
 * Auth: Bearer <user JWT>
 */
app.post('/api/payment/initiate', async (req, res) => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    const { plan, grin_address } = req.body;

    if (!PLAN_AMOUNTS[plan]) {
      return res.status(400).json({ error: 'Invalid plan: ' + plan });
    }
    if (!GRIN_RECEIVING_ADDR) {
      return res.status(500).json({ error: 'GRIN_RECEIVING_ADDRESS not configured in server .env' });
    }

    const amountNano = PLAN_AMOUNTS[plan];
    const amountGrin = amountNano / 1e9;
    const expiresAt  = new Date(Date.now() + EXPIRY_MINS * 60 * 1000).toISOString();

    // Create invoice via grin-wallet CLI: grin-wallet invoice -d <receiving_addr> <amount>
    const slatepack = await grinInvoice(GRIN_RECEIVING_ADDR, amountGrin);

    // Store in PocketBase
    const payment = await pbPost('/api/collections/grin_payments/records', {
      user:        user.id,
      plan,
      amount_grin: amountGrin,
      amount_nano: amountNano,
      status:      'pending',
      expires_at:  expiresAt,
    });

    res.json({
      payment_id:  payment.id,
      slatepack,
      amount_grin: amountGrin,
      plan,
      expires_at:  expiresAt,
    });
  } catch (err) {
    console.error('[initiate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/payment/respond
 * Body: { payment_id, response_slatepack }
 * Auth: Bearer <user JWT>
 */
app.post('/api/payment/respond', async (req, res) => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    const { payment_id, response_slatepack } = req.body;
    if (!payment_id || !response_slatepack) {
      return res.status(400).json({ error: 'payment_id and response_slatepack required' });
    }

    // Load payment record
    const payment = await pbGet(`/api/collections/grin_payments/records/${payment_id}`);
    if (payment.user !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (payment.status !== 'pending') return res.status(409).json({ error: 'Payment already ' + payment.status });
    if (new Date(payment.expires_at) < new Date()) {
      await pbPatch(`/api/collections/grin_payments/records/${payment_id}`, { status: 'expired' });
      return res.status(410).json({ error: 'Payment expired' });
    }

    // Finalize via grin-wallet CLI: reads response slatepack, broadcasts tx
    await grinFinalize(response_slatepack);

    // Update payment record
    await pbPatch(`/api/collections/grin_payments/records/${payment_id}`, {
      status:       'confirmed',
      confirmed_at: new Date().toISOString(),
    });

    // Create subscription
    const expiresAt = PLAN_EXPIRES[payment.plan]?.();
    await pbPost('/api/collections/subscriptions/records', {
      user:              user.id,
      plan:              payment.plan,
      status:            'active',
      payment_method:    'grin',
      grin_payment_id:   payment_id,
      starts_at:         new Date().toISOString(),
      expires_at:        expiresAt,
    });

    res.json({ success: true, plan: payment.plan });
  } catch (err) {
    console.error('[respond]', err.message);
    // Mark as failed
    if (req.body.payment_id) {
      pbPatch(`/api/collections/grin_payments/records/${req.body.payment_id}`, { status: 'failed' }).catch(() => {});
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/payment/status/:id
 * Auth: Bearer <user JWT>
 */
app.get('/api/payment/status/:id', async (req, res) => {
  try {
    const user    = await getUserFromToken(req.headers.authorization);
    const payment = await pbGet(`/api/collections/grin_payments/records/${req.params.id}`);
    if (payment.user !== user.id) return res.status(403).json({ error: 'Forbidden' });
    res.json({ status: payment.status, confirmed_at: payment.confirmed_at });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * GET /api/health
 */
app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Grin payment server running on port ${PORT}`);
  console.log(`PocketBase:      ${PB_URL}`);
  console.log(`Grin wallet:     ${GRIN_WALLET_BIN}`);
  console.log(`Receiving addr:  ${GRIN_RECEIVING_ADDR || '(not set — configure GRIN_RECEIVING_ADDRESS in .env)'}`);
  // Auto-create required PocketBase collections
  initCollections();
});
