/* ============================================================
   Office Tools — Shared JS
   ============================================================ */

/* Capture script URL before any async code (document.currentScript is only live here) */
const _OT_SCRIPT_SRC = document.currentScript?.src || '';

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
    btn.textContent = OT_LABELS[current] || '🌙 Dark';
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

/* ---------- Tool Sidebar ---------- */
const OT_TOOLS = [
  // ⏱️ Productivity & Time
  { name: 'Pomodoro Timer',          path: 'pomodoro',              cat: '⏱️ Productivity & Time', icon: '🍅', desc: '25-min focus timer with short and long break intervals' },
  { name: 'Date & Time Calculator',  path: 'date-calculator',       cat: '⏱️ Productivity & Time', icon: '📅', desc: 'Date difference, age, countdown and time unit converter' },
  { name: 'World Calendar',          path: 'calendar',              cat: '⏱️ Productivity & Time', icon: '🗓️', desc: 'Gregorian, Chinese Lunar and Islamic Hijri calendar' },
  { name: 'Stopwatch & Timer',       path: 'timer',                 cat: '⏱️ Productivity & Time', icon: '⏱️', desc: 'Precise stopwatch with lap times and countdown timer' },
  { name: 'Time Zone Converter',     path: 'timezone',              cat: '⏱️ Productivity & Time', icon: '🌐', desc: 'Convert times between any two time zones' },
  // ✨ Generators
  { name: 'Password Generator',      path: 'password-generator',    cat: '✨ Generators',           icon: '🔑', desc: 'Generate secure random passwords with custom options' },
  { name: 'QR & Barcode Generator',  path: 'qr-generator',          cat: '✨ Generators',           icon: '📱', desc: 'Generate QR codes with logo or barcodes — URL, WiFi, vCard' },
  { name: 'UUID Generator',          path: 'uuid-generator',        cat: '✨ Generators',           icon: '🆔', desc: 'Generate UUID v4 and v7 identifiers, single or bulk' },
  { name: 'Random Number Generator', path: 'random-number',         cat: '✨ Generators',           icon: '🎲', desc: 'Generate random integers or decimals in any range' },
  { name: 'Lorem Ipsum Generator',   path: 'lorem-ipsum',           cat: '✨ Generators',           icon: '📄', desc: 'Generate placeholder text by paragraphs, sentences or words' },
  { name: 'Fake Data Generator',     path: 'fake-data',             cat: '✨ Generators',           icon: '🃏', desc: 'Generate realistic test data — names, emails, addresses' },
  { name: 'Wheel of Names',          path: 'wheel-of-names',        cat: '✨ Generators',           icon: '🎡', desc: 'Spin a wheel to randomly pick a winner from your list' },
  // 📝 Text & Content
  { name: 'Word Counter',            path: 'word-counter',          cat: '📝 Text & Content',       icon: '📊', desc: 'Count words, characters, sentences and reading time live' },
  { name: 'Markdown Editor',         path: 'markdown-editor',       cat: '📝 Text & Content',       icon: '✍️', desc: 'Live split-pane Markdown editor with HTML preview' },
  { name: 'Text Diff',               path: 'text-diff',             cat: '📝 Text & Content',       icon: '🔀', desc: 'Side-by-side diff with color-highlighted additions and deletions' },
  { name: 'Typing Speed Test',       path: 'typing-speed',          cat: '📝 Text & Content',       icon: '⌨️', desc: 'Measure WPM and accuracy with real-time error tracking' },
  { name: 'Text Case Converter',     path: 'text-case',             cat: '📝 Text & Content',       icon: '🔡', desc: 'Convert to UPPERCASE, camelCase, snake_case, kebab-case and more' },
  { name: 'Notepad',                 path: 'notepad',               cat: '📝 Text & Content',       icon: '📝', desc: 'Auto-saving scratch pad with up to 5 named notes' },
  // 🔒 Encoding & Crypto
  { name: 'Base64 Converter',        path: 'base64-converter',      cat: '🔒 Encoding & Crypto',    icon: '🔄', desc: 'Encode and decode text or files to/from Base64' },
  { name: 'URL Encoder / Decoder',   path: 'url-encoder',           cat: '🔒 Encoding & Crypto',    icon: '🔗', desc: 'Percent-encode and decode URLs with before/after diff' },
  { name: 'Unix Timestamp',          path: 'unix-timestamp',        cat: '🔒 Encoding & Crypto',    icon: '🕐', desc: 'Convert Unix timestamps to dates and vice versa' },
  { name: 'Hash Generator',          path: 'hash-generator',        cat: '🔒 Encoding & Crypto',    icon: '🔑', desc: 'Generate SHA-256, SHA-512 and HMAC hashes from text or files' },
  { name: 'HTML Entity Encoder',     path: 'html-entities',         cat: '🔒 Encoding & Crypto',    icon: '🏷️', desc: 'Encode and decode HTML entities for safe HTML output' },
  { name: 'JWT Decoder',             path: 'jwt-decoder',           cat: '🔒 Encoding & Crypto',    icon: '🔐', desc: 'Decode JSON Web Tokens — header, payload, expiry and claims' },
  { name: 'Number Base Converter',   path: 'base-converter',        cat: '🔒 Encoding & Crypto',    icon: '🔢', desc: 'Convert between binary, octal, decimal and hexadecimal' },
  // 🧮 Calculators
  { name: 'Percentage Calculator',   path: 'percentage-calculator', cat: '🧮 Calculators',          icon: '💯', desc: 'Calculate percentages, percent of, and percentage change' },
  { name: 'Aspect Ratio Calculator', path: 'aspect-ratio',          cat: '🧮 Calculators',          icon: '📐', desc: 'Find missing width or height for any aspect ratio' },
  { name: 'Unit Converter',          path: 'unit-converter',        cat: '🧮 Calculators',          icon: '📐', desc: 'Convert length, weight, temperature, volume and more' },
  { name: 'Loan Calculator',         path: 'loan-calculator',       cat: '🧮 Calculators',          icon: '🏦', desc: 'Monthly payment and amortization schedule for any loan' },
  { name: 'Tip Calculator',          path: 'tip-calculator',        cat: '🧮 Calculators',          icon: '🧾', desc: 'Calculate tip and split the bill among friends' },
  { name: 'Number to Words',         path: 'number-words',          cat: '🧮 Calculators',          icon: '🔤', desc: 'Convert numbers to English words for checks and invoices' },
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
  // 🎬 Media
  { name: 'YouTube Downloader',      path: 'yt-downloader',         cat: '🎬 Media',                icon: '📥', desc: 'Download YouTube videos as MP4 or audio as MP3' },
  { name: 'Speech & Voice',          path: 'speech-voice',          cat: '🎬 Media',                icon: '🎙️', desc: 'Transcribe mic or audio to text, or convert text to speech' },
  { name: 'Photo Editor',            path: 'photo-editor',          cat: '🎬 Media',                icon: '🖼️', desc: 'Remove backgrounds, adjust colors and add text to photos' },
  { name: 'Image Converter',         path: 'image-converter',       cat: '🎬 Media',                icon: '🖼️', desc: 'Convert HEIC/HEIF to JPG/PNG, compress and resize images' },
  { name: 'Screenshot Beautifier',   path: 'screenshot-beautifier', cat: '🎬 Media',                icon: '🖼️', desc: 'Add gradient backgrounds and shadows to screenshots' },
  // 🎨 Design
  { name: 'Color Converter',         path: 'color-converter',       cat: '🎨 Design',               icon: '🎨', desc: 'Convert HEX, RGB, HSL, HSV and CMYK with live preview' },
  { name: 'Contrast Checker',        path: 'contrast-checker',      cat: '🎨 Design',               icon: '♿', desc: 'Check WCAG AA/AAA contrast ratios for color pairs' },
  { name: 'Palette Extractor',       path: 'palette-extractor',     cat: '🎨 Design',               icon: '🎨', desc: 'Extract dominant color palette from any image' },
  { name: 'Character Map',           path: 'char-map',              cat: '🎨 Design',               icon: '🔣', desc: 'Browse and copy special characters, symbols and emoji' },
  // 🌐 Network & Web
  { name: 'Currency Converter',      path: 'currency',              cat: '🌐 Network & Web',        icon: '💱', desc: 'Convert 40+ fiat currencies and crypto with live rates' },
  { name: 'What Is My IP?',          path: 'my-ip',                 cat: '🌐 Network & Web',        icon: '🌐', desc: 'Show your public IP, ISP, country and IPv6 status' },
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
  // 📤 Share
  { name: 'URL Shortener',           path: 'url-shortener',         cat: '📤 Share',                icon: '🔗', desc: 'Create short links with optional custom alias and expiry' },
  { name: 'Pastebin',                path: 'pastebin',              cat: '📤 Share',                icon: '📋', desc: 'Share code and text via private link with burn-after-read' },
  { name: 'File Share',              path: 'file-share',            cat: '📤 Share',                icon: '📦', desc: 'Upload archives and share a download link, auto-deleted after 7 days' },
  // 📁 PDF
  { name: 'PDF Toolkit',             path: 'pdf-toolkit',           cat: '📁 PDF',                  icon: '📑', desc: 'Merge, split, extract and reorder PDF pages with drag-and-drop' },
  { name: 'PDF to Text',             path: 'pdf-to-text',           cat: '📁 PDF',                  icon: '📄', desc: 'Extract text from any PDF — copy or download as .txt or .docx' },
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

function initToolSidebar() {
  const m = window.location.pathname.match(/\/tools\/([^\/]+)/);
  if (!m) return;
  const currentPath = m[1];

  // Build permanent left sidebar
  const sidebar = document.createElement('div');
  sidebar.className = 'ot-sidebar';
  sidebar.innerHTML = `
    <div class="ot-sidebar-head">
      <strong>🛠️ All Tools</strong>
    </div>
    <div class="ot-sidebar-search">
      <input type="text" id="otSidebarSearch" placeholder="Search tools…" autocomplete="off">
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

  // Ctrl+K focuses the sidebar search
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      searchInput.focus();
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

/* ---------- Support Pill + Feedback Modal ---------- */
function initSupportPill() {
  const actions = document.querySelector('.header-actions');
  if (!actions) return;

  const pill = document.createElement('button');
  pill.className = 'support-pill';
  pill.innerHTML = '&#128172; Support';
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
  initToolSidebar();
  autoRelatedTools();
  initSupportPill();
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
