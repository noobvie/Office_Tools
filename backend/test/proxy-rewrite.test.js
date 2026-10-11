'use strict';

// lib/proxy-rewrite.js — the /api/net/proxy HTML rewrite. Two properties:
// it still rewrites a real page the same way, and it is LINEAR on hostile input (R1:
// the old patterns took 56 s on 256 KiB, so a 12 MiB page froze the backend for hours).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { rewriteHtml, stripScriptElements, proxyHeaders } = require('../lib/proxy-rewrite');

const SELF = 'https://tools.example/api/net/proxy';
const BASE = 'https://site.example/dir/page.html';
const px = abs => `${SELF}?url=${encodeURIComponent(abs)}&self=${encodeURIComponent(SELF)}`;

describe('rewriteHtml — behaviour on a real page', () => {
  const page = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'">
<link rel="stylesheet" href="/a.css" integrity="sha384-x" crossorigin="anonymous">
<style>body{background:url('img/bg.png')} .d{background:url(data:image/png;base64,AA==)}</style>
<script src="/app.js"></script><script>alert(1)</script>
</head><body class="b" onload="evil()">
<a href="other.html">x</a> <a href="#top">t</a> <a href="mailto:a@b">m</a>
<img src="i.png" srcset="i1.png 1x, i2.png 2x" onerror='bad()'>
<form action="/post"></form>
</body></html>`;

  test('stripScripts on: scripts, handlers, CSP meta, SRI gone; links proxied; banner after <body>', () => {
    const out = rewriteHtml(page, BASE, SELF, true);
    assert.doesNotMatch(out, /<script/i);
    assert.doesNotMatch(out, /alert\(1\)/);
    assert.doesNotMatch(out, /onload|onerror/i);
    assert.doesNotMatch(out, /Content-Security-Policy/i);
    assert.doesNotMatch(out, /integrity|crossorigin/i);
    assert.ok(out.includes(`href="${px('https://site.example/a.css')}"`));
    assert.ok(out.includes(`url('${px('https://site.example/dir/img/bg.png')}')`));
    assert.ok(out.includes('url(data:image/png;base64,AA==)'), 'data: URLs untouched');
    assert.ok(out.includes(`href="${px('https://site.example/dir/other.html')}"`));
    assert.ok(out.includes('href="#top"') && out.includes('href="mailto:a@b"'));
    assert.ok(out.includes(`srcset="${px('https://site.example/dir/i1.png')} 1x, ${px('https://site.example/dir/i2.png')} 2x"`));
    assert.ok(out.includes(`action="${px('https://site.example/post')}"`));
    assert.match(out, /<body class="b"\s*><div style="all:initial/);
  });
  test('stripScripts off: scripts stay (and are proxied)', () => {
    const out = rewriteHtml(page, BASE, SELF, false);
    assert.ok(out.includes('<script>alert(1)</script>'));
    assert.ok(out.includes(`src="${px('https://site.example/app.js')}"`));
  });
  test('an unclosed <script> swallows the rest, as a browser would', () => {
    assert.equal(stripScriptElements('a<script>b</script>c<SCRIPT src=x>d</script >e<script>f'), 'ace');
  });
  test('the banner text is escaped, and a $-pattern in the URL is not a replacement token', () => {
    const out = rewriteHtml('<body>x</body>', 'https://a.example/"><b>$`$&', SELF, true);
    assert.ok(out.includes('https://a.example/&quot;>&lt;b>$`$&</span>'));
    assert.ok(out.startsWith('<body><div'));
  });
  test('no <body> → the banner is prepended', () => {
    assert.match(rewriteHtml('<p>x</p>', BASE, SELF, true), /^<div style="all:initial/);
  });
});

describe('rewriteHtml — linear on hostile input (R1 HIGH)', () => {
  const N = 1024 * 1024;   // old patterns: url( ≈ 15 min, <meta ≈ 3 min at this size
  const hostile = {
    'unclosed url(':         'url(a'.repeat(N / 5),
    'unclosed quoted url(':  "url('a".repeat(N / 6),
    'unclosed <meta':        '<meta '.repeat(N / 6),
    'unclosed <script':      '<script>'.repeat(N / 8),
    'unclosed <script attr': '<script a=b '.repeat(N / 12),
    'unclosed <body':        '<body '.repeat(N / 6),
    'integrity runs':        ' integrity="'.repeat(N / 12),
    'crossorigin runs':      ' crossorigin=\''.repeat(N / 14),
    'srcset mixed quotes':   (' srcset="' + ' srcset=\''.repeat(50)).repeat(N / 460),
    'href mixed quotes':     (' href="' + ' href=\''.repeat(50)).repeat(N / 360),
    'handler runs':          ' onx="'.repeat(N / 6),
    'whitespace after url(': 'url(' + ' '.repeat(N),             // hung the R1 draft at 32 KiB
    'url( a + whitespace':   ('url( a' + ' '.repeat(4090)).repeat(N / 4096),
    'CSP keyword repeated in one tag': '<meta' + ' http-equiv=content-security-policy'.repeat(N / 36),
  };
  for (const [label, input] of Object.entries(hostile)) {
    test(label, () => {
      const t0 = process.hrtime.bigint();
      rewriteHtml(input, BASE, SELF, true);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(ms < 1500, `${label}: ${ms.toFixed(0)} ms on 1 MiB`);
    });
  }
});

describe('proxyHeaders — proxied content never runs as our origin (R1 MEDIUM)', () => {
  test('HTML: sandboxed with scripts allowed but NO allow-same-origin', () => {
    const h = proxyHeaders(true);
    assert.match(h['Content-Security-Policy'], /^sandbox\b/);
    assert.doesNotMatch(h['Content-Security-Policy'], /allow-same-origin|allow-top-navigation/);
    assert.equal(h['X-Content-Type-Options'], 'nosniff');
  });
  test('assets (an SVG opened top-level): sandbox with nothing allowed', () => {
    assert.equal(proxyHeaders(false)['Content-Security-Policy'], 'sandbox');
  });
});
