/* ============================================================
   Office Tools — Auth Module (OTAuth)
   Depends on: config.js loaded first
   ============================================================ */

const OTAuth = (() => {

  const LS_TOKEN   = 'ot_token';
  const LS_USER    = 'ot_user';
  const LS_SUB     = 'ot_sub';
  const LS_USAGE   = 'ot_usage';   // { "tool-id_YYYY-MM-DD": count }

  function cfg() { return window.OT_CONFIG || {}; }
  function pb(path) { return (cfg().PB_URL || 'http://localhost:8090') + path; }

  /* ── Storage helpers ──────────────────────────────────────── */
  function getToken()  { return localStorage.getItem(LS_TOKEN); }
  function getUser()   { const u = localStorage.getItem(LS_USER); return u ? JSON.parse(u) : null; }
  function getSub()    { const s = localStorage.getItem(LS_SUB);  return s ? JSON.parse(s) : null; }
  function saveAuth(token, user) {
    localStorage.setItem(LS_TOKEN, token);
    localStorage.setItem(LS_USER, JSON.stringify(user));
  }
  function clearAuth() {
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_USER);
    localStorage.removeItem(LS_SUB);
  }

  /* ── Auth state ───────────────────────────────────────────── */
  function isLoggedIn() { return !!getToken() && !!getUser(); }
  function isPro() {
    if (!isLoggedIn()) return false;
    const sub = getSub();
    if (!sub) return false;
    if (sub.plan === 'lifetime') return true;
    return sub.expires_at && new Date(sub.expires_at) > new Date();
  }
  function getDisplayName() {
    const u = getUser();
    return u ? (u.name || u.email.split('@')[0]) : null;
  }
  function getPlanLabel() {
    if (!isLoggedIn()) return 'Guest';
    if (isPro()) {
      const sub = getSub();
      const plans = cfg().PLANS || {};
      return plans[sub?.plan]?.name || 'Pro';
    }
    return 'Free';
  }

  /* ── API calls ────────────────────────────────────────────── */
  async function apiPost(path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = token;
    const res = await fetch(pb(path), { method: 'POST', headers, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(json.message || json.data?.password?.message || 'Request failed');
    return json;
  }
  async function apiGet(path, token) {
    const headers = {};
    if (token) headers['Authorization'] = token;
    const res = await fetch(pb(path), { headers });
    const json = await res.json();
    if (!res.ok) throw new Error(json.message || 'Request failed');
    return json;
  }
  async function apiPatch(path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = token;
    const res = await fetch(pb(path), { method: 'PATCH', headers, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(json.message || 'Request failed');
    return json;
  }

  /* ── Auth actions ─────────────────────────────────────────── */
  async function login(email, password) {
    const data = await apiPost('/api/collections/users/auth-with-password', { identity: email, password });
    saveAuth(data.token, data.record);
    await refreshSubscription();
    return data.record;
  }

  async function register(email, password, name) {
    await apiPost('/api/collections/users/records', {
      email, password, passwordConfirm: password, name,
      emailVisibility: false,
    });
    return login(email, password);
  }

  function logout() {
    clearAuth();
    window.location.href = _rootPath() + 'index.html';
  }

  async function refreshSubscription() {
    if (!isLoggedIn()) return null;
    const user = getUser();
    try {
      const data = await apiGet(
        `/api/collections/subscriptions/records?filter=(user="${user.id}"&&status="active")&sort=-created&perPage=1`,
        getToken()
      );
      const sub = data.items?.[0] || null;
      if (sub) localStorage.setItem(LS_SUB, JSON.stringify(sub));
      else localStorage.removeItem(LS_SUB);
      return sub;
    } catch { return null; }
  }

  async function updateProfile(fields) {
    const user = getUser();
    if (!user) throw new Error('Not logged in');
    const updated = await apiPatch(`/api/collections/users/records/${user.id}`, fields, getToken());
    localStorage.setItem(LS_USER, JSON.stringify({ ...user, ...updated }));
    return updated;
  }

  async function changePassword(oldPassword, newPassword) {
    const user = getUser();
    if (!user) throw new Error('Not logged in');
    await apiPatch(`/api/collections/users/records/${user.id}`, {
      oldPassword, password: newPassword, passwordConfirm: newPassword,
    }, getToken());
  }

  /* ── Usage gate ───────────────────────────────────────────── */
  function todayKey(toolId) {
    const d = new Date(); const day = `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
    return `${toolId}_${day}`;
  }
  function getUsageMap() {
    try { return JSON.parse(localStorage.getItem(LS_USAGE) || '{}'); } catch { return {}; }
  }
  function getTodayUsage(toolId) { return getUsageMap()[todayKey(toolId)] || 0; }
  function recordUsage(toolId) {
    const map = getUsageMap();
    const key = todayKey(toolId);
    map[key] = (map[key] || 0) + 1;
    // Prune old keys (keep last 30 days)
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    for (const k of Object.keys(map)) {
      const parts = k.split('_'); const date = parts[parts.length-1];
      if (date && new Date(date) < cutoff) delete map[k];
    }
    localStorage.setItem(LS_USAGE, JSON.stringify(map));
    // Also log to server if logged in
    if (isLoggedIn()) {
      const user = getUser();
      fetch(pb('/api/collections/usage_logs/records'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': getToken() },
        body: JSON.stringify({ user: user.id, tool: toolId }),
      }).catch(() => {});
    }
  }

  /**
   * Check if a tool use is allowed. Returns { allowed, reason }.
   * Call recordUsage(toolId) after the action if allowed.
   */
  function canUseTool(toolId) {
    const premiumTools = cfg().PREMIUM_TOOLS || [];
    // Premium tool check
    if (premiumTools.includes(toolId)) {
      if (!isPro()) return { allowed: false, reason: 'premium' };
    }
    // Guest daily limit
    if (!isLoggedIn()) {
      const used = getTodayUsage(toolId);
      const limit = cfg().FREE_DAILY_LIMIT || 10;
      if (used >= limit) return { allowed: false, reason: 'limit', used, limit };
    }
    return { allowed: true };
  }

  /* ── Usage gate modal (renders into DOM) ─────────────────── */
  function showGate(reason, toolId) {
    // Remove existing
    document.getElementById('ot-gate-modal')?.remove();

    const html = `
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
          <a href="${_rootPath()}auth/donate.html" class="btn btn-primary" style="display:block;margin-bottom:.6rem;text-decoration:none">
            ❤️ Support Grin
          </a>
          <button onclick="document.getElementById('ot-gate-modal').remove()"
            style="margin-top:.75rem;background:none;border:none;cursor:pointer;font-size:.82rem;color:var(--text-muted)">
            Dismiss
          </button>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  /* ── Auth nav rendering ───────────────────────────────────── */
  function _rootPath() {
    // Count directory segments (excluding filename) to determine how many '../' to prepend
    const dirs = window.location.pathname.split('/').filter(p => p && !p.endsWith('.html'));
    return dirs.length === 0 ? './' : '../'.repeat(dirs.length);
  }

  function renderAuthNav() {
    const el = document.getElementById('authNav');
    if (!el) return;
    const root = _rootPath();
    if (isLoggedIn()) {
      const name  = getDisplayName();
      const plan  = getPlanLabel();
      const badge = isPro()
        ? `<span style="background:var(--primary);color:#000;padding:.1rem .5rem;border-radius:50px;font-size:.68rem;font-weight:800;margin-left:.35rem">PRO</span>`
        : '';
      el.innerHTML = `
        <div style="position:relative;display:inline-block" id="userMenuWrap">
          <button onclick="document.getElementById('userDropdown').classList.toggle('hidden')"
            style="display:flex;align-items:center;gap:.45rem;background:var(--bg-secondary);border:1.5px solid var(--border);border-radius:50px;padding:.3rem .85rem .3rem .5rem;cursor:pointer;font-size:.83rem;font-weight:700;color:var(--text)">
            <span style="width:28px;height:28px;border-radius:50%;background:var(--primary);color:#000;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:.8rem">
              ${name[0].toUpperCase()}
            </span>
            ${name}${badge}
          </button>
          <div id="userDropdown" class="hidden" style="
            position:absolute;right:0;top:calc(100% + .4rem);background:var(--bg-card);
            border:1.5px solid var(--border);border-radius:var(--radius);min-width:180px;
            box-shadow:0 8px 24px rgba(0,0,0,.15);z-index:1000;overflow:hidden">
            <div style="padding:.5rem .85rem;border-bottom:1px solid var(--border);font-size:.75rem;color:var(--text-muted)">
              Signed in as <strong style="color:var(--text)">${getUser().email}</strong>
              <br><span style="font-size:.7rem">${plan}</span>
            </div>
            <a href="${root}auth/dashboard.html" style="display:block;padding:.55rem .85rem;font-size:.83rem;text-decoration:none;color:var(--text)" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''">👤 My Dashboard</a>
            <a href="${root}auth/donate.html" style="display:block;padding:.55rem .85rem;font-size:.83rem;text-decoration:none;color:var(--primary)" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''" >❤️ Support Grin</a>
            <div style="border-top:1px solid var(--border)">
              <button onclick="OTAuth.logout()" style="width:100%;text-align:left;padding:.55rem .85rem;font-size:.83rem;background:none;border:none;cursor:pointer;color:var(--text)" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''">
                🚪 Sign Out
              </button>
            </div>
          </div>
        </div>`;
      // Close dropdown on outside click
      document.addEventListener('click', e => {
        const wrap = document.getElementById('userMenuWrap');
        if (wrap && !wrap.contains(e.target)) {
          document.getElementById('userDropdown')?.classList.add('hidden');
        }
      });
    } else {
      el.innerHTML = `
        <a href="${root}auth/donate.html" class="btn btn-primary btn-sm" style="text-decoration:none">❤️ Donate</a>`;
    }
  }

  /* Auto-render on DOM ready */
  document.addEventListener('DOMContentLoaded', () => {
    renderAuthNav();
    // Refresh subscription in background
    if (isLoggedIn()) refreshSubscription().catch(() => {});
  });

  /* ── Public API ───────────────────────────────────────────── */
  return {
    getToken, getUser, getSub,
    isLoggedIn, isPro, getDisplayName, getPlanLabel,
    login, register, logout, refreshSubscription, updateProfile, changePassword,
    canUseTool, recordUsage, getTodayUsage, showGate,
    renderAuthNav, _rootPath,
  };
})();
