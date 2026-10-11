'use strict';

// Reader-mode HTML rewrite for GET /api/net/proxy: absolutise links/assets and route
// them back through the proxy. Peeled out of office-tools-server.js so it can be tested.
//
// ⚠ Every pattern here runs on an attacker-chosen page of up to 12 MiB, ON THE EVENT
// LOOP, so every one must be LINEAR in the input. The rule that keeps them so:
// - a tag body is `[^<>]*`, never `[^>]*` — from each of N unclosed `<meta`s, `[^>]*`
//   scans to the end of the input: O(N²);
// - a value runs to a delimiter its own opener contains (`[^'"()\s]` inside `url(`), so
//   the scan from one opener stops at the next one;
// - two adjacent quantifiers never share characters (`\s*` beside a class that also
//   matches spaces is exponential-ish backtracking, not just quadratic);
// - a paired element (`<script>…</script>`) is cut by a loop that searches for the close
//   ONCE per open tag, never by `[\s\S]*?`, which retries from every later open.
// R1 measured the old patterns: 256 KiB of `url(a` took 56 s, so 12 MiB was ~36 hours
// of a frozen backend from one request.
//
// The proxied page is served from OUR origin. proxyHeaders() sandboxes it (opaque
// origin), so a direct top-level link to …/api/net/proxy?url=<attacker page>&strip=0
// cannot run script as tools.grin.money or read its storage.

function absolutize(ref, base) { try { return new URL(ref, base).href; } catch { return null; } }
function proxify(absUrl, selfBase) { return `${selfBase}?url=${encodeURIComponent(absUrl)}&self=${encodeURIComponent(selfBase)}`; }

// Drop every <script>…</script> (and an unclosed one through to the end, as a browser would).
function stripScriptElements(html) {
  const open = /<script\b/gi;
  const close = /<\/script\s*>/gi;
  let out = '', pos = 0, m;
  while ((m = open.exec(html))) {
    out += html.slice(pos, m.index);
    close.lastIndex = m.index;
    if (!close.exec(html)) { pos = html.length; break; }
    pos = close.lastIndex;
    open.lastIndex = pos;
  }
  return out + html.slice(pos);
}

function rewriteHtml(html, baseUrl, selfBase, stripScripts) {
  // Drop directives that would block rewritten/proxied content
  // (each tag is matched once, then tested: a pattern with `[^<>]*` on BOTH sides of the
  // keyword rescans the tail once per repeat of the keyword inside one tag)
  html = html.replace(/<meta\b[^<>]*>/gi, tag => (
    /http-equiv\s*=\s*["']?content-security-policy\b/i.test(tag) ? '' : tag));
  html = html.replace(/\sintegrity\s*=\s*("|')[^"']*\1/gi, '');
  html = html.replace(/\scrossorigin(\s*=\s*("|')[^"']*\2)?/gi, '');

  if (stripScripts) {
    html = stripScriptElements(html);
    html = html.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ''); // inline handlers
  }

  // CSS url(...). A value holding a paren, quote or whitespace is left alone (rare; the
  // browser then loads it directly, as before for any value this pattern did not match).
  // The value class must not overlap the `\s*` around it: when it did, `url(` + 32 KiB of
  // spaces never finished (each split of the run was retried against every value length).
  html = html.replace(/url\(\s*(['"]?)([^'"()\s]{1,4096})\1\s*\)/gi, (m, q, ref) => {
    if (/^(data:|#)/i.test(ref.trim())) return m;
    const abs = absolutize(ref.trim(), baseUrl);
    return abs ? `url(${q}${proxify(abs, selfBase)}${q})` : m;
  });

  // srcset (comma-separated candidate list)
  html = html.replace(/\ssrcset\s*=\s*("|')(.*?)\1/gi, (m, q, val) => {
    const out = val.split(',').map(part => {
      const seg = part.trim().split(/\s+/);
      if (seg[0] && !/^data:/i.test(seg[0])) {
        const abs = absolutize(seg[0], baseUrl);
        if (abs) seg[0] = proxify(abs, selfBase);
      }
      return seg.join(' ');
    }).join(', ');
    return ` srcset=${q}${out}${q}`;
  });

  // href / src / action / poster
  html = html.replace(/\s(href|src|action|poster)\s*=\s*("|')(.*?)\2/gi, (m, attr, q, ref) => {
    const t = ref.trim();
    if (!t || /^(data:|mailto:|tel:|javascript:|#)/i.test(t)) return m;
    const abs = absolutize(t, baseUrl);
    return abs ? ` ${attr}=${q}${proxify(abs, selfBase)}${q}` : m;
  });

  // A small banner so the user knows they are inside the proxy
  const banner = `<div style="all:initial;display:block;font:13px/1.4 system-ui,sans-serif;background:#1a1a2e;color:#e0e0e0;padding:8px 14px;border-bottom:2px solid #6c5ce7;position:sticky;top:0;z-index:2147483647">🛡️ Viewed via Office Tools web proxy — <span style="color:#a29bfe">${baseUrl.replace(/"/g, '&quot;').replace(/</g, '&lt;')}</span></div>`;
  const body = /<body\b[^<>]*>/i.exec(html);
  if (body) html = html.slice(0, body.index + body[0].length) + banner + html.slice(body.index + body[0].length);
  else html = banner + html;

  return html;
}

// Headers for every proxy response. `sandbox` without allow-same-origin gives the
// document an opaque origin, top-level or framed; tools/web-proxy's iframe sandbox
// intersects with it, so the tool behaves as before. An asset (an SVG opened directly)
// gets no allow-scripts at all.
function proxyHeaders(isHtml) {
  return {
    'Content-Security-Policy': isHtml ? 'sandbox allow-scripts allow-forms allow-popups' : 'sandbox',
    'X-Content-Type-Options': 'nosniff',
  };
}

module.exports = { rewriteHtml, stripScriptElements, proxyHeaders, absolutize, proxify };
