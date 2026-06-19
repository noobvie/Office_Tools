/* ============================================================
   Office Tools — Shared JS
   ============================================================ */

/* Capture script URL before any async code (document.currentScript is only live here) */
const _OT_SCRIPT_SRC = document.currentScript?.src || '';

/* ---------- Google Analytics 4 (centralised — loads on every page) ----------
   The authoritative ID lives HERE, not in config.js, because common.js is the
   only script loaded on EVERY page — many client-only tools (password generator,
   games, etc.) don't load config.js at all. config.js may optionally override or
   disable it (set GA_MEASUREMENT_ID to '' there). Skipped on localhost so dev
   traffic never pollutes the report. */
const OT_GA_ID = 'G-4YG2V55YEY';
(function loadGA() {
  var id = OT_GA_ID;
  if (window.OT_CONFIG && typeof window.OT_CONFIG.GA_MEASUREMENT_ID === 'string') {
    id = window.OT_CONFIG.GA_MEASUREMENT_ID;   // optional override / disable
  }
  var host = location.hostname;
  if (!id) return;
  if (host === 'localhost' || host === '127.0.0.1' || host === '' || location.protocol === 'file:') return;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', id);

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
  document.head.appendChild(s);
})();

/* ---------- Theme ---------- */
const OT_THEMES  = ['light', 'dark', 'matrix', 'anime'];
const OT_LABELS  = { light: '🌙 Dark', dark: '💻 Matrix', matrix: '🌸 Anime', anime: '☀️ Light' };

(function () {
  const saved = localStorage.getItem('ot-theme') || 'matrix';
  const valid = OT_THEMES.includes(saved) ? saved : 'matrix';
  document.documentElement.setAttribute('data-theme', valid);
})();

function initThemeToggle(btnId = 'themeToggle') {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  function update() {
    const current = document.documentElement.getAttribute('data-theme');
    const label = OT_LABELS[current] || '🌙 Dark';
    const sp  = label.indexOf(' ');
    const ico = sp >= 0 ? label.slice(0, sp) : label;
    const txt = sp >= 0 ? label.slice(sp + 1) : '';
    // Emoji + label as separate spans so the label can be hidden on mobile (icon-only circle)
    btn.innerHTML = `<span class="btn-ico">${ico}</span><span class="btn-label">${escHtml(txt)}</span>`;
  }
  update();
  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const idx  = OT_THEMES.indexOf(current);
    const next = OT_THEMES[(idx + 1) % OT_THEMES.length];
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('ot-theme', next); } catch(e) {}
    update();
  });
}

/* ---------- Copy to clipboard (with iOS execCommand fallback) ---------- */
function copyText(text, btn) {
  function flash() {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1800);
  }
  function fallback() {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      flash();
    } catch(e) {}
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(flash).catch(fallback);
  } else {
    fallback();
  }
}

function makeCopyBtn(containerSelector) {
  document.querySelectorAll(containerSelector + ' .copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.closest('.result-box') || document.getElementById(btn.dataset.target);
      const text = target ? (target.value || target.textContent) : '';
      copyText(text.trim(), btn);
    });
  });
}

/* ---------- Tabs ---------- */
function initTabs(containerSelector = '.tabs') {
  document.querySelectorAll(containerSelector).forEach(tabs => {
    tabs.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.closest('[data-tabs]') || btn.closest('.card') || document;
        group.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        group.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const pane = document.getElementById(btn.dataset.tab);
        if (pane) pane.classList.add('active');
      });
    });
  });
}

/* ---------- Format numbers ---------- */
function fmt(n) { return Number(n).toLocaleString(); }

/* ---------- Escape HTML ---------- */
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ---------- Header Search (tool pages) ---------- */
function initHeaderSearch() {
  const header = document.querySelector('.site-header');
  if (!header) return;

  const root = _otRootPath();
  const currentPath = window.location.pathname.match(/\/tools\/([^\/]+)/)?.[1] || null;

  // Two cases:
  //  • A search box is already in the markup (e.g. the homepage) — just bolt the
  //    quick-pick dropdown onto it so mobile users can tap a tool directly.
  //  • No search box (tool pages) — build the whole thing, but only on tool pages.
  let wrap = header.querySelector('.header-search-wrap');
  if (wrap) {
    if (wrap.querySelector('.header-search-drop')) return; // already wired
  } else {
    if (!currentPath) return;
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
    wrap = document.createElement('div');
    wrap.className = 'header-search-wrap';
    wrap.innerHTML = `<input type="text" id="headerSearch" placeholder="Search tools…" autocomplete="off" aria-label="Search tools"><span class="hs-kbd" id="hsKbd"><kbd>Ctrl</kbd><kbd>K</kbd></span><span class="header-search-icon">${SVG}</span>`;
    // Replace .header-tool-name if it exists, otherwise insert before .header-actions
    const toolNameEl = header.querySelector('.header-tool-name');
    if (toolNameEl) {
      toolNameEl.replaceWith(wrap);
    } else {
      const actions = header.querySelector('.header-actions');
      header.insertBefore(wrap, actions || null);
    }
  }

  const input = wrap.querySelector('input');
  if (!input) return;

  // Ensure a dropdown container exists (built-in wrap doesn't ship one)
  let drop = wrap.querySelector('.header-search-drop');
  if (!drop) {
    drop = document.createElement('div');
    drop.className = 'header-search-drop';
    drop.id = 'headerSearchDrop';
    drop.hidden = true;
    wrap.appendChild(drop);
  }

  const kbd  = wrap.querySelector('.hs-kbd');   // null on the homepage wrap
  const icon = wrap.querySelector('.header-search-icon');
  let activeIdx = -1;

  function showKbd() {
    if (!kbd) return;
    kbd.style.display  = 'flex';
    if (icon) icon.style.display = 'none';
    input.style.paddingRight = '5rem';
  }
  function hideKbd() {
    if (!kbd) return;
    kbd.style.display  = 'none';
    if (icon) icon.style.display = 'flex';
    input.style.paddingRight = '';
  }
  showKbd();

  function dropItems() { return [...drop.querySelectorAll('.hsd-item')]; }

  function highlight(idx) {
    dropItems().forEach((el, i) => el.classList.toggle('hsd-active', i === idx));
    activeIdx = idx;
  }

  function openDrop(q) {
    const query = (q || '').toLowerCase().trim();
    const pool = query
      ? OT_TOOLS.filter(t => t.name.toLowerCase().includes(query) || t.desc.toLowerCase().includes(query) || t.cat.toLowerCase().includes(query))
      : OT_TOOLS.filter(t => t.path !== currentPath).slice(0, 8);

    if (!pool.length) {
      drop.innerHTML = '<div class="hsd-empty">No tools found</div>';
    } else {
      drop.innerHTML = pool.slice(0, 8).map(t =>
        `<a class="hsd-item${t.path === currentPath ? ' hsd-current' : ''}" href="${root}tools/${t.path}/">` +
        `<span class="hsd-icon">${t.icon}</span>` +
        `<span class="hsd-name">${escHtml(t.name)}</span>` +
        `<span class="hsd-cat">${escHtml(t.cat.replace(/^\S+\s/, ''))}</span></a>`
      ).join('');
    }
    drop.hidden = false;
    activeIdx = -1;
  }

  function closeDrop() { drop.hidden = true; activeIdx = -1; }

  input.addEventListener('focus', () => { hideKbd(); openDrop(input.value); });
  input.addEventListener('blur',  () => { if (!input.value) showKbd(); });
  input.addEventListener('input', () => { openDrop(input.value); highlight(-1); });
  input.addEventListener('keydown', e => {
    const els = dropItems();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(activeIdx + 1, els.length - 1);
      highlight(next);
      els[next]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = Math.max(activeIdx - 1, 0);
      highlight(prev);
      els[prev]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      els[activeIdx]?.click();
    } else if (e.key === 'Escape') {
      closeDrop();
      input.blur();
    }
  });
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) closeDrop(); });
}

/* ---------- Tool Sidebar ---------- */
const OT_TOOLS = [
  // ⏱️ Productivity & Time
  { name: 'Pomodoro Timer',          path: 'pomodoro',              cat: '⏱️ Productivity & Time', icon: '🍅', desc: '25-min focus timer with short and long break intervals' },
  { name: 'Date & Time Calculator',  path: 'date-calculator',       cat: '⏱️ Productivity & Time', icon: '📅', desc: 'Date difference, age, countdown and time unit converter' },
  { name: 'World Calendar',          path: 'calendar',              cat: '⏱️ Productivity & Time', icon: '🗓️', desc: 'Gregorian, Chinese Lunar and Islamic Hijri calendar' },
  { name: 'Stopwatch & Timer',       path: 'timer',                 cat: '⏱️ Productivity & Time', icon: '⏱️', desc: 'Precise stopwatch with lap times and countdown timer' },
  { name: 'Time Zone Converter',     path: 'timezone',              cat: '⏱️ Productivity & Time', icon: '🌐', desc: 'Convert times between any two time zones' },
  { name: 'Work Hours & Timesheet',  path: 'timesheet-calculator',  cat: '⏱️ Productivity & Time', icon: '⏲️', desc: 'Weekly hours from clock in/out and breaks, with overtime and pay',    isNew: true },
  // ✨ Generators
  { name: 'Password Generator',      path: 'password-generator',    cat: '✨ Generators',           icon: '🔑', desc: 'Generate secure random passwords with custom options' },
  { name: 'QR & Barcode Generator',  path: 'qr-generator',          cat: '✨ Generators',           icon: '📱', desc: 'Generate QR codes with logo or barcodes — URL, WiFi, vCard' },
  { name: 'UUID Generator',          path: 'uuid-generator',        cat: '✨ Generators',           icon: '🆔', desc: 'Generate UUID v4 and v7 identifiers, single or bulk' },
  { name: 'Random Number Generator', path: 'random-number',         cat: '✨ Generators',           icon: '🎲', desc: 'Generate random integers or decimals in any range' },
  { name: 'Lorem Ipsum Generator',   path: 'lorem-ipsum',           cat: '✨ Generators',           icon: '📄', desc: 'Generate placeholder text by paragraphs, sentences or words' },
  { name: 'Fake Data Generator',     path: 'fake-data',             cat: '✨ Generators',           icon: '🃏', desc: 'Generate realistic test data — names, emails, addresses' },
  { name: 'Wheel of Names',          path: 'wheel-of-names',        cat: '✨ Generators',           icon: '🎡', desc: 'Spin a wheel to randomly pick a winner from your list' },
  { name: 'Barcode Generator',       path: 'barcode-generator',     cat: '✨ Generators',           icon: '📊', desc: 'Code 128, EAN-13, UPC-A, Code 39 and ITF — download PNG or SVG',       isNew: true },
  // 📝 Text & Content
  { name: 'Word Counter',            path: 'word-counter',          cat: '📝 Text & Content',       icon: '📊', desc: 'Count words, characters, sentences and reading time live' },
  { name: 'Markdown Editor',         path: 'markdown-editor',       cat: '📝 Text & Content',       icon: '✍️', desc: 'Live split-pane Markdown editor with HTML preview' },
  { name: 'Text Diff',               path: 'text-diff',             cat: '📝 Text & Content',       icon: '🔀', desc: 'Side-by-side diff with color-highlighted additions and deletions' },
  { name: 'Typing Speed Test',       path: 'typing-speed',          cat: '📝 Text & Content',       icon: '⌨️', desc: 'Measure WPM and accuracy with real-time error tracking' },
  { name: 'Text Case Converter',     path: 'text-case',             cat: '📝 Text & Content',       icon: '🔡', desc: 'Convert to UPPERCASE, camelCase, snake_case, kebab-case and more' },
  { name: 'Notepad',                 path: 'notepad',               cat: '📝 Text & Content',       icon: '📝', desc: 'Auto-saving scratch pad with up to 5 named notes' },
  { name: 'Remove Duplicate Lines & Sort', path: 'dedupe-sort',     cat: '📝 Text & Content',       icon: '🧹', desc: 'Dedupe, sort, trim, change case, reverse and shuffle text lines',     isNew: true },
  { name: 'Markdown ↔ HTML Converter', path: 'markdown-html',       cat: '📝 Text & Content',       icon: '📝', desc: 'Two-way Markdown and HTML conversion with a live preview',             isNew: true },
  // 🔒 Encoding & Crypto
  { name: 'Base64 Converter',        path: 'base64-converter',      cat: '🔒 Encoding & Crypto',    icon: '🔄', desc: 'Encode and decode text or files to/from Base64' },
  { name: 'URL Encoder / Decoder',   path: 'url-encoder',           cat: '🔒 Encoding & Crypto',    icon: '🔗', desc: 'Percent-encode and decode URLs with before/after diff' },
  { name: 'Unix Timestamp',          path: 'unix-timestamp',        cat: '🔒 Encoding & Crypto',    icon: '🕐', desc: 'Convert Unix timestamps to dates and vice versa' },
  { name: 'Hash Generator',          path: 'hash-generator',        cat: '🔒 Encoding & Crypto',    icon: '🔑', desc: 'Generate SHA-256, SHA-512 and HMAC hashes from text or files' },
  { name: 'HTML Entity Encoder',     path: 'html-entities',         cat: '🔒 Encoding & Crypto',    icon: '🏷️', desc: 'Encode and decode HTML entities for safe HTML output' },
  { name: 'JWT Decoder',             path: 'jwt-decoder',           cat: '🔒 Encoding & Crypto',    icon: '🔐', desc: 'Decode JSON Web Tokens — header, payload, expiry and claims' },
  { name: 'Number Base Converter',   path: 'base-converter',        cat: '🔒 Encoding & Crypto',    icon: '🔢', desc: 'Convert between binary, octal, decimal and hexadecimal' },
  { name: 'Binary ↔ Text Converter', path: 'binary-text',           cat: '🔒 Encoding & Crypto',    icon: '0️⃣', desc: 'Text to binary and back, with hex and decimal views (UTF-8)',          isNew: true },
  { name: 'Morse Code Translator',   path: 'morse-code',            cat: '🔒 Encoding & Crypto',    icon: '📡', desc: 'Text ↔ Morse with audio beeps, visual flash and adjustable WPM',       isNew: true },
  { name: 'ROT13 & Caesar Cipher',   path: 'caesar-cipher',         cat: '🔒 Encoding & Crypto',    icon: '🔐', desc: 'Encode/decode ROT13 and Caesar shifts, with brute-force cracking',     isNew: true },
  // 🧮 Calculators
  { name: 'Percentage Calculator',   path: 'percentage-calculator', cat: '🧮 Calculators',          icon: '💯', desc: 'Calculate percentages, percent of, and percentage change' },
  { name: 'Aspect Ratio Calculator', path: 'aspect-ratio',          cat: '🧮 Calculators',          icon: '📐', desc: 'Find missing width or height for any aspect ratio' },
  { name: 'Unit Converter',          path: 'unit-converter',        cat: '🧮 Calculators',          icon: '📐', desc: 'Convert length, weight, temperature, volume and more' },
  { name: 'Loan Calculator',         path: 'loan-calculator',       cat: '🧮 Calculators',          icon: '🏦', desc: 'Monthly payment and amortization schedule for any loan' },
  { name: 'Tip Calculator',          path: 'tip-calculator',        cat: '🧮 Calculators',          icon: '🧾', desc: 'Calculate tip and split the bill among friends' },
  { name: 'Number to Words',         path: 'number-words',          cat: '🧮 Calculators',          icon: '🔤', desc: 'Convert numbers to English words for checks and invoices' },
  { name: 'BMI Calculator',          path: 'bmi-calculator',        cat: '🧮 Calculators',          icon: '⚖️', desc: 'Body Mass Index in metric or imperial with healthy weight range' },
  { name: 'Age Calculator',          path: 'age-calculator',        cat: '🧮 Calculators',          icon: '🎂', desc: 'Exact age in years, months and days, plus next-birthday countdown' },
  { name: 'Sales Tax & VAT Calculator', path: 'tax-calculator',     cat: '🧮 Calculators',          icon: '🧾', desc: 'Add tax to a net price or remove VAT from a gross total',            isNew: true },
  { name: 'Discount Calculator',     path: 'discount-calculator',   cat: '🧮 Calculators',          icon: '🏷️', desc: 'Sale price, savings and stacked percent-off discounts',               isNew: true },
  { name: 'Compound Interest Calculator', path: 'compound-interest', cat: '🧮 Calculators',         icon: '📈', desc: 'Project savings growth with contributions and a yearly chart',         isNew: true },
  { name: 'Scientific Calculator',   path: 'scientific-calculator', cat: '🧮 Calculators',          icon: '🔬', desc: 'Trig, logs, powers, roots, factorial and memory — deg or rad',         isNew: true },
  { name: 'Roman Numeral Converter', path: 'roman-numerals',        cat: '🧮 Calculators',          icon: '🏛️', desc: 'Convert numbers to Roman numerals and back, both directions',          isNew: true },
  { name: 'Watts / Volts / Amps Calculator', path: 'electrical-calculator', cat: '🧮 Calculators',   icon: '⚡', desc: "Ohm's Law — enter any two of watts, volts, amps, ohms; get the rest",     isNew: true },
  { name: 'Clothing & Shoe Size Converter', path: 'clothing-size',     cat: '🧮 Calculators',          icon: '👕', desc: 'Convert clothing and shoe sizes between US, UK and EU',                isNew: true },
  { name: 'Resistor Color Code Calculator', path: 'resistor-calculator', cat: '🧮 Calculators',        icon: '🎨', desc: '4/5/6-band resistor colors to resistance and back',                    isNew: true },
  { name: 'Recipe & Cooking Converter', path: 'recipe-converter',      cat: '🧮 Calculators',          icon: '🍳', desc: 'Cups, grams, ounces, tbsp and ml per ingredient, plus a recipe scaler', isNew: true },
  { name: 'Wire Gauge Calculator',   path: 'wire-gauge',            cat: '🧮 Calculators',          icon: '🔌', desc: 'AWG to mm, mm² and ampacity, or find the gauge for a given current',  isNew: true },
  { name: 'Fuel & Trip Cost Calculator', path: 'fuel-cost',         cat: '🧮 Calculators',          icon: '⛽', desc: 'Trip fuel cost from distance, economy and price — mpg or L/100km',     isNew: true },
  { name: 'TDEE & Calorie Calculator', path: 'tdee-calculator',     cat: '🧮 Calculators',          icon: '🔥', desc: 'BMR and daily maintenance calories with weight-goal targets',          isNew: true },
  // 💻 Development
  { name: 'JSON Editor',             path: 'json-editor',           cat: '💻 Development',          icon: '📋', desc: 'Validate, format and minify JSON with interactive tree view' },
  { name: 'CSV ↔ JSON',              path: 'csv-json',              cat: '💻 Development',          icon: '⇄',  desc: 'Convert between CSV and JSON with table preview' },
  { name: 'Crontab Explainer',       path: 'crontab',               cat: '💻 Development',          icon: '⏰', desc: 'Parse cron expressions into plain English with next run times' },
  { name: 'Regex Tester',            path: 'regex-tester',          cat: '💻 Development',          icon: '🔍', desc: 'Test regular expressions with live match highlighting' },
  { name: 'SQL Formatter',           path: 'sql-formatter',         cat: '💻 Development',          icon: '🗄️', desc: 'Beautify and minify SQL queries with configurable indent' },
  { name: 'File Compressor',         path: 'file-compressor',       cat: '💻 Development',          icon: '🗜️', desc: 'Create or extract ZIP archives entirely in your browser' },
  { name: 'AI Token Counter',        path: 'ai-token-counter',      cat: '💻 Development',          icon: '🔢', desc: 'Estimate token count and API cost for GPT-4, Claude and more' },
  { name: 'Prompt Template Builder', path: 'ai-prompt-template',    cat: '💻 Development',          icon: '📝', desc: 'Write reusable AI prompts with {{variable}} placeholders' },
  { name: 'JSON Schema Builder',     path: 'ai-json-schema',        cat: '💻 Development',          icon: '🏗️', desc: 'Auto-generate JSON Schema from any JSON or build visually' },
  { name: 'Code Beautifier & Minifier', path: 'code-beautifier',    cat: '💻 Development',          icon: '💅', desc: 'Beautify or minify HTML, CSS and JavaScript with byte comparison',    isNew: true },
  { name: 'JSON ↔ YAML Converter',   path: 'json-yaml',             cat: '💻 Development',          icon: '🔁', desc: 'Two-way JSON and YAML conversion with live validation',               isNew: true },
  { name: 'XML Formatter',           path: 'xml-formatter',         cat: '💻 Development',          icon: '📐', desc: 'Pretty-print, minify and validate XML with configurable indent',      isNew: true },
  { name: 'CSS Gradient Generator',  path: 'gradient-generator',    cat: '💻 Development',          icon: '🌈', desc: 'Build linear and radial CSS gradients visually and copy the CSS',     isNew: true },
  { name: 'Meta Tag Generator',      path: 'meta-tag-generator',    cat: '💻 Development',          icon: '🏷️', desc: 'SEO meta tags with a live Google preview and copy-ready HTML',         isNew: true },
  { name: 'Open Graph & Twitter Card', path: 'og-generator',        cat: '💻 Development',          icon: '🔗', desc: 'OG + Twitter Card tags with a live social share preview',              isNew: true },
  { name: 'Robots.txt Generator',    path: 'robots-generator',      cat: '💻 Development',          icon: '🤖', desc: 'Allow/disallow rules per user-agent, crawl-delay and sitemap line',   isNew: true },
  { name: 'Schema.org JSON-LD Generator', path: 'schema-generator', cat: '💻 Development',          icon: '🏗️', desc: 'Structured data for rich results — Article, Product, FAQ and more',    isNew: true },
  { name: 'URL Slug Generator',      path: 'slug-generator',        cat: '💻 Development',          icon: '🔗', desc: 'Turn titles into clean SEO-friendly URL slugs, single or bulk',       isNew: true },
  { name: 'Favicon Generator',       path: 'favicon-generator',     cat: '💻 Development',          icon: '⭐', desc: 'Favicons from image, emoji or initials — multi-size PNG + HTML',       isNew: true },
  // 🎬 Media
  { name: 'YouTube Downloader',      path: 'yt-downloader',         cat: '🎬 Media',                icon: '📥', desc: 'Download YouTube videos as MP4 or audio as MP3' },
  { name: 'Speech & Voice',          path: 'speech-voice',          cat: '🎬 Media',                icon: '🎙️', desc: 'Transcribe mic or audio to text, or convert text to speech' },
  { name: 'Photo Editor',            path: 'photo-editor',          cat: '🎬 Media',                icon: '🖼️', desc: 'Remove backgrounds, adjust colors and add text to photos' },
  { name: 'Image Converter',         path: 'image-converter',       cat: '🎬 Media',                icon: '🖼️', desc: 'Convert HEIC/HEIF to JPG/PNG, compress and resize images' },
  { name: 'Image to Text (OCR)',     path: 'ocr',                   cat: '🎬 Media',                icon: '🔎', desc: 'Extract text from photos, screenshots and scans — 10+ languages' },
  { name: 'Image Cropper',           path: 'image-cropper',         cat: '🎬 Media',                icon: '✂️', desc: 'Crop photos with aspect presets, rotate, flip and zoom' },
  { name: 'Image Upscaler',          path: 'image-upscale',         cat: '🎬 Media',                icon: '🔬', desc: 'Enlarge images 2×/3×/4× with high-quality resampling, sharpen and denoise',  isNew: true },
  { name: 'Image Redaction',         path: 'image-redact',          cat: '🎬 Media',                icon: '🚫', desc: 'Blur, pixelate or black-box sensitive areas; flattened and EXIF stripped',  isNew: true },
  { name: 'Collage & Grid Maker',    path: 'image-collage',         cat: '🎬 Media',                icon: '🧩', desc: 'Combine photos into one grid collage — columns, spacing, background, corners',  isNew: true },
  { name: 'SVG to PNG',              path: 'svg-to-png',            cat: '🎬 Media',                icon: '🖌️', desc: 'Rasterize SVG to PNG/JPG/WebP at any scale, with background options',  isNew: true },
  { name: 'Screenshot Beautifier',   path: 'screenshot-beautifier', cat: '🎬 Media',                icon: '🖼️', desc: 'Add gradient backgrounds and shadows to screenshots' },
  { name: 'Color Picker / Eyedropper', path: 'color-picker',        cat: '🎬 Media',                icon: '🎨', desc: 'Pick HEX/RGB/HSL colors from any image with a magnified loupe',       isNew: true },
  { name: 'EXIF Viewer & Remover',   path: 'exif-viewer',           cat: '🎬 Media',                icon: '📷', desc: 'View photo metadata and GPS, then download a stripped clean copy',     isNew: true },
  // 🎨 Design
  { name: 'Color Converter',         path: 'color-converter',       cat: '🎨 Design',               icon: '🎨', desc: 'Convert HEX, RGB, HSL, HSV and CMYK with live preview' },
  { name: 'Contrast Checker',        path: 'contrast-checker',      cat: '🎨 Design',               icon: '♿', desc: 'Check WCAG AA/AAA contrast ratios for color pairs' },
  { name: 'Palette Extractor',       path: 'palette-extractor',     cat: '🎨 Design',               icon: '🎨', desc: 'Extract dominant color palette from any image' },
  { name: 'Character Map',           path: 'char-map',              cat: '🎨 Design',               icon: '🔣', desc: 'Browse and copy special characters, symbols and emoji' },
  // 🌐 Network & Web
  { name: 'Currency Converter',      path: 'currency',              cat: '🌐 Network & Web',        icon: '💱', desc: 'Convert 40+ fiat currencies and crypto with live rates' },
  { name: 'What Is My IP?',          path: 'my-ip',                 cat: '🌐 Network & Web',        icon: '🌐', desc: 'Show your public IP, ISP, country and IPv6 status' },
  { name: 'VPN / IP Leak Test',      path: 'vpn-leak-test',         cat: '🌐 Network & Web',        icon: '🛡️', desc: 'WebRTC + IPv6 leak check — is your VPN hiding your real IP?',  isNew: true },
  { name: 'IP Location Lookup',      path: 'ip-location',           cat: '🌐 Network & Web',        icon: '📍', desc: 'Country, city, ISP, ASN and map for any IP or domain' },
  { name: 'Campaign URL Builder',    path: 'utm-builder',           cat: '🌐 Network & Web',        icon: '📎', desc: 'Build UTM-tagged URLs for Google Analytics tracking' },
  { name: 'CSR Decoder',             path: 'csr-decoder',           cat: '🌐 Network & Web',        icon: '🔐', desc: 'Decode a CSR — subject, key size, SANs, fingerprints' },
  { name: 'Port Checker',            path: 'port-checker',          cat: '🌐 Network & Web',        icon: '🔌', desc: 'Check if TCP ports are open on any host — IPv4 and IPv6' },
  { name: 'Domain Checker',          path: 'domain-checker',        cat: '🌐 Network & Web',        icon: '🌐', desc: 'WHOIS, RDAP, DNS records and availability across TLDs' },
  { name: 'Online Ping Test',        path: 'ping',                  cat: '🌐 Network & Web',        icon: '📡', desc: 'Ping any host with live output — IPv4 and IPv6 supported' },
  { name: 'Online Traceroute',       path: 'traceroute',            cat: '🌐 Network & Web',        icon: '🔍', desc: 'Trace the network path hop by hop with live streaming output' },
  { name: 'DNS Lookup',              path: 'dns-lookup',            cat: '🌐 Network & Web',        icon: '📋', desc: 'Query A, AAAA, MX, NS, TXT, CNAME, SOA and CAA records' },
  { name: 'Reverse DNS Lookup',      path: 'reverse-dns',           cat: '🌐 Network & Web',        icon: '🔄', desc: 'Resolve any IPv4 or IPv6 address to its hostname via PTR' },
  { name: 'IPv6 Analyzer',           path: 'ipv6-analyzer',         cat: '🌐 Network & Web',        icon: '🔬', desc: 'Expand, compress and identify IPv6 address type' },
  { name: 'Subnet Calculator',       path: 'subnet-calculator',     cat: '🌐 Network & Web',        icon: '🧮', desc: 'CIDR subnet — network address, mask, host range and total' },
  { name: 'Website Up or Down',      path: 'website-status',        cat: '🌐 Network & Web',        icon: '🔌', desc: 'Check if a website is up or down — HTTP status, response time, SSL' },
  { name: 'Web Proxy',               path: 'web-proxy',             cat: '🌐 Network & Web',        icon: '🛡️', desc: 'View blocked or geo-restricted pages through an online proxy' },
  // 📤 Share
  { name: 'URL Shortener',           path: 'url-shortener',         cat: '📤 Share',                icon: '🔗', desc: 'Create short links with optional custom alias and expiry' },
  { name: 'Pastebin',                path: 'pastebin',              cat: '📤 Share',                icon: '📋', desc: 'Share code and text via private link with burn-after-read' },
  { name: 'File Share',              path: 'file-share',            cat: '📤 Share',                icon: '📦', desc: 'Upload archives and share a download link, auto-deleted after 7 days' },
  // 📁 PDF
  { name: 'PDF Toolkit',             path: 'pdf-toolkit',           cat: '📁 PDF',                  icon: '📑', desc: 'Merge, split, extract and reorder PDF pages with drag-and-drop' },
  { name: 'PDF to Text',             path: 'pdf-to-text',           cat: '📁 PDF',                  icon: '📄', desc: 'Extract text from any PDF — copy or download as .txt or .docx' },
  { name: 'Image to PDF',            path: 'image-to-pdf',          cat: '📁 PDF',                  icon: '🖼️', desc: 'Combine JPG/PNG/WebP images into one PDF — reorder, A4/Letter' },
  { name: 'PDF Enhance & Clean',     path: 'pdf-enhance',           cat: '📁 PDF',                  icon: '🧼', desc: 'Deskew, sharpen and clean scanned PDFs, add a searchable OCR text layer',  isNew: true },
  { name: 'PDF to Images',           path: 'pdf-to-images',         cat: '📁 PDF',                  icon: '🖼️', desc: 'Convert PDF pages to PNG/JPG — pick resolution and range, download or ZIP',  isNew: true },
  { name: 'Sign PDF',                path: 'pdf-sign',              cat: '📁 PDF',                  icon: '✍️', desc: 'Draw, type or upload a signature, place it on a page and download the signed PDF',  isNew: true },
  { name: 'PDF Watermark & Page Numbers', path: 'pdf-watermark',    cat: '📁 PDF',                  icon: '💧', desc: 'Stamp a text watermark and add page numbers with a live preview',  isNew: true },
  // 🎮 Relax
  { name: '2048',                    path: '2048',                  cat: '🎮 Relax',                icon: '🔢', desc: 'Slide and merge tiles to reach 2048' },
  { name: 'Sudoku',                  path: 'sudoku',                cat: '🎮 Relax',                icon: '🧩', desc: 'Classic 9×9 Sudoku — Easy, Medium, Hard with pencil mode' },
  { name: 'Gomoku',                  path: 'gomoku',                cat: '🎮 Relax',                icon: '⭕', desc: 'Get 5 stones in a row on a 15×15 board — vs AI or friend' },
  { name: 'Memory Match',            path: 'memory',                cat: '🎮 Relax',                icon: '🎴', desc: 'Flip emoji cards to find matching pairs' },
  { name: 'Chess',                   path: 'chess',                 cat: '🎮 Relax',                icon: '♟️', desc: 'Full-rules chess vs AI or two players' },
  { name: 'Simon Says',              path: 'simon-says',            cat: '🎮 Relax',                icon: '🔴', desc: 'Watch and repeat the color and sound sequence' },
  { name: 'Number Memory',           path: 'number-memory',         cat: '🎮 Relax',                icon: '🔢', desc: 'Memorize and recall growing number sequences' },
  { name: 'Visual Memory',           path: 'visual-memory',         cat: '🎮 Relax',                icon: '🧠', desc: 'Remember which squares light up, then reproduce the pattern' },
  { name: 'Word Memory',             path: 'word-memory',           cat: '🎮 Relax',                icon: '🔤', desc: 'Study a word list and identify which words you actually saw' },
];

// Expose new-tool paths for the main index Stats panel
window._OT_NEW_TOOLS = OT_TOOLS.filter(t => t.isNew).map(t => t.path);

/* ---------- Related Tools ---------- */
function renderRelatedTools(containerId, tools) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const cards = tools.map(({ path, desc }) => {
    const tool = OT_TOOLS.find(t => t.path === path) || {};
    const d = desc || tool.desc || '';
    return `<a href="../${path}/" class="related-card">
      <span class="related-icon">${tool.icon || '🔧'}</span>
      <div><div class="related-name">${tool.name || path}</div>${d ? `<div class="related-desc">${d}</div>` : ''}</div>
    </a>`;
  }).join('');
  el.innerHTML = `<h2>Related Tools</h2><div class="related-grid">${cards}</div>`;
}

function autoRelatedTools() {
  if (document.getElementById('related-tools')) return; // already manually set
  const m = window.location.pathname.match(/\/tools\/([^\/]+)/);
  if (!m) return;
  const currentPath = m[1];
  const current = OT_TOOLS.find(t => t.path === currentPath);
  if (!current) return;
  const pool = OT_TOOLS.filter(t => t.path !== currentPath && t.cat === current.cat);
  if (!pool.length) return;
  // Shuffle for variety on each visit
  const shuffled = pool.slice().sort(() => Math.random() - 0.5);
  const related = shuffled.slice(0, 4);
  const section = document.createElement('section');
  section.className = 'tool-related';
  section.id = 'related-tools';
  const cards = related.map(t => `<a href="../${t.path}/" class="related-card">
    <span class="related-icon">${t.icon}</span>
    <div><div class="related-name">${t.name}</div>${t.desc ? `<div class="related-desc">${t.desc}</div>` : ''}</div>
  </a>`).join('');
  section.innerHTML = `<h2>Related Tools</h2><div class="related-grid">${cards}</div>`;
  const anchor = document.querySelector('.page-tags') || document.querySelector('.tool-main');
  if (!anchor) return;
  if (anchor.classList.contains('page-tags')) {
    anchor.parentNode.insertBefore(section, anchor);
  } else {
    anchor.appendChild(section);
  }
}

/* ---------- Breadcrumbs (visible nav + BreadcrumbList schema) ---------- */
function renderBreadcrumbs() {
  const main = document.querySelector('.tool-main');
  if (!main || main.querySelector('.tool-breadcrumb')) return;
  const m = window.location.pathname.match(/\/tools\/([^\/]+)/);
  if (!m) return;
  const currentPath = m[1];
  const tool = OT_TOOLS.find(t => t.path === currentPath);
  // Fall back to the page title (minus the " — Office Tools" suffix) for any
  // tool page not listed in OT_TOOLS.
  const name = tool ? tool.name : document.title.replace(/\s*[—|].*$/, '').trim();

  // root resolves to the absolute site root (e.g. https://host/) — links there
  // directly to avoid the /index.html → / 301 the nginx SEO rule performs.
  const root = _otRootPath();

  // Absolute URLs for schema — prefer the canonical link, fall back to location.
  const canonical = document.querySelector('link[rel="canonical"]')?.href || window.location.href;
  const homeUrl = new URL('/', canonical).href;

  // Visible breadcrumb
  const nav = document.createElement('nav');
  nav.className = 'tool-breadcrumb';
  nav.setAttribute('aria-label', 'Breadcrumb');
  nav.innerHTML =
    `<a href="${root}">🛠️ Office Tools</a>` +
    `<span class="bc-sep" aria-hidden="true">›</span>` +
    `<span class="bc-current" aria-current="page">${escHtml(name)}</span>`;
  main.insertBefore(nav, main.firstChild);

  // BreadcrumbList structured data (Google renders JS, then reads injected JSON-LD)
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Office Tools', item: homeUrl },
      { '@type': 'ListItem', position: 2, name, item: canonical },
    ],
  };
  const s = document.createElement('script');
  s.type = 'application/ld+json';
  s.textContent = JSON.stringify(ld);
  document.head.appendChild(s);
}

function initToolSidebar() {
  const m = window.location.pathname.match(/\/tools\/([^\/]+)/);
  if (!m) return;
  const currentPath = m[1];

  // Build permanent left sidebar
  const sidebar = document.createElement('div');
  sidebar.className = 'ot-sidebar';
  sidebar.innerHTML = `
    <div class="ot-sidebar-search">
      <input type="text" id="otSidebarSearch" placeholder="All tools…" autocomplete="off">
    </div>
    <div class="ot-sidebar-list" id="otSidebarList"></div>
  `;

  document.body.appendChild(sidebar);
  document.body.classList.add('has-sidebar');

  // Align sidebar below the sticky header
  function positionSidebar() {
    const h = document.querySelector('.site-header')?.offsetHeight || 53;
    sidebar.style.top = h + 'px';
    sidebar.style.height = `calc(100vh - ${h}px)`;
  }
  positionSidebar();
  window.addEventListener('resize', positionSidebar);

  const searchInput = sidebar.querySelector('#otSidebarSearch');
  const listEl      = sidebar.querySelector('#otSidebarList');

  function renderList(q) {
    const query    = (q || '').toLowerCase().trim();
    const filtered = query
      ? OT_TOOLS.filter(t => t.name.toLowerCase().includes(query) || t.cat.toLowerCase().includes(query))
      : OT_TOOLS;

    const cats = [], map = {};
    for (const t of filtered) {
      if (!map[t.cat]) { map[t.cat] = []; cats.push(t.cat); }
      map[t.cat].push(t);
    }

    let html = '';
    for (const cat of cats) {
      if (!query) html += `<div class="ot-sidebar-cat">${cat}</div>`;
      for (const t of map[cat]) {
        html += `<a class="ot-sidebar-item${t.path === currentPath ? ' current' : ''}" href="../${t.path}/index.html">
          <span class="si-icon">${t.icon}</span><span class="si-name">${t.name}</span>
        </a>`;
      }
    }
    if (!html) html = '<div style="padding:1rem;color:var(--text-muted);font-size:.84rem">No tools found.</div>';
    listEl.innerHTML = html;
  }

  renderList();
  searchInput.addEventListener('input', () => renderList(searchInput.value));

  // Arrow-key + Enter navigation
  searchInput.addEventListener('keydown', e => {
    const items   = [...listEl.querySelectorAll('.ot-sidebar-item')];
    const focused = listEl.querySelector('.ot-sidebar-item.focused');
    let idx = items.indexOf(focused);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (focused) focused.classList.remove('focused');
      idx = (idx + 1) % items.length;
      items[idx]?.classList.add('focused');
      items[idx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (focused) focused.classList.remove('focused');
      idx = (idx - 1 + items.length) % items.length;
      items[idx]?.classList.add('focused');
      items[idx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && focused) {
      focused.click();
    }
  });

}

/* ---------- Root path helper (works at any directory depth) ---------- */
function _otRootPath() {
  if (_OT_SCRIPT_SRC) {
    // Derive from the known common.js URL — strip "/js/common.js" → root
    const m = _OT_SCRIPT_SRC.match(/^(.*?)\/js\/common\.js/);
    if (m) return m[1] + '/';
  }
  // Fallback: count non-html path segments
  const segs = window.location.pathname.split('/').filter(s => s && !s.endsWith('.html'));
  return segs.length === 0 ? './' : '../'.repeat(segs.length);
}

/* ---------- Tool View Tracking ---------- */
function trackToolView() {
  const toolPath = window.location.pathname.match(/\/tools\/([^/]+)/)?.[1];
  if (!toolPath) return;
  const API  = window.OT_CONFIG?.API_SERVER_URL || 'http://localhost:3001';
  const body = JSON.stringify({ tool: toolPath });
  try {
    navigator.sendBeacon(API + '/api/tools/view', new Blob([body], { type: 'application/json' }));
  } catch {
    fetch(API + '/api/tools/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }
}

/* ---------- Support Pill + Feedback Modal ---------- */
function initSupportPill() {
  const actions = document.querySelector('.header-actions');
  if (!actions) return;

  const pill = document.createElement('button');
  pill.className = 'support-pill';
  // Emoji + label as separate spans so the label can be hidden on mobile (icon-only circle)
  pill.innerHTML = '<span class="btn-ico">&#128172;</span><span class="btn-label">Support</span>';
  pill.title = 'Send feedback or report a broken tool';

  // Insert before the theme toggle
  const toggle = actions.querySelector('.theme-toggle');
  actions.insertBefore(pill, toggle || null);

  pill.addEventListener('click', openFeedbackModal);
}

function openFeedbackModal() {
  if (document.getElementById('ot-feedback-modal')) return;

  // Generate simple math CAPTCHA
  const ca = Math.floor(Math.random() * 9) + 1;
  const cb = Math.floor(Math.random() * 9) + 1;

  const backdrop = document.createElement('div');
  backdrop.className = 'ot-modal-backdrop';
  backdrop.id = 'ot-feedback-modal';
  backdrop.innerHTML = `
    <div class="ot-modal" role="dialog" aria-modal="true" aria-labelledby="ot-fb-title">
      <h3 id="ot-fb-title">&#128172; Send Feedback</h3>
      <p>Report a broken tool, suggest a feature, or leave any comment. No login needed &mdash; or reach me directly on the <a href="https://forum.grin.mw/u/hellogrin" target="_blank" rel="noopener" style="color:var(--primary)">Grin forum @hellogrin</a>.</p>
      <textarea id="ot-fb-msg" placeholder="Describe the issue or suggestion… (min 10 characters)" maxlength="2000"></textarea>
      <div style="display:flex;align-items:center;gap:.6rem;font-size:.88rem">
        <label for="ot-fb-captcha" style="white-space:nowrap;color:var(--text-muted)">What is ${ca} + ${cb}?</label>
        <input id="ot-fb-captcha" type="number" min="0" max="99" placeholder="Answer"
          style="width:80px;padding:.35rem .6rem;border:1.5px solid var(--border);border-radius:var(--radius);background:var(--bg-secondary);color:var(--text);font-size:.9rem;font-family:inherit;outline:none">
      </div>
      <div class="ot-modal-status" id="ot-fb-status"></div>
      <div class="ot-modal-actions">
        <button class="btn btn-secondary" id="ot-fb-cancel">Cancel</button>
        <button class="btn btn-primary" id="ot-fb-send">Send</button>
      </div>
    </div>`;

  document.body.appendChild(backdrop);

  const msg      = backdrop.querySelector('#ot-fb-msg');
  const captcha  = backdrop.querySelector('#ot-fb-captcha');
  const status   = backdrop.querySelector('#ot-fb-status');
  const sendBtn  = backdrop.querySelector('#ot-fb-send');

  msg.focus();

  function close() { backdrop.remove(); }

  backdrop.querySelector('#ot-fb-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  sendBtn.addEventListener('click', async () => {
    const text = msg.value.trim();
    const ans  = captcha.value.trim();

    if (text.length < 10) {
      status.textContent = 'Message too short — please write at least 10 characters.';
      status.className = 'ot-modal-status fail'; return;
    }
    if (!ans) {
      status.textContent = 'Please answer the math question.';
      status.className = 'ot-modal-status fail'; return;
    }

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    status.textContent = '';
    status.className = 'ot-modal-status';

    const API = window.OT_CONFIG?.API_SERVER_URL || 'http://localhost:3001';
    try {
      const r = await fetch(`${API}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, page: window.location.pathname, ca, cb, ans: parseInt(ans, 10) }),
      });
      if (r.ok) {
        status.textContent = '✓ Sent! Thank you for the feedback.';
        status.className = 'ot-modal-status ok';
        msg.value = '';
        setTimeout(close, 2000);
      } else {
        const err = await r.json().catch(() => ({}));
        status.textContent = err.error || 'Failed to send. Try again.';
        status.className = 'ot-modal-status fail';
        sendBtn.disabled = false; sendBtn.textContent = 'Send';
      }
    } catch {
      status.textContent = 'Network error. Check your connection.';
      status.className = 'ot-modal-status fail';
      sendBtn.disabled = false; sendBtn.textContent = 'Send';
    }
  });
}

/* ---------- Auto-init on DOMContentLoaded ---------- */
document.addEventListener('DOMContentLoaded', () => {
  // Inject favicon once — path derived from common.js script URL so it works at any depth
  if (!document.querySelector('link[rel~="icon"]')) {
    const href = _OT_SCRIPT_SRC
      ? _OT_SCRIPT_SRC.replace(/\/js\/common\.js([?#].*)?$/, '/favicon.svg')
      : '/favicon.svg';
    const link = document.createElement('link');
    link.rel = 'icon'; link.type = 'image/svg+xml'; link.href = href;
    document.head.appendChild(link);
  }

  initThemeToggle();
  initTabs();
  initHeaderSearch();
  initToolSidebar();
  renderBreadcrumbs();
  autoRelatedTools();
  trackToolView();
  initSupportPill();

  // Ctrl+K / Cmd+K → focus the header search wherever it exists
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      const hs = document.getElementById('headerSearch');
      if (hs) { e.preventDefault(); hs.focus(); hs.select(); }
    }
  });
  // Auth nav rendered by auth.js when present (loaded after common.js on auth-enabled pages)

  // Floating donate heart button — shown on all pages except donate.html itself
  if (!window.location.pathname.endsWith('/donate.html')) {
    const root = _otRootPath();
    const btn  = document.createElement('a');
    btn.id    = 'ot-donate-heart';
    btn.href  = root + 'pages/donate.html';
    btn.title = 'Support Grin ❤️';
    btn.setAttribute('aria-label', 'Support Grin');
    btn.textContent = '❤️';
    btn.style.cssText = [
      'position:fixed',
      'bottom:1.5rem',
      'right:1.5rem',
      'z-index:900',
      'width:44px',
      'height:44px',
      'border-radius:50%',
      'background:var(--bg-card)',
      'border:1.5px solid var(--border)',
      'box-shadow:var(--shadow-md)',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'font-size:1.25rem',
      'text-decoration:none',
      'cursor:pointer',
      'transition:transform .15s, box-shadow .15s',
      'line-height:1',
    ].join(';');
    btn.addEventListener('mouseenter', () => {
      btn.style.transform  = 'scale(1.18)';
      btn.style.boxShadow  = '0 6px 20px rgba(0,0,0,.18)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform  = '';
      btn.style.boxShadow  = '';
    });
    document.body.appendChild(btn);
  }
});
