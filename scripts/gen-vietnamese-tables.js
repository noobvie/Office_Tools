#!/usr/bin/env node
/* Regenerates the legacy-encoding tables inside js/vietnamese.js.
 *
 *   node scripts/gen-vietnamese-tables.js          # check only, prints a diff summary
 *   node scripts/gen-vietnamese-tables.js --write  # rewrite the TABLES block in place
 *
 * Dev-only — nothing in the site runs this. It exists so the tables can be
 * re-derived and re-checked instead of hand-edited, because a single wrong
 * entry produces plausible-looking Vietnamese that is silently wrong, which is
 * worse than not converting at all.
 *
 * Two independent sources, deliberately. They overlap on 74 TCVN3 single-byte
 * entries and that overlap is asserted below: if a future version of either
 * source disagrees with the other, this aborts rather than picking a winner.
 *
 *   1. iconv-lite (already in backend/node_modules) — `tcvn` and `viscii`.
 *      Charset tables, so they carry the precomposed uppercase block that the
 *      font-level tables do not have.
 *   2. anhskohbo/u-convert src/UConvert.php (MIT), pinned below — parallel
 *      UNICODE / VNI / TCVN3 / VIQR arrays of 134 entries. Font-level, so it
 *      carries the uppercase-as-digraph forms ("Aµ" = À) that TCVN3 documents
 *      actually contain, which the charset table does not.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const PIN = '1197533f72ac6ecf152548e637c6693eba664eb6';
const PHP_URL = 'https://raw.githubusercontent.com/anhskohbo/u-convert/' + PIN
  + '/src/UConvert.php';

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'js', 'vietnamese.js');
const ICONV = path.join(ROOT, 'backend', 'node_modules', 'iconv-lite',
  'encodings', 'sbcs-data-generated.js');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error(url + ' → HTTP ' + res.statusCode));
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function parsePhp(src) {
  const out = {};
  for (const key of ['UNICODE', 'VNI', 'TCVN3', 'VIQR']) {
    const m = new RegExp('"' + key + '"[^(]*array[(]([^]*?)[)],').exec(src);
    if (!m) throw new Error('no ' + key + ' array in UConvert.php');
    out[key] = (m[1].match(/"[^"]*"/g) || []).map(s => s.slice(1, -1).trim());
  }
  const n = out.UNICODE.length;
  for (const key of Object.keys(out)) {
    if (out[key].length !== n) throw new Error(key + ' has ' + out[key].length + ', expected ' + n);
  }
  return out;
}

function build(php, iconv) {
  const U = php.UNICODE;
  const pairs = { tcvn3: [], vni: [], viscii: [], viqr: [] };

  // TCVN3: font digraphs and singles first, then whatever bytes only the
  // charset table knows about.
  const seen = new Set();
  php.TCVN3.forEach((s, i) => { pairs.tcvn3.push([s, U[i]]); seen.add(s); });

  const tcvn = iconv.tcvn.chars;
  let checked = 0;
  php.TCVN3.forEach((s, i) => {
    if ([...s].length !== 1) return;
    const other = tcvn[s.codePointAt(0)];
    if (other !== U[i]) {
      throw new Error('sources disagree on TCVN3 0x' + s.codePointAt(0).toString(16)
        + ': u-convert says ' + U[i] + ', iconv-lite says ' + other);
    }
    checked++;
  });
  console.log('cross-checked ' + checked + ' shared TCVN3 entries, 0 conflicts');

  for (let i = 0x80; i < 0x100; i++) {
    const ch = tcvn[i], src = String.fromCharCode(i);
    if (!ch || ch === src || ch === ' ' || seen.has(src)) continue;
    pairs.tcvn3.push([src, ch]);
    seen.add(src);
  }

  php.VNI.forEach((s, i) => { if (s !== U[i]) pairs.vni.push([s, U[i]]); });
  php.VIQR.forEach((s, i) => pairs.viqr.push([s, U[i]]));

  const viscii = iconv.viscii.chars;
  for (let i = 0x02; i < 0x100; i++) {
    const ch = viscii[i], src = String.fromCharCode(i);
    if (ch && ch !== src) pairs.viscii.push([src, ch]);
  }

  // Longest key first — decode() relies on this, since JS alternation is
  // first-match-wins and "Ê" is a prefix-free suffix of "¢Ê".
  for (const k of Object.keys(pairs)) pairs[k].sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

// Anything invisible becomes an escape: the C1 block is a real part of these
// tables and would not survive a copy-paste or a re-save as literal bytes.
function lit(s) {
  return JSON.stringify(s).replace(/[\u0000-\u001f\u007f-\u00a0]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function render(pairs) {
  return ['tcvn3', 'vni', 'viscii', 'viqr'].map(k =>
    '    ' + k + ': [' + pairs[k].map(p => lit(p[0]) + ',' + lit(p[1])).join(', ') + '],'
  ).join('\n') + '\n';
}

(async function main() {
  if (!fs.existsSync(ICONV)) {
    console.error('missing ' + ICONV + ' — run `npm install` in backend/ first');
    process.exit(1);
  }
  const iconv = require(ICONV);
  const pairs = build(parsePhp(await get(PHP_URL)), iconv);
  for (const k of Object.keys(pairs)) console.log('  ' + k + ': ' + pairs[k].length + ' pairs');

  const block = render(pairs);
  const file = fs.readFileSync(TARGET, 'utf8');
  const start = file.indexOf('  var TABLES = {\n');
  const end = file.indexOf('\n  };', start);
  if (start < 0 || end < 0) throw new Error('TABLES block not found in ' + TARGET);
  const current = file.slice(start + '  var TABLES = {\n'.length, end + 1);

  if (current === block) { console.log('\njs/vietnamese.js is up to date'); return; }
  if (process.argv.indexOf('--write') < 0) {
    console.log('\njs/vietnamese.js DIFFERS from the generated tables. Re-run with --write.');
    process.exit(1);
  }
  fs.writeFileSync(TARGET,
    file.slice(0, start + '  var TABLES = {\n'.length) + block + file.slice(end + 1));
  console.log('\nwrote ' + TARGET);
})().catch(err => { console.error(err.message); process.exit(1); });
