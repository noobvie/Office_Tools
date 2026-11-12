'use strict';

// Small input sanitisers shared by the routes.
//
// Why str() exists: request values are not always strings. `?ip[]=a` makes
// req.query.ip an array, a JSON body can hold an object, and multer bodies are
// null-prototype objects — `String(v)` on {"toString":1} or on a null-prototype
// object THROWS, and `.trim()` on an array throws. Inside an async handler that
// throw used to become an unhandled rejection. str() turns anything that is not a
// string into '' so every later check just sees "missing".

function str(v) {
  return typeof v === 'string' ? v : '';
}

// C0 controls, DEL, C1 controls and the Unicode line/paragraph separators.
const CTL_RE = /[\x00-\x1f\x7f-\x9f\u{2028}\u{2029}]/gu;

function stripCtl(s) {
  return str(s).replace(CTL_RE, '');
}

// Text that ends up in a mail header (Subject): no CR/LF or any other control
// character, whitespace runs collapsed, capped.
function cleanHeaderText(s, max = 200) {
  return str(s).replace(CTL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// A name a user gave a file: no path separators, no control characters, capped.
// Returns '' when nothing usable is left (the caller picks its own fallback).
function safeFileName(name, max = 200) {
  let s = str(name).replace(CTL_RE, '').replace(/[\\/]/g, '_').trim();
  if (s === '.' || s === '..') s = '';
  return s.slice(0, max);
}

// One plain mailbox address for a sendmail argv: no whitespace, comma, quote,
// angle bracket or leading dash. Used for operator-configured notify addresses.
function validMailbox(addr) {
  const s = str(addr);
  return s.length <= 254 && /^[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(s)
      && !s.startsWith('-');
}

module.exports = { str, stripCtl, cleanHeaderText, safeFileName, validMailbox };
