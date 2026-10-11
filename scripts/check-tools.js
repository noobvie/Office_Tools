#!/usr/bin/env node
/**
 * scripts/check-tools.js — the mechanical sweep. Cross-tool invariants for the
 * whole site, run before any human reads a tool page. Extends check-html.js
 * (which stays the single source of the theme-init rule).
 *
 *   node scripts/check-tools.js                 gate: fail on any finding NOT in the baseline
 *   node scripts/check-tools.js --strict        ignore the baseline, fail on everything
 *   node scripts/check-tools.js --update-baseline   accept today's findings as the new debt
 *   node scripts/check-tools.js --only=registry,head   run a subset of rules
 *   node scripts/check-tools.js --verbose       also list the baselined (pre-existing) findings
 *   node scripts/check-tools.js --json          machine-readable output
 *
 * RULES
 *   registry   tools/<dir>  ↔  hub card (index.html)  ↔  OT_TOOLS (js/common.js)  ↔  sitemap.xml
 *              all name the same set, with no duplicates; each tool's OT_TOOLS.cat is one the
 *              hub section it sits in maps to (HUB_CAT_MAP); its canonical + og:url point at itself.
 *   head       charset · viewport · non-empty <title> · non-empty description · favicon ·
 *              <html lang data-theme="matrix"> · theme-init before style.css (from check-html.js)
 *   cdn        every <script src>/<link href> from a CDN is version-PINNED (x.y.z, never @2 or
 *              @latest) and carries integrity= + crossorigin=; a CDN URL built in JS is pinned and
 *              lives in a file that verifies integrity somewhere.
 *   innerhtml  HEURISTIC: an innerHTML/outerHTML/insertAdjacentHTML/document.write whose value
 *              interpolates or concatenates data must pass that data through an escape helper.
 *              The page's helper is learned from its body (`&lt;`, `replace(/</g`), not its name.
 *   console    no console.log in shipped code (tool pages, js/, backend/, yt-server/). scripts/
 *              are CLIs whose output IS console.log, so they are out of scope.
 *   colours    no #hex colour in a page's <style> block or style="" attribute — those bypass the
 *              four-theme variable system — and no var(--x) whose --x is defined neither in
 *              css/style.css nor on the page (its fallback, or nothing, renders in every theme).
 *              A hex that is only the fallback of a DEFINED variable is dead code and skipped.
 *              JS colour literals (canvas, colour-tool defaults) are deliberately NOT in scope.
 *   hosts      a page may LOAD (src=, <link href>, fetch, WebSocket, url(), @import, Worker…) only
 *              from the operator's hosts, the pinned CDNs, or a per-file functional allowlist.
 *              Plain <a href> links are content, not loads, and are not checked. Known tracker
 *              hosts and GA measurement-ID literals are flagged wherever they appear except the
 *              one sanctioned analytics loader (js/common.js).
 *   syntax     node --check on backend/, backend/lib/, js/, yt-server/, scripts/; every inline
 *              <script> compiled with vm.Script; every ld+json block JSON-parsed.
 *   sitemap    lastmod is a real date and not in the future; the hub, donate and privacy pages
 *              are present.
 *
 * BASELINE  scripts/check-tools.baseline.json — a count per finding fingerprint
 * (rule|file|message, line numbers stripped, so an edit above a finding does not
 * "create" one). The default run fails only on findings above their baselined count,
 * so a legacy codebase can adopt the gate on day one while every pre-existing finding
 * stays visible in the summary as DEBT. A finding that disappears makes the baseline
 * stale — the run says so and asks for --update-baseline, so the debt can only ratchet
 * down. Never edit the baseline by hand to hide a NEW finding: fix it, or update the
 * baseline in a commit that says why the finding is accepted.
 *
 * Exit code 0 = gate passed, 1 = new findings (or any finding under --strict),
 * 2 = the checker itself could not run (missing file, bad baseline JSON).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { spawnSync } = require('child_process');
const { checkThemeInit } = require('./check-html');

const ROOT = path.join(__dirname, '..');
const BASELINE_FILE = path.join(__dirname, 'check-tools.baseline.json');
const SITE = 'https://tools.grin.money';

/* ────────────────────────────── policy tables ────────────────────────────── */

/** Hub section (index.html data-category, entities decoded) → OT_TOOLS.cat values allowed
 *  in it. The two taxonomies diverged on purpose (the hub merges PDF+Text and Media+Design);
 *  this table is the one place that divergence is written down. */
const HUB_CAT_MAP = {
  'Productivity & Time': ['⏱️ Productivity & Time'],
  'Generators':          ['✨ Generators'],
  'PDF & Text':          ['📁 PDF', '📝 Text & Content'],
  'Encoding & Crypto':   ['🔒 Encoding & Crypto'],
  'Calculators':         ['🧮 Calculators'],
  'Development':         ['💻 Development'],
  'Network & Security':  ['🌐 Network & Web'],
  'Media':               ['🎬 Media', '🎨 Design'],
  'Share':               ['📤 Share'],
  'Relax':               ['🎮 Relax'],
};
const KNOWN_OT_CATS = new Set(Object.values(HUB_CAT_MAP).flat());

/** Hosts a page may load resources from, anywhere on the site. */
const OPERATOR_HOSTS = new Set([
  'tools.grin.money', 'grin.money', 'ip4.grin.money', 'ip6.grin.money',
  // deploy.sh patches these placeholders in js/config.js
  'api.yourdomain.com', 'ip4.yourdomain.com', 'ip6.yourdomain.com',
  'localhost', '127.0.0.1',
]);
const CDN_HOSTS = new Set(['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com']);

/** Functional third-party APIs a specific tool genuinely needs. Adding a row here is a
 *  policy decision — say why in the commit. Key = repo-relative POSIX path. */
const FILE_HOST_ALLOW = {
  'tools/currency/index.html':      ['api.coingecko.com', 'open.er-api.com'],
  'tools/yt-downloader/index.html': ['www.youtube.com', 'www.googleapis.com'],
  // The ONE sanctioned analytics loader (OT_GA_ID). Anywhere else it is a finding.
  'js/common.js':                   ['www.googletagmanager.com'],
};

/** Third-party analytics/tracking hosts: a finding wherever they appear (subject only to
 *  FILE_HOST_ALLOW above), even inside an <a href>. */
const TRACKER_HOST_RE = /\b(?:[a-z0-9-]+\.)*(?:googletagmanager\.com|google-analytics\.com|analytics\.google\.com|doubleclick\.net|facebook\.net|connect\.facebook\.com|hotjar\.com|clarity\.ms|mixpanel\.com|segment\.(?:com|io)|plausible\.io|matomo\.cloud|fullstory\.com|amplitude\.com|intercom\.io|sentry\.io)\b/gi;
const GA_ID_RE = /\bG-[A-Z0-9]{8,12}\b/g;

/** Escape-helper names accepted without seeing their body (the body scan adds more). */
const DEFAULT_ESCAPERS = ['escHtml', 'escapeHtml', 'escapeHTML', 'esc', 'escAttr', 'escapeAttr', 'htmlEscape', 'encodeHTML', 'sanitize'];
/** Calls whose output is HTML-safe by construction. */
const SAFE_CALLS_RE = /\b(?:DOMPurify\.sanitize|hljs\.highlight(?:Auto)?|encodeURIComponent|encodeURI|Number|parseInt|parseFloat|Math\.\w+|isFinite|Boolean)\s*\(|\.replace\(\s*\/</;   // …or escapes inline
/** Interpolations that cannot carry markup: numbers, counters, literal-only ternaries. */
// A literal branch may contain markup ('<br>🎊 New Year') — it is author-written, not data.
const LIT = `(?:'[^']*'|"[^"]*"|\`[^\`$]*\`)`;
const SAFE_INTERP_RES = [
  /^\s*[\w.$[\]]+\.(?:length|size|checked|disabled|selectedIndex|value\.length)\s*$/,
  /^\s*[\w.$[\]()\s+\-*/%]+\.(?:toFixed|toPrecision|toLocaleString|toISOString|toLocaleDateString|toLocaleTimeString|toUTCString|toDateString|toTimeString|getFullYear|getMonth|getDate|getHours|getMinutes|getSeconds|getTime)\([^)]*\)\s*$/,
  new RegExp(`^\\s*${LIT}\\s*$`),                                          // a literal
  new RegExp(`^\\s*[^?]*\\?\\s*${LIT}\\s*:\\s*${LIT}\\s*$`),               // cond ? 'lit' : 'lit'  (class names, plurals)
  new RegExp(`^\\s*[^?]*\\?\\s*${LIT}\\s*:\\s*${LIT}\\s*:?\\s*$`),
  /^\s*(?:i|j|k|n|idx|index|count|total|num|len|page|pages|row|col|x|y|w|h|width|height|size|step|pct|percent|score|level|moves|best|rank|\d+(?:\.\d+)?)(?:\s*[+\-*/%]\s*(?:\d+(?:\.\d+)?|[ijkn]))*\s*$/,
  /^\s*(?:true|false|null|undefined)\s*$/,
  /^\s*[A-Z][A-Z0-9_]{2,}(?:\.\w+|\[[^\]]*\])*\s*$/,                        // CONSTANT_TABLE[key] / CONST.prop — a fixed lookup table, not data
  /^\s*\[[\s\S]*\]\s*\.join\([^)]*\)\s*$/,                                 // [frag(), frag()].join('') — fragments by construction
];
/** A variable whose NAME says it carries pre-built HTML. Convention, not proof — but the
 *  alternative is flagging every `el.innerHTML = html` in the codebase. */
const HTML_CARRIER_RE = /^\s*(?:(?:html|rows|cards|markup|out|output|content|body|header|head|footer|inner|tpl|template|frag|fragment|list|items|chips|links|parts|svg|ico|icon|border|cells|options|opts|legend|tbody|thead|table|grid|badge|badges|summary|result|results|str|s|\w+(?:Html|HTML|Markup|Rows|Cards|Svg|SVG|Frag|Tpl|Template|Icon|Badge|Cells|Items|Chips|List|Table|Row|Cell|Out|Str))(?:\s*\.join\([^)]*\))?|[\w.$[\]]+\.(?:outerHTML|innerHTML)|\(?\s*\w+\s*\?\s*\w+\.outerHTML\s*:\s*(?:''|"")\s*\)?)\s*$/;   // …or a DOM node's own serialisation
/** Calls that RETURN their input's text unchanged (or decoded) — not an escape, whatever they wrap. */
const PASSTHROUGH_CALL_RE = /\.(?:trim|trimStart|trimEnd|toUpperCase|toLowerCase|slice|substring|substr|replace|replaceAll|split|concat|repeat|padStart|padEnd|normalize|toString|valueOf|at|charAt|get|getItem|getAttribute|querySelector|map|filter|reverse|sort|flat|find|pop|shift|join)\s*\([^)]*\)\s*$|^\s*(?:String|decodeURIComponent|decodeURI|atob|unescape|JSON\.stringify|JSON\.parse|localStorage\.getItem|sessionStorage\.getItem)\s*\(/;

/** Where node --check runs. Directories are non-recursive except backend/lib. */
const SYNTAX_JS_GLOBS = ['backend/*.js', 'backend/lib/*.js', 'js/*.js', 'yt-server/*.js', 'scripts/*.js'];

/* ──────────────────────────────── helpers ───────────────────────────────── */

const args = process.argv.slice(2);
const opt = {
  strict:   args.includes('--strict'),
  update:   args.includes('--update-baseline'),
  verbose:  args.includes('--verbose'),
  json:     args.includes('--json'),
  only:     (args.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean),
};
const unknown = args.filter(a => !/^--(strict|update-baseline|verbose|json|only=.*)$/.test(a));
if (unknown.length) { console.error(`unknown option(s): ${unknown.join(' ')}`); process.exit(2); }

const posix = p => p.split(path.sep).join('/');
const rel   = p => posix(path.relative(ROOT, p));
const read  = p => fs.readFileSync(p, 'utf8');
const exists = p => fs.existsSync(p);
const decodeEntities = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

/** Tiny glob: dir/*.js (one level) only. */
function glob(pattern) {
  const [dir, base] = [path.dirname(pattern), path.basename(pattern)];
  const abs = path.join(ROOT, dir);
  if (!exists(abs)) return [];
  const re = new RegExp('^' + base.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  return fs.readdirSync(abs).filter(f => re.test(f) && fs.statSync(path.join(abs, f)).isFile()).map(f => path.join(abs, f));
}

/* ──────────────────────────────── findings ──────────────────────────────── */

const findings = [];   // { rule, file, line, msg }
function add(rule, file, line, msg) { findings.push({ rule, file: posix(file), line: line || 0, msg }); }
const fingerprint = f => `${f.rule}|${f.file}|${f.msg}`;

/* ─────────────────────────────── inventory ──────────────────────────────── */

const toolDirs = fs.readdirSync(path.join(ROOT, 'tools'), { withFileTypes: true })
  .filter(d => d.isDirectory()).map(d => d.name).sort();
const toolPage = name => path.join(ROOT, 'tools', name, 'index.html');
const pages = {};   // name → html (only dirs that have an index.html)
for (const name of toolDirs) if (exists(toolPage(name))) pages[name] = read(toolPage(name));

const hubHtml     = read(path.join(ROOT, 'index.html'));
const commonJs    = read(path.join(ROOT, 'js', 'common.js'));
const sitemapXml  = read(path.join(ROOT, 'sitemap.xml'));

/** Hub cards: href → { section, dataName, dataKeywords, line } */
function parseHubCards(html) {
  const cards = [];
  html = html.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));   // a commented-out card is not a card (line numbers kept)
  const secRe = /<section\s+class="category-section"([^>]*)>([\s\S]*?)<\/section>/g;
  let s;
  while ((s = secRe.exec(html))) {
    const catAttr = /data-category="([^"]*)"/.exec(s[1]);
    const section = catAttr ? decodeEntities(catAttr[1]) : null;   // null = Most Used / Recently Added (dynamic)
    const cardRe = /<a\s+([^>]*class="tool-card"[^>]*)>/g;
    let c;
    while ((c = cardRe.exec(s[2]))) {
      const attrs = c[1];
      const href = /href="([^"]*)"/.exec(attrs);
      const m = href && /^tools\/([^/]+)\/(?:index\.html)?$/.exec(href[1]);
      cards.push({
        name: m ? m[1] : null, href: href ? href[1] : '(none)', section,
        dataName: /data-name="([^"]*)"/.test(attrs), dataKeywords: /data-keywords="([^"]*)"/.test(attrs),
        line: lineOf(html, s.index + c.index),
      });
    }
  }
  return cards;
}

/** OT_TOOLS, evaluated as data in an empty sandbox — a regex would break on a comma in a desc. */
function parseOtTools(js) {
  const m = /const OT_TOOLS\s*=\s*(\[[\s\S]*?\n\]);/.exec(js);
  if (!m) throw new Error('js/common.js: could not find `const OT_TOOLS = [ … ];`');
  const arr = vm.runInNewContext('(' + m[1] + ')', {}, { timeout: 1000 });
  return { list: arr, line: lineOf(js, m.index) };
}

function parseSitemap(xml) {
  const urls = [];
  const re = /<url>\s*<loc>([^<]*)<\/loc>(?:\s*<lastmod>([^<]*)<\/lastmod>)?/g;
  let m;
  while ((m = re.exec(xml))) urls.push({ loc: m[1].trim(), lastmod: m[2] ? m[2].trim() : null, line: lineOf(xml, m.index) });
  return urls;
}

/* ───────────────────────────────── rules ────────────────────────────────── */

const RULES = {};

RULES.registry = () => {
  const hub = 'index.html', cj = 'js/common.js', sm = 'sitemap.xml';
  const dirSet = new Set(Object.keys(pages));
  for (const name of toolDirs) if (!pages[name]) add('registry', `tools/${name}`, 0, 'tool directory has no index.html');

  // hub cards
  const cards = parseHubCards(hubHtml);
  const hubByName = new Map();
  for (const c of cards) {
    if (!c.name) { add('registry', hub, c.line, `tool-card href is not tools/<name>/…: ${c.href}`); continue; }
    if (!c.section) { add('registry', hub, c.line, `static tool-card for ${c.name} inside a dynamic section (Most Used / Recently Added)`); continue; }
    if (!(c.section in HUB_CAT_MAP)) add('registry', hub, c.line, `hub section "${c.section}" is not in HUB_CAT_MAP`);
    if (hubByName.has(c.name)) add('registry', hub, c.line, `duplicate hub card for ${c.name}`);
    else hubByName.set(c.name, c);
    if (!dirSet.has(c.name)) add('registry', hub, c.line, `hub card points at tools/${c.name}/ which does not exist`);
    if (!c.dataName) add('registry', hub, c.line, `hub card ${c.name} has no data-name (search)`);
    if (!c.dataKeywords) add('registry', hub, c.line, `hub card ${c.name} has no data-keywords (search)`);
  }

  // OT_TOOLS
  let ot;
  try { ot = parseOtTools(commonJs); }
  catch (e) { add('registry', cj, 0, e.message); return; }
  const otByPath = new Map();
  ot.list.forEach((t, i) => {
    const where = `OT_TOOLS[${i}] (${t.path || '?'})`;
    for (const k of ['name', 'path', 'cat', 'icon', 'desc']) if (typeof t[k] !== 'string' || !t[k].trim()) add('registry', cj, ot.line, `${where}: missing or empty "${k}"`);
    if (!t.path) return;
    if (otByPath.has(t.path)) add('registry', cj, ot.line, `duplicate OT_TOOLS entry for ${t.path}`);
    else otByPath.set(t.path, t);
    if (!dirSet.has(t.path)) add('registry', cj, ot.line, `OT_TOOLS lists ${t.path} but tools/${t.path}/ does not exist`);
    if (t.cat && !KNOWN_OT_CATS.has(t.cat)) add('registry', cj, ot.line, `${where}: cat "${t.cat}" is not a known category (lands in a category of one)`);
  });

  // sitemap
  const urls = parseSitemap(sitemapXml);
  const smByName = new Map();
  for (const u of urls) {
    const m = new RegExp(`^${SITE.replace(/\./g, '\\.')}/tools/([^/]+)/$`).exec(u.loc);
    if (!m) continue;   // non-tool URLs are checked by the sitemap rule
    if (smByName.has(m[1])) add('registry', sm, u.line, `duplicate sitemap entry for ${m[1]}`);
    else smByName.set(m[1], u);
    if (!dirSet.has(m[1])) add('registry', sm, u.line, `sitemap lists tools/${m[1]}/ which does not exist`);
  }

  // every dir must be in all three, with an agreeing category and a self-pointing canonical
  for (const name of Object.keys(pages)) {
    const card = hubByName.get(name), t = otByPath.get(name);
    if (!card) add('registry', hub, 0, `tools/${name}/ has no hub card`);
    if (!t)    add('registry', cj, 0, `tools/${name}/ is not registered in OT_TOOLS (no sidebar, search, breadcrumb or Related Tools)`);
    if (!smByName.has(name)) add('registry', sm, 0, `tools/${name}/ is missing from the sitemap`);
    if (card && t && card.section in HUB_CAT_MAP && !HUB_CAT_MAP[card.section].includes(t.cat)) {
      add('registry', cj, ot.line, `${name}: OT_TOOLS.cat "${t.cat}" but the hub card sits in "${card.section}" (allowed: ${HUB_CAT_MAP[card.section].join(' | ')})`);
    }
    const html = pages[name], file = `tools/${name}/index.html`, self = `${SITE}/tools/${name}/`;
    const canon = /<link\s+rel="canonical"\s+href="([^"]*)"/.exec(html);
    if (!canon) add('registry', file, 0, 'no <link rel="canonical">');
    else if (canon[1] !== self) add('registry', file, lineOf(html, canon.index), `canonical is ${canon[1]}, expected ${self}`);
    const og = /<meta\s+property="og:url"\s+content="([^"]*)"/.exec(html);
    if (og && og[1] !== self) add('registry', file, lineOf(html, og.index), `og:url is ${og[1]}, expected ${self}`);
  }
};

RULES.head = () => {
  for (const [name, html] of Object.entries(pages)) {
    const file = `tools/${name}/index.html`;
    const head = (/<head[^>]*>([\s\S]*?)<\/head>/i.exec(html) || [, ''])[1];
    if (!head) { add('head', file, 0, 'no <head> element'); continue; }
    const tag = (re, what) => { if (!re.test(head)) add('head', file, 0, `missing ${what}`); };
    tag(/<meta\s+charset=["']?utf-8["']?/i, '<meta charset="UTF-8">');
    tag(/<meta\s+name="viewport"\s+content="[^"]*width=device-width[^"]*"/i, 'viewport meta with width=device-width');
    const title = /<title>([^<]*)<\/title>/i.exec(head);
    if (!title || !title[1].trim()) add('head', file, 0, 'missing or empty <title>');
    const desc = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(head);
    if (!desc || !desc[1].trim()) add('head', file, 0, 'missing or empty <meta name="description">');
    tag(/<link\s+rel="(?:shortcut )?icon"/i, '<link rel="icon"> (browsers then 404 on /favicon.ico)');
    if (!/<html[^>]*\slang="[a-z]{2}(?:-[A-Za-z]{2})?"/.test(html)) add('head', file, 0, '<html> has no lang attribute');
    if (!/<html[^>]*\sdata-theme="matrix"/.test(html)) add('head', file, 0, '<html> static data-theme must be "matrix" (the theme-init default) or the first paint flashes');
    const themeErr = checkThemeInit(html);
    if (themeErr) add('head', file, 0, themeErr);
  }
};

/* CDN pinning + SRI */
const PINNED_RE = /(?:@|\/)v?\d+\.\d+\.\d+(?:[-+.][\w.]+)?(?:\/|$)/;   // x.y.z (optionally prerelease) followed by a path sep
function hostOf(url) { const m = /^(?:https?:)?\/\/([^/:?#]+)/.exec(url); return m ? m[1].toLowerCase() : null; }

RULES.cdn = () => {
  const targets = { ...Object.fromEntries(Object.entries(pages).map(([n, h]) => [`tools/${n}/index.html`, h])), 'index.html': hubHtml };
  for (const f of ['pages/donate.html', 'pages/privacy.html']) if (exists(path.join(ROOT, f))) targets[f] = read(path.join(ROOT, f));
  for (const f of glob('js/*.js')) targets[rel(f)] = read(f);

  for (const [file, src] of Object.entries(targets)) {
    // static tags
    const tagRe = /<(script|link)\b([^>]*)>/gi;
    let m;
    while ((m = tagRe.exec(src))) {
      const attrs = m[2];
      const urlM = /\b(?:src|href)="((?:https?:)?\/\/[^"]+)"/i.exec(attrs);
      if (!urlM) continue;
      if (m[1].toLowerCase() === 'link' && !/rel="(?:stylesheet|modulepreload|preload)"/i.test(attrs)) continue;
      const url = urlM[1], host = hostOf(url), line = lineOf(src, m.index);
      if (!host || !CDN_HOSTS.has(host)) continue;   // non-CDN hosts are the `hosts` rule's business
      if (!PINNED_RE.test(url)) add('cdn', file, line, `CDN URL is not pinned to an exact x.y.z version: ${url}`);
      if (!/\bintegrity="sha(?:256|384|512)-[A-Za-z0-9+/=]+"/.test(attrs)) add('cdn', file, line, `CDN <${m[1]}> has no integrity= (SRI): ${url}`);
      if (!/\bcrossorigin(?:="anonymous")?/.test(attrs)) add('cdn', file, line, `CDN <${m[1]}> has no crossorigin="anonymous" (SRI cannot verify without it): ${url}`);
    }
    // URLs built in JS (dynamic loaders, workers, import maps)
    const withoutTags = src.replace(/<(script|link)\b[^>]*>/gi, '');
    const strRe = /(['"`])((?:https?:)?\/\/(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)\/[^'"`\s]*)/g;
    const hasIntegrity = /\bintegrity\b|sha(?:256|384|512)/i.test(src);
    while ((m = strRe.exec(withoutTags))) {
      const url = m[2], line = lineOf(src, src.indexOf(url));
      if (/\$\{/.test(url) || /\/npm\/?$/.test(url)) continue;   // a base/template — the pieces are checked where they are assembled
      if (!PINNED_RE.test(url)) add('cdn', file, line, `CDN URL built in JS is not pinned to x.y.z: ${url}`);
      // a Worker script has no integrity option at all (pdf.js workerSrc) — pinning is the only control
      if (!hasIntegrity && !/\.worker\./.test(url)) add('cdn', file, line, `CDN URL loaded from JS in a file that never verifies integrity (no integrity=/sha256 anywhere): ${url}`);
    }
  }
};

/* innerHTML heuristic */
function learnEscapers(src) {
  const names = new Set(DEFAULT_ESCAPERS);
  const defRe = /(?:function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/g;
  let m;
  while ((m = defRe.exec(src))) {
    const body = src.slice(m.index, m.index + 400);
    if (/&lt;|replace\(\s*\/</.test(body) || (/\.textContent\s*=/.test(body) && /\.innerHTML\b/.test(body))) names.add(m[1] || m[2]);
  }
  return names;
}

/* ── a minimal JS literal-aware walker (strings, templates, regex literals, comments) ──
   Not a parser: enough to find where a statement ends and which `${…}` it contains
   without being fooled by a quote inside a regex (`replace(/"/g, '&quot;')`). */

/** i at an opening ' or " → index of the closing quote. */
function skipQuoted(src, i) {
  const q = src[i];
  for (i++; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === q || src[i] === '\n') break;
  }
  return i;
}
/** i at an opening / of a regex literal → index of the closing /. */
function skipRegex(src, i) {
  let cls = false;
  for (i++; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (cls) { if (c === ']') cls = false; continue; }
    if (c === '[') cls = true;
    else if (c === '/' || c === '\n') break;
  }
  return i;
}
/** i at an opening backtick → index of the closing backtick. Every `${expr}` met at any depth is
 *  pushed onto `out` (innermost first). */
function skipTemplate(src, i, out) {
  for (i++; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') return i;
    if (c === '$' && src[i + 1] === '{') {
      const end = skipCode(src, i + 2, '}', out);
      if (out) out.push(src.slice(i + 2, end));
      i = end;
    }
  }
  return i;
}
/** A char after which a `/` starts a regex literal rather than a division. */
const REGEX_PREV_RE = /[(,=:[!&|?{};+\-*%<>~^]/;
/** Walk code from i. `until` = the closing bracket that ends this region, or null for
 *  "end of statement" (`;`, an unmatched closer, or a newline that reads as a statement break).
 *  Returns the index of the terminator. Templates met on the way report their `${}` to `out`. */
function skipCode(src, i, until, out) {
  let depth = 0, prev = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipQuoted(src, i); prev = 'x'; continue; }
    if (c === '`') { i = skipTemplate(src, i, out); prev = 'x'; continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) return src.length; i = nl - 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '/' && (prev === '' || REGEX_PREV_RE.test(prev))) { i = skipRegex(src, i); prev = 'x'; continue; }
    if ('([{'.includes(c)) { depth++; prev = c; continue; }
    if (')]}'.includes(c)) { if (depth === 0) return i; depth--; prev = c; continue; }
    if (until === null && depth === 0) {
      if (c === ';') return i;
      if (c === '\n') {
        const next = src.slice(i + 1, i + 80).replace(/^\s+/, '');
        const continues = /[+\-*/%=?:&|,.<>!~^]$/.test(prev) || prev === ''            // line ends mid-expression
          || /^(?:[+?:.]|&&|\|\||\)|\]|\})/.test(next) || /^\/\//.test(next) || next === '';  // next line continues it
        if (!continues) return i;
        continue;
      }
    }
    if (!/\s/.test(c)) prev = c;
  }
  return i;
}

/** End of the JS statement that starts at `start`. */
function statementEnd(src, start) { return skipCode(src, start, null, null); }

/** All `${…}` expressions in `src` at every template depth, innermost-first. */
function interpolations(src) {
  const out = [];
  skipCode(src + '\n;', 0, null, out);
  return out;
}

/** Top-level `+` operands of a concatenation (strings, templates, regex literals respected). */
function plusOperands(expr) {
  const parts = []; let depth = 0, cur = 0, prev = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'") { i = skipQuoted(expr, i); prev = 'x'; continue; }
    if (c === '`') { i = skipTemplate(expr, i, null); prev = 'x'; continue; }
    if (c === '/' && (prev === '' || REGEX_PREV_RE.test(prev))) { i = skipRegex(expr, i); prev = 'x'; continue; }
    if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
    if (c === '+' && depth === 0 && expr[i + 1] !== '+' && expr[i - 1] !== '+') { parts.push(expr.slice(cur, i)); cur = i + 1; prev = c; continue; }
    if (!/\s/.test(c)) prev = c;
  }
  parts.push(expr.slice(cur));
  return parts.map(s => s.trim()).filter(Boolean);
}


function isSafeExpr(expr, escapers) {
  const e = expr.trim();
  if (!e) return true;
  if (/^(?:'[^']*'|"[^"]*")$/.test(e)) return true;                       // string literal
  if (/^`[^`]*`$/.test(e) && !/\$\{/.test(e)) return true;                // template without interpolation
  const escRe = new RegExp(`\\b(?:${[...escapers].map(n => n.replace(/\$/g, '\\$')).join('|')})\\s*\\(`);
  if (escRe.test(e) || SAFE_CALLS_RE.test(e)) return true;
  if (SAFE_INTERP_RES.some(re => re.test(e))) return true;
  if (HTML_CARRIER_RE.test(e)) return true;
  // A bare call — fmtUSD(x), infoRow(...), errorHtml(msg), renderText(t) — DELEGATES escaping to
  // the callee; only pass-through string methods (String(x), x.trim(), x.toUpperCase()) do not.
  if (/^[\w$.]+\s*\([\s\S]*\)(?:\s*\.join\([^)]*\))?$/.test(e) && !PASSTHROUGH_CALL_RE.test(e)) return true;
  return false;
}

RULES.innerhtml = () => {
  const targets = Object.fromEntries(Object.entries(pages).map(([n, h]) => [`tools/${n}/index.html`, h]));
  for (const f of glob('js/*.js')) targets[rel(f)] = read(f);
  targets['index.html'] = hubHtml;
  const sinkRe = /(?:\.(?:innerHTML|outerHTML)\s*(\+?=)(?!=)|\.insertAdjacentHTML\s*\(\s*['"][^'"]*['"]\s*,|document\.write(?:ln)?\s*\()/g;

  for (const [file, src] of Object.entries(targets)) {
    const escapers = learnEscapers(src);
    let m;
    while ((m = sinkRe.exec(src))) {
      const start = m.index + m[0].length;
      const end = statementEnd(src, start);
      const rhs = src.slice(start, end).trim();
      const line = lineOf(src, m.index);
      if (!rhs || /^(?:''|""|``)$/.test(rhs)) continue;
      const suspects = [];
      // 1. template interpolations at every depth
      for (const ip of interpolations(rhs)) {
        if (/`[^`]*\$\{/.test(ip)) continue;               // container of a nested template — its own ${} are checked
        if (!isSafeExpr(ip, escapers)) suspects.push('${' + ip.trim().replace(/\s+/g, ' ').slice(0, 60) + '}');
      }
      // 2. plain concatenation operands outside any template literal. An operand that CONTAINS
      //    a template (list.map(s => `<li>…</li>`).join('')) had its ${} checked in step 1.
      const stripped = rhs.replace(/`(?:\\.|[^`\\])*`/g, '``');
      //    A single bare operand (`el.innerHTML = msg;`) goes through the same test.
      for (const op of plusOperands(stripped)) if (!op.includes('``') && !isSafeExpr(op, escapers)) suspects.push(op.replace(/\s+/g, ' ').slice(0, 60));
      if (suspects.length) {
        const sink = m[0].replace(/\s+/g, '').replace(/\(.*$/, '(');
        add('innerhtml', file, line, `${sink} interpolates unescaped ${suspects.slice(0, 3).join(' , ')}${suspects.length > 3 ? ` (+${suspects.length - 3})` : ''}`);
      }
    }
  }
};

RULES.console = () => {
  const files = [...Object.keys(pages).map(n => path.join(ROOT, 'tools', n, 'index.html')), path.join(ROOT, 'index.html')];
  for (const g of SYNTAX_JS_GLOBS) if (!g.startsWith('scripts/')) files.push(...glob(g));   // scripts/ are CLIs: console.log IS their output
  for (const f of files) {
    const src = read(f);
    const re = /\bconsole\.log\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const before = src.slice(lineStart, m.index);
      if (/^\s*(?:\/\/|\*)/.test(before)) continue;   // commented out
      add('console', rel(f), lineOf(src, m.index), 'console.log() left in');
    }
  }
};

RULES.colours = () => {
  const targets = Object.fromEntries(Object.entries(pages).map(([n, h]) => [`tools/${n}/index.html`, h]));
  targets['index.html'] = hubHtml;
  for (const f of ['pages/donate.html', 'pages/privacy.html']) if (exists(path.join(ROOT, f))) targets[f] = read(path.join(ROOT, f));
  const hexRe = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b(?![\w-])/g;
  // custom properties the shared stylesheet defines — the theme contract
  const sharedVars = new Set([...read(path.join(ROOT, 'css', 'style.css')).matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));

  /** Scan one CSS text: hex literals (except as fallback of a DEFINED var) + var() of undefined names.
   *  `pageVars` = custom properties defined anywhere on the page (any <style>, any style="", or
   *  set from JS via style.setProperty('--x') — that last one is a runtime definition we accept). */
  function scanCss(file, css, baseIdx, src, where, pageVars) {
    const defined = v => sharedVars.has(v) || pageVars.has(v);
    let m;
    const fallbackRe = /var\(\s*(--[\w-]+)\s*,\s*([^)]*)\)/g;
    const fallbackHex = new Set();   // hex offsets that are the fallback of a DEFINED variable → dead code, not a leak
    while ((m = fallbackRe.exec(css))) {
      if (defined(m[1])) { let h; const hr = new RegExp(hexRe.source, 'g'); while ((h = hr.exec(m[2]))) fallbackHex.add(m.index + m[0].indexOf(m[2]) + h.index); }
    }
    while ((m = hexRe.exec(css))) {
      if (fallbackHex.has(m.index)) continue;
      const after = css.slice(m.index + m[0].length, m.index + m[0].length + 40);
      if (/^\s*[{,.>[]/.test(after)) continue;   // an id selector that happens to look like hex (#abc {)
      const propLine = css.slice(css.lastIndexOf('\n', m.index) + 1, css.indexOf('\n', m.index) < 0 ? undefined : css.indexOf('\n', m.index)).trim();
      add('colours', file, lineOf(src, baseIdx + m.index), `hardcoded ${m[0]} in ${where}: ${propLine.slice(0, 70)}`);
    }
    const varRe = /var\(\s*(--[\w-]+)/g;
    const seen = new Set();
    while ((m = varRe.exec(css))) {
      if (defined(m[1]) || seen.has(m[1])) continue;
      seen.add(m[1]);
      add('colours', file, lineOf(src, baseIdx + m.index), `var(${m[1]}) is defined neither in css/style.css nor on this page — the fallback (or nothing) renders in every theme`);
    }
  }

  for (const [file, src] of Object.entries(targets)) {
    const pageVars = new Set([
      ...[...src.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]),                          // any CSS definition on the page
      ...[...src.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)].map(m => m[1]),         // defined from JS at runtime
    ]);
    const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let s;
    while ((s = styleRe.exec(src))) {
      const css = s[1].replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length));
      scanCss(file, css, s.index + s[0].indexOf(s[1]), src, '<style>', pageVars);
    }
    const attrRe = /\sstyle="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(src))) scanCss(file, a[1], a.index + a[0].indexOf(a[1]), src, 'style="…"', pageVars);
  }
};

RULES.hosts = () => {
  const targets = Object.fromEntries(Object.entries(pages).map(([n, h]) => [`tools/${n}/index.html`, h]));
  targets['index.html'] = hubHtml;
  for (const f of ['pages/donate.html', 'pages/privacy.html']) if (exists(path.join(ROOT, f))) targets[f] = read(path.join(ROOT, f));
  for (const f of glob('js/*.js')) targets[rel(f)] = read(f);
  for (const n of Object.keys(pages)) { const sw = path.join(ROOT, 'tools', n, 'sw.js'); if (exists(sw)) targets[rel(sw)] = read(sw); }

  // resource LOADS only — an <a href> is content
  const loadRe = /(?:<(?:script|img|iframe|video|audio|source|embed|object|track)\b[^>]*\bsrc\s*=\s*["']|<link\b[^>]*\bhref\s*=\s*["']|\bfetch\s*\(\s*["'`]|new\s+(?:WebSocket|Worker|SharedWorker|EventSource|Image|Audio|XMLHttpRequest)\s*\(\s*["'`]|sendBeacon\s*\(\s*["'`]|importScripts\s*\(\s*["'`]|\bimport\s*\(\s*["'`]|\.(?:src|href|action)\s*=\s*["'`]|\.open\s*\(\s*["'](?:GET|POST|PUT|DELETE|HEAD)["']\s*,\s*["'`]|\burl\(\s*["']?|@import\s+(?:url\(\s*)?["'])\s*((?:https?:|wss?:)?\/\/[a-zA-Z0-9.-]+)/g;

  for (const [file, src] of Object.entries(targets)) {
    const allow = new Set([...OPERATOR_HOSTS, ...CDN_HOSTS, ...(FILE_HOST_ALLOW[file] || [])]);
    let m;
    while ((m = loadRe.exec(src))) {
      const host = hostOf(m[1]);
      if (!host || allow.has(host)) continue;
      if (host.endsWith('.w3.org') || host === 'schema.org' || host === 'www.w3.org') continue;   // namespaces, never fetched
      add('hosts', file, lineOf(src, m.index), `loads from a host that is not the operator's, a pinned CDN, or allow-listed for this file: ${host}`);
    }
    // trackers and GA IDs, wherever they appear
    const fileAllow = new Set(FILE_HOST_ALLOW[file] || []);
    while ((m = TRACKER_HOST_RE.exec(src))) {
      if (fileAllow.has(m[0].toLowerCase()) || [...fileAllow].some(h => m[0].toLowerCase().endsWith(h))) continue;
      add('hosts', file, lineOf(src, m.index), `third-party analytics/tracker host referenced: ${m[0]}`);
    }
    if (file !== 'js/common.js' && file !== 'js/config.js') {
      while ((m = GA_ID_RE.exec(src))) add('hosts', file, lineOf(src, m.index), `Google Analytics measurement ID literal outside js/common.js: ${m[0]}`);
    }
  }
};

RULES.syntax = () => {
  // node --check on real JS files
  for (const g of SYNTAX_JS_GLOBS) for (const f of glob(g)) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) add('syntax', rel(f), 0, `node --check failed: ${(r.stderr || '').split('\n').find(l => /Error/.test(l)) || r.stderr.trim().slice(0, 120)}`);
  }
  // inline scripts + ld+json in every page
  const targets = Object.fromEntries(Object.entries(pages).map(([n, h]) => [`tools/${n}/index.html`, h]));
  targets['index.html'] = hubHtml;
  for (const f of ['pages/donate.html', 'pages/privacy.html']) if (exists(path.join(ROOT, f))) targets[f] = read(path.join(ROOT, f));
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const [file, src] of Object.entries(targets)) {
    let m;
    while ((m = scriptRe.exec(src))) {
      const attrs = m[1], body = m[2], line = lineOf(src, m.index);
      if (/\bsrc\s*=/.test(attrs)) continue;
      const type = (/\btype\s*=\s*["']([^"']+)["']/.exec(attrs) || [, 'text/javascript'])[1].toLowerCase();
      if (type === 'application/ld+json') {
        try { JSON.parse(body); } catch (e) { add('syntax', file, line, `ld+json does not parse: ${e.message.slice(0, 80)}`); }
        continue;
      }
      if (!/javascript|ecmascript|module/.test(type) && type !== 'text/javascript') continue;   // templates etc.
      if (type === 'module') {
        // vm.Script cannot take import/export; a rough check by stripping them keeps the rest covered
        try { new vm.Script(body.replace(/^\s*(?:import|export)\b.*$/gm, ''), { filename: file }); }
        catch (e) { add('syntax', file, line, `inline module script: ${e.message.slice(0, 100)}`); }
        continue;
      }
      try { new vm.Script(body, { filename: file }); }
      catch (e) { add('syntax', file, line, `inline <script> does not compile: ${e.message.slice(0, 100)}`); }
    }
  }
};

RULES.sitemap = () => {
  const urls = parseSitemap(sitemapXml);
  const today = new Date().toISOString().slice(0, 10);
  const locs = new Set(urls.map(u => u.loc));
  for (const p of [`${SITE}/`, `${SITE}/pages/donate/`, `${SITE}/pages/privacy/`]) if (!locs.has(p)) add('sitemap', 'sitemap.xml', 0, `missing ${p}`);
  for (const u of urls) {
    if (!u.loc.startsWith(SITE + '/')) add('sitemap', 'sitemap.xml', u.line, `URL is not under ${SITE}: ${u.loc}`);
    if (u.lastmod && !/^\d{4}-\d{2}-\d{2}(?:T[\d:+\-Z.]+)?$/.test(u.lastmod)) add('sitemap', 'sitemap.xml', u.line, `lastmod is not a W3C date: ${u.lastmod}`);
    else if (u.lastmod && u.lastmod.slice(0, 10) > today) add('sitemap', 'sitemap.xml', u.line, `lastmod is in the future: ${u.lastmod}`);
  }
};

/* ───────────────────────────────── run ──────────────────────────────────── */

const ruleNames = Object.keys(RULES);
const selected = opt.only.length ? opt.only : ruleNames;
for (const r of selected) {
  if (!RULES[r]) { console.error(`unknown rule "${r}" (have: ${ruleNames.join(', ')})`); process.exit(2); }
  try { RULES[r](); }
  catch (e) { console.error(`checker error in rule "${r}": ${e.stack}`); process.exit(2); }
}

/* baseline */
let baseline = {};
if (exists(BASELINE_FILE)) {
  try { baseline = JSON.parse(read(BASELINE_FILE)); }
  catch (e) { console.error(`cannot parse ${rel(BASELINE_FILE)}: ${e.message}`); process.exit(2); }
}
const current = {};
for (const f of findings) { const k = fingerprint(f); current[k] = (current[k] || 0) + 1; }

if (opt.update) {
  const scoped = opt.only.length ? { ...baseline } : {};
  if (opt.only.length) for (const k of Object.keys(scoped)) if (opt.only.includes(k.split('|')[0])) delete scoped[k];
  const next = Object.fromEntries(Object.entries({ ...scoped, ...current }).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 1) + '\n');
  console.log(`baseline written: ${Object.values(next).reduce((a, b) => a + b, 0)} accepted finding(s) in ${Object.keys(next).length} fingerprint(s) → ${rel(BASELINE_FILE)}`);
  baseline = next;   // classify this run against what was just accepted
}

// classify each finding as new or baselined (per fingerprint, in order)
const seen = {};
const fresh = [], old = [];
for (const f of findings) {
  const k = fingerprint(f);
  seen[k] = (seen[k] || 0) + 1;
  (!opt.strict && seen[k] <= (baseline[k] || 0) ? old : fresh).push(f);
}
// baseline entries no longer observed (or observed fewer times) → stale
const stale = Object.entries(baseline)
  .filter(([k]) => !opt.only.length || opt.only.includes(k.split('|')[0]))
  .filter(([k, n]) => (current[k] || 0) < n)
  .map(([k, n]) => ({ key: k, expected: n, got: current[k] || 0 }));

/* report */
if (opt.json) {
  console.log(JSON.stringify({ new: fresh, baselined: old.length, stale, rules: selected, tools: Object.keys(pages).length }, null, 2));
} else {
  const sortF = (a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line;
  const show = (list, label) => {
    if (!list.length) return;
    console.log(`\n── ${label} (${list.length}) ──`);
    for (const f of [...list].sort(sortF)) console.log(`${f.rule.padEnd(9)} ${f.file}${f.line ? ':' + f.line : ''}  ${f.msg}`);
  };
  show(fresh, opt.strict ? 'FINDINGS (--strict: baseline ignored)' : 'NEW findings — not in baseline');
  if (opt.verbose) show(old, 'baselined (pre-existing debt)');

  console.log(`\n── summary — ${Object.keys(pages).length} tool pages, rules: ${selected.join(', ')} ──`);
  console.log('rule       new  debt  total');
  for (const r of selected) {
    const n = fresh.filter(f => f.rule === r).length, o = old.filter(f => f.rule === r).length;
    console.log(`${r.padEnd(9)} ${String(n).padStart(4)} ${String(o).padStart(5)} ${String(n + o).padStart(6)}`);
  }
  if (stale.length) {
    console.log(`\n${stale.length} baseline entr${stale.length === 1 ? 'y is' : 'ies are'} stale (finding fixed or reworded) — run with --update-baseline to ratchet the debt down:`);
    for (const s of stale.slice(0, 10)) console.log(`   ${s.key.slice(0, 110)}  (baseline ${s.expected}, now ${s.got})`);
    if (stale.length > 10) console.log(`   … +${stale.length - 10} more`);
  }
  if (fresh.length) console.log(`\nFAIL — ${fresh.length} finding(s)${opt.strict ? '' : ' not covered by the baseline'}. Fix them, or accept them deliberately with --update-baseline.`);
  else console.log(`\nPASS — no new findings${old.length ? ` (${old.length} pre-existing in baseline; --verbose lists them, --strict fails on them)` : ''}.`);
}
process.exit(fresh.length ? 1 : 0);
