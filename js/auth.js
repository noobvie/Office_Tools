/* ============================================================
   Office Tools — Auth Module (OTAuth)
   Depends on: config.js loaded first
   ============================================================ */

const OTAuth = (() => {

  const LS_USAGE = 'ot_usage'; // { "tool-id_YYYY-MM-DD": count }

  function cfg() { return window.OT_CONFIG || {}; }

  /* ── Daily usage gate (localStorage only) ─────────────────── */
  function todayKey(toolId) {
    const d = new Date();
    return `${toolId}_${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
  }
  function getUsageMap() {
    try { return JSON.parse(localStorage.getItem(LS_USAGE) || '{}'); } catch { return {}; }
  }
  function getTodayUsage(toolId) { return getUsageMap()[todayKey(toolId)] || 0; }
  function recordUsage(toolId) {
    const map = getUsageMap();
    const key = todayKey(toolId);
    map[key] = (map[key] || 0) + 1;
    // Prune keys older than 30 days
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    for (const k of Object.keys(map)) {
      const date = k.split('_').pop();
      if (date && new Date(date) < cutoff) delete map[k];
    }
    localStorage.setItem(LS_USAGE, JSON.stringify(map));
  }

  function canUseTool(toolId) {
    const used  = getTodayUsage(toolId);
    const limit = cfg().FREE_DAILY_LIMIT || 10;
    if (used >= limit) return { allowed: false, reason: 'limit', used, limit };
    return { allowed: true };
  }

  /* ── Usage gate modal ─────────────────────────────────────── */
  function showGate(reason, toolId) {
    document.getElementById('ot-gate-modal')?.remove();
    const root = _rootPath();
    document.body.insertAdjacentHTML('beforeend', `
      <div id="ot-gate-modal" style="
        position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;
        background:rgba(0,0,0,.55);backdrop-filter:blur(4px);padding:1rem">
        <div style="
          background:var(--bg-card);border:1.5px solid var(--border);border-radius:var(--radius-lg);
          padding:2rem;max-width:420px;width:100%;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.3)">
          <div style="font-size:2.5rem">⏳</div>
          <h2 style="margin:.75rem 0 .5rem;font-size:1.3rem">Daily Limit Reached</h2>
          <p style="color:var(--text-muted);font-size:.9rem;margin-bottom:1.25rem">
            You've used your ${cfg().FREE_DAILY_LIMIT || 10} free uses for today. Come back tomorrow!<br>
            If these tools save you time, consider supporting Grin development.
          </p>
          <a href="${root}pages/donate.html" class="btn btn-primary"
             style="display:block;margin-bottom:.6rem;text-decoration:none">❤️ Support Grin</a>
          <button onclick="document.getElementById('ot-gate-modal').remove()"
            style="margin-top:.75rem;background:none;border:none;cursor:pointer;font-size:.82rem;color:var(--text-muted)">
            Dismiss
          </button>
        </div>
      </div>`);
  }

  /* ── Nav: always shows ❤️ Donate ──────────────────────────── */
  function _rootPath() {
    const dirs = window.location.pathname.split('/').filter(p => p && !p.endsWith('.html'));
    return dirs.length === 0 ? './' : '../'.repeat(dirs.length);
  }

  function renderAuthNav() {
    const el = document.getElementById('authNav');
    if (!el) return;
    el.innerHTML = `
      <a href="${_rootPath()}pages/donate.html"
         class="btn btn-primary btn-sm" style="text-decoration:none">❤️ Donate</a>`;
  }

  document.addEventListener('DOMContentLoaded', renderAuthNav);

  /* ── Public API ───────────────────────────────────────────── */
  return { canUseTool, recordUsage, getTodayUsage, showGate, renderAuthNav, _rootPath };
})();
