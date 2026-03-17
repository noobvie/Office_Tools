/* ============================================================
   Office Tools — Shared JS
   ============================================================ */

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
    localStorage.setItem('ot-theme', next);
    update();
  });
}

/* ---------- Copy to clipboard ---------- */
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1800);
  });
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
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ---------- Auto-init on DOMContentLoaded ---------- */
document.addEventListener('DOMContentLoaded', () => {
  initThemeToggle();
  initTabs();
  // Auth nav rendered by auth.js when present (loaded after common.js on auth-enabled pages)
});
