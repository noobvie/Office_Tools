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
  { name: 'Pomodoro Timer',          path: 'pomodoro',              cat: '⏱️ Productivity & Time', icon: '🍅' },
  { name: 'Date Calculator',         path: 'date-calculator',       cat: '⏱️ Productivity & Time', icon: '📅' },
  { name: 'World Calendar',          path: 'calendar',              cat: '⏱️ Productivity & Time', icon: '🗓️' },
  { name: 'Stopwatch & Timer',       path: 'timer',                 cat: '⏱️ Productivity & Time', icon: '⏱️' },
  { name: 'Time Zone Converter',     path: 'timezone',              cat: '⏱️ Productivity & Time', icon: '🌐' },
  // ✨ Generators
  { name: 'Password Generator',      path: 'password-generator',    cat: '✨ Generators',           icon: '🔑' },
  { name: 'QR Code Generator',       path: 'qr-generator',          cat: '✨ Generators',           icon: '📱' },
  { name: 'UUID Generator',          path: 'uuid-generator',        cat: '✨ Generators',           icon: '🆔' },
  { name: 'Random Number Generator', path: 'random-number',         cat: '✨ Generators',           icon: '🎲' },
  { name: 'Lorem Ipsum Generator',   path: 'lorem-ipsum',           cat: '✨ Generators',           icon: '📄' },
  // 📝 Text & Content
  { name: 'Word Counter',            path: 'word-counter',          cat: '📝 Text & Content',       icon: '📝' },
  { name: 'Markdown Editor',         path: 'markdown-editor',       cat: '📝 Text & Content',       icon: '✍️' },
  { name: 'Text Diff',               path: 'text-diff',             cat: '📝 Text & Content',       icon: '🔍' },
  { name: 'Typing Speed Test',       path: 'typing-speed',          cat: '📝 Text & Content',       icon: '⌨️' },
  { name: 'Text Case Converter',     path: 'text-case',             cat: '📝 Text & Content',       icon: '🔡' },
  { name: 'Notepad',                 path: 'notepad',               cat: '📝 Text & Content',       icon: '📝' },
  // 🔒 Encoding & Crypto
  { name: 'Base64 Converter',        path: 'base64-converter',      cat: '🔒 Encoding & Crypto',    icon: '🔐' },
  { name: 'URL Encoder / Decoder',   path: 'url-encoder',           cat: '🔒 Encoding & Crypto',    icon: '🔗' },
  { name: 'Unix Timestamp',          path: 'unix-timestamp',        cat: '🔒 Encoding & Crypto',    icon: '⏰' },
  { name: 'Hash Generator',          path: 'hash-generator',        cat: '🔒 Encoding & Crypto',    icon: '🛡️' },
  { name: 'HTML Entity Encoder',     path: 'html-entities',         cat: '🔒 Encoding & Crypto',    icon: '🏷️' },
  { name: 'JWT Decoder',             path: 'jwt-decoder',           cat: '🔒 Encoding & Crypto',    icon: '🔐' },
  { name: 'Number Base Converter',   path: 'base-converter',        cat: '🔒 Encoding & Crypto',    icon: '🔢' },
  // 🧮 Calculators
  { name: 'Percentage Calculator',   path: 'percentage-calculator', cat: '🧮 Calculators',          icon: '💯' },
  { name: 'Aspect Ratio Calculator', path: 'aspect-ratio',          cat: '🧮 Calculators',          icon: '📐' },
  { name: 'Unit Converter',          path: 'unit-converter',        cat: '🧮 Calculators',          icon: '📐' },
  { name: 'Loan Calculator',         path: 'loan-calculator',       cat: '🧮 Calculators',          icon: '🏦' },
  { name: 'Tip Calculator',          path: 'tip-calculator',        cat: '🧮 Calculators',          icon: '🧾' },
  { name: 'Number to Words',         path: 'number-words',          cat: '🧮 Calculators',          icon: '🔤' },
  // 💻 Development
  { name: 'JSON Editor',             path: 'json-editor',           cat: '💻 Development',          icon: '📋' },
  { name: 'CSV ↔ JSON',              path: 'csv-json',              cat: '💻 Development',          icon: '📊' },
  { name: 'Crontab Explainer',       path: 'crontab',               cat: '💻 Development',          icon: '⏲️' },
  { name: 'Regex Tester',            path: 'regex-tester',          cat: '💻 Development',          icon: '🔍' },
  { name: 'SQL Formatter',           path: 'sql-formatter',         cat: '💻 Development',          icon: '🗄️' },
  { name: 'File Compressor',         path: 'file-compressor',       cat: '💻 Development',          icon: '🗜️' },
  { name: 'AI Token Counter',        path: 'ai-token-counter',      cat: '💻 Development',          icon: '🔢' },
  { name: 'Prompt Template Builder', path: 'ai-prompt-template',    cat: '💻 Development',          icon: '📝' },
  { name: 'JSON Schema Builder',     path: 'ai-json-schema',        cat: '💻 Development',          icon: '🏗️' },
  // 🎬 Media
  { name: 'YouTube Downloader',      path: 'yt-downloader',         cat: '🎬 Media',                icon: '📥' },
  { name: 'Speech & Voice',          path: 'speech-voice',          cat: '🎬 Media',                icon: '🎙️' },
  { name: 'Photo Editor',            path: 'photo-editor',          cat: '🎬 Media',                icon: '🖼️' },
  // 🎨 Design
  { name: 'Color Converter',         path: 'color-converter',       cat: '🎨 Design',               icon: '🎨' },
  { name: 'Character Map',           path: 'char-map',              cat: '🎨 Design',               icon: '🔣' },
  // 🌐 Network & Web
  { name: 'Currency Converter',      path: 'currency',              cat: '🌐 Network & Web',        icon: '💱' },
  { name: 'What Is My IP?',          path: 'my-ip',                 cat: '🌐 Network & Web',        icon: '🌐' },
  { name: 'IP Location Lookup',      path: 'ip-location',           cat: '🌐 Network & Web',        icon: '📍' },
  { name: 'Campaign URL Builder',    path: 'utm-builder',           cat: '🌐 Network & Web',        icon: '🔗' },
  // 🖼️ Visual & Design
  { name: 'Screenshot Beautifier',   path: 'screenshot-beautifier', cat: '🖼️ Visual & Design',     icon: '🖼️' },
  { name: 'Contrast Checker',        path: 'contrast-checker',      cat: '🖼️ Visual & Design',     icon: '♿' },
  { name: 'Palette Extractor',       path: 'palette-extractor',     cat: '🖼️ Visual & Design',     icon: '🎨' },
  // 🎲 Fun & Productivity
  { name: 'Fake Data Generator',     path: 'fake-data',             cat: '🎲 Fun & Productivity',   icon: '🃏' },
  { name: 'Wheel of Names',          path: 'wheel-of-names',        cat: '🎲 Fun & Productivity',   icon: '🎡' },
  // 🔐 Security
  { name: 'CSR Decoder',             path: 'csr-decoder',           cat: '🔐 Security',             icon: '📜' },
  // 📁 Images & PDF
  { name: 'Image Converter',         path: 'image-converter',       cat: '📁 Images & PDF',         icon: '🖼️' },
  { name: 'PDF Toolkit',             path: 'pdf-toolkit',           cat: '📁 Images & PDF',         icon: '📄' },
  { name: 'PDF to Text',             path: 'pdf-to-text',           cat: '📁 Images & PDF',         icon: '📃' },
  // 📤 Share
  { name: 'URL Shortener',           path: 'url-shortener',         cat: '📤 Share',                icon: '🔗' },
  { name: 'Pastebin',                path: 'pastebin',              cat: '📤 Share',                icon: '📋' },
  { name: 'File Share',              path: 'file-share',            cat: '📤 Share',                icon: '📦' },
  // 🎮 Relax
  { name: '2048',                    path: '2048',                  cat: '🎮 Relax',                icon: '🔢' },
  { name: 'Sudoku',                  path: 'sudoku',                cat: '🎮 Relax',                icon: '🧩' },
  { name: 'Gomoku',                  path: 'gomoku',                cat: '🎮 Relax',                icon: '⭕' },
  { name: 'Memory Match',            path: 'memory',                cat: '🎮 Relax',                icon: '🎴' },
  { name: 'Chess',                   path: 'chess',                 cat: '🎮 Relax',                icon: '♟️' },
  { name: 'Simon Says',              path: 'simon-says',            cat: '🎮 Relax',                icon: '🔴' },
  { name: 'Number Memory',           path: 'number-memory',         cat: '🎮 Relax',                icon: '🔢' },
  { name: 'Visual Memory',           path: 'visual-memory',         cat: '🎮 Relax',                icon: '🧠' },
  { name: 'Word Memory',             path: 'word-memory',           cat: '🎮 Relax',                icon: '🔤' },
];

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
