'use strict';

// Input rules and the expiry sweeper for the three "create a link" tools:
// short URLs (short_urls), pastes (pastes) and file shares (file_shares).
//
// What the pages send (tools/url-shortener, tools/pastebin, tools/file-share):
//   code     custom alias /^[a-zA-Z0-9-]{4,20}$/ (url-shortener's rule), or a random
//            8- or 10-char [A-Za-z0-9] code — all inside SHARE_CODE_RE.
//   expires  '' (never — short URL / paste "Never"), or "YYYY-MM-DD HH:MM:SSZ" from
//            calcExpiry(days). File share always sends a date (1–50 days).

const fs = require('fs');
const path = require('path');

const SHARE_CODE_RE = /^[a-zA-Z0-9-]{4,20}$/;
const LONG_URL_MAX = 2048;
const FILE_SHARE_MAX_DAYS = 50;
const FILE_SHARE_DEFAULT_DAYS = 7;   // the page's preselected option
const DAY_MS = 86_400_000;

function validShareCode(code) {
  return typeof code === 'string' && SHARE_CODE_RE.test(code);
}

// Raw long_url as typed: refuse what has no business in a link (whitespace, quotes,
// angle brackets, backtick, control chars) BEFORE URL parsing tidies it up. Returns
// the normalised href to store, or null.
function normaliseLongUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > LONG_URL_MAX) return null;
  if (/[\s<>"'`\x00-\x1f\x7f-\x9f\u{2028}\u{2029}]/u.test(raw)) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.href.length > LONG_URL_MAX) return null;
  return u.href;
}

// "Date.parse"-able expiry string → ms, or NaN. Same reading as the GET routes'
// `new Date(row.expires)`.
function parseExpiry(s) {
  return typeof s === 'string' && s ? new Date(s).getTime() : NaN;
}

// Short URL / paste expiry: '' means never; otherwise it must parse. Returns the
// string to store, or null for an unparseable value.
function optionalExpiry(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string' || raw.length > 40) return null;
  return Number.isFinite(parseExpiry(raw)) ? raw : null;
}

function fmtExpiry(ms) {
  return new Date(ms).toISOString().replace('T', ' ').split('.')[0] + 'Z';
}

// File share expiry is the SERVER's decision: the page's date, clamped to between
// 1 day and 50 days from now; missing / unparseable → the page's default (7 days).
function fileShareExpiry(raw, now = Date.now()) {
  const t = parseExpiry(typeof raw === 'string' ? raw : '');
  const ms = Number.isFinite(t)
    ? Math.min(Math.max(t, now + DAY_MS), now + FILE_SHARE_MAX_DAYS * DAY_MS)
    : now + FILE_SHARE_DEFAULT_DAYS * DAY_MS;
  return fmtExpiry(ms);
}

// SQLite datetime('now') text ("YYYY-MM-DD HH:MM:SS", UTC) → ms.
function parseCreated(s) {
  return typeof s === 'string' && s ? new Date(s.replace(' ', 'T') + 'Z').getTime() : NaN;
}

// Delete expired rows and their files. Never throws; a file already gone is fine.
// File shares with an empty / unparseable expiry (legacy rows) expire `created` + 50
// days. Short URLs and pastes with an EMPTY expiry are "never" and are kept.
function sweepExpired(db, { uploadsDir, now = Date.now(), log = console } = {}) {
  const out = { files: 0, pastes: 0, shortUrls: 0 };
  const root = uploadsDir ? path.resolve(uploadsDir) : null;
  try {
    const rows = db.prepare('SELECT id, file_path, expires, created FROM file_shares').all();
    const del = db.prepare('DELETE FROM file_shares WHERE id = ?');
    for (const r of rows) {
      let exp = parseExpiry(r.expires);
      if (!Number.isFinite(exp)) {
        const c = parseCreated(r.created);
        exp = Number.isFinite(c) ? c + FILE_SHARE_MAX_DAYS * DAY_MS : NaN;
      }
      if (!(exp < now)) continue;
      // Only ever unlink inside the uploads dir (file_path is a server-made path).
      const fp = typeof r.file_path === 'string' ? path.resolve(r.file_path) : '';
      if (fp && root && fp.startsWith(root + path.sep)) {
        try { fs.unlinkSync(fp); } catch (e) { if (e.code !== 'ENOENT') log.error('[sweep] unlink', e.code || e.message); }
      }
      del.run(r.id);
      out.files++;
    }
  } catch (e) { log.error('[sweep] file_shares', e.message); }

  for (const [table, key, field] of [['pastes', 'id', 'pastes'], ['short_urls', 'code', 'shortUrls']]) {
    try {
      const rows = db.prepare(`SELECT ${key} AS k, expires FROM ${table} WHERE expires IS NOT NULL AND expires != ''`).all();
      const del = db.prepare(`DELETE FROM ${table} WHERE ${key} = ?`);
      for (const r of rows) {
        const exp = parseExpiry(r.expires);
        if (Number.isFinite(exp) && exp < now) { del.run(r.k); out[field]++; }
      }
    } catch (e) { log.error(`[sweep] ${table}`, e.message); }
  }
  return out;
}

module.exports = {
  SHARE_CODE_RE, LONG_URL_MAX, FILE_SHARE_MAX_DAYS, FILE_SHARE_DEFAULT_DAYS,
  validShareCode, normaliseLongUrl, optionalExpiry, fileShareExpiry, sweepExpired,
  parseExpiry,
};
