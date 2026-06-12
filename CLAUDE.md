# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Backend (port 3001):**
```bash
cd backend && npm install
npm start          # production
npm run dev        # nodemon watch mode
node --check office-tools-server.js  # syntax check only
```

**YT server (port 9000):**
```bash
cd yt-server && npm install && npm start
```

**Frontend:** No build step. Open `index.html` or any `tools/<name>/index.html` directly in a browser, or serve statically. Point `js/config.js` → `localhost:3001` for backend features.

**Deploy to server:**
```bash
sudo bash deploy.sh          # install/update/add domain
```

---

## Architecture

### Frontend — no framework, no build

Every tool is a self-contained `tools/<name>/index.html`. There is no bundler, no transpilation. Each page includes:
- an **inline** theme-init `<script>` in `<head>` before the stylesheet — sets `data-theme` (default `matrix`) with zero fetch delay so there is no flash of the wrong theme on first paint. The static `<html data-theme="matrix">` attribute must match this default. (Inlined rather than an external file precisely to avoid the fetch round-trip that caused the flash.)
- `../../css/style.css` — all shared styles and CSS variables
- `../../js/config.js` — exposes `window.OT_CONFIG.API_SERVER_URL`
- `../../js/common.js` — theme toggle (`initThemeToggle`), `copyText(text, btn)`

The hub (`index.html`) renders a tool grid with search and category filters. Adding a tool = creating the `tools/<name>/` directory and inserting a card into the correct `<section class="category-section">` in `index.html`.

### Backend — single Express file

`backend/office-tools-server.js` is one file with all API routes. Routes are grouped by feature with inline comments (`// ── Section ──`). Add new endpoints before the `// ── Start ──` block at the bottom.

**Rate limiting pattern** (reuse, don't reinvent):
```js
const _myRateMap = new Map();
setInterval(() => { /* prune expired */ }, 300_000);
function _myAllow(ip) { /* count <= N per minute */ }
function myRLMiddleware(req, res, next) { /* 429 if exceeded */ }
```

**SSE streaming pattern** (ping, traceroute):
```js
res.setHeader('Content-Type', 'text/event-stream');
res.flushHeaders();
proc.stdout.on('data', chunk => res.write(`data: ${JSON.stringify(line)}\n\n`));
proc.on('close', () => { res.write('data: "[DONE]"\n\n'); res.end(); });
req.on('close', () => proc.kill());
```

**DNS queries** go through Cloudflare DoH (`https://cloudflare-dns.com/dns-query?name=&type=`, `Accept: application/dns-json`). Allowed types are whitelisted in `_DNS_ALLOWED_TYPES`.

**SQLite** uses `better-sqlite3` (synchronous). Tables: `short_urls`, `pastes`, `file_shares`. DB path defaults to `/opt/office-tools/data/tools.db`.

**child_process / host input** — always sanitize host strings with a strict character whitelist before passing to `spawn()`: `/^[a-zA-Z0-9.\-:\[\]_]+$/`.

### Theme system

Four themes: `light` → `dark` → `matrix` → `anime`. Set via `data-theme` on `<html>`. CSS variables used everywhere:

| Variable | Purpose |
|---|---|
| `--bg-card`, `--bg-secondary` | Surface backgrounds |
| `--border` | Borders |
| `--primary`, `--primary-dim` | Accent color + transparent tint |
| `--text`, `--text-muted` | Body and muted text |
| `--danger`, `--danger-dim` | Error states |
| `--radius`, `--transition` | Shape and animation |

### Network tools — backend endpoints

| Endpoint | Feature | Response |
|---|---|---|
| `GET /api/resolve?host=` | DNS A+AAAA resolve (IPv4+IPv6) | `{host, addresses:[{ip,family}]}` |
| `GET /api/portcheck?host=&port=` | Single TCP probe | `{host, port, open}` |
| `GET /api/portcheckbatch?host=&ports=` | Batch TCP probe (ports CSV, max 60) | `{host, results:[{port,open}]}` |
| `GET /api/net/ping` | SSE-streamed ping (Windows/Linux) | SSE |
| `GET /api/net/traceroute` | SSE-streamed traceroute | SSE |
| `GET /api/net/ptr?ip=` | Reverse DNS via `dns.reverse()` | JSON |
| `GET /api/domain/dns?domain=&type=` | DoH proxy — A/AAAA/MX/NS/TXT/CNAME/SOA/CAA | JSON |
| `GET /api/domain/whois`, `rdap`, `availability` | Domain info | JSON |

IPv6 addresses are accepted with or without brackets (`[::1]` and `::1`); strip brackets with `.replace(/^\[|\]$/g, '')` before use.

**`portcheck` / `portcheckbatch` are a PUBLIC service** (open CORS `*`, not the `CORS_ORIGINS` allowlist that guards every other route) so any external page — e.g. a Grin solo-pool setup page on any domain — can verify its own stratum port. Two safeguards make this safe and must stay in place:
- **SSRF guard** (`resolvePublicTarget` → `ipIsPublic`): rejects loopback/private/link-local/CGNAT/reserved/IPv4-mapped targets and resolves hostnames to a validated **public** IP *before* connecting, so the endpoint can't be used to probe the server's own internal network or cloud metadata (`169.254.169.254`). DNS-rebinding is defeated by connecting to the resolved IP, not the raw hostname.
- **Rate limit** `probeRLMiddleware`: 40 req/min per IP (separate from `netRLMiddleware`'s 10/min on ping/resolve/ptr). Raising this is only safe while the SSRF guard is intact.

Consumed by the Grin Node Toolkit solo-mining setup page (`web/07_mining_pool_solo/setup-solo-mining.html`, configured via its `data/config.json` → `portcheck_api`) to render live "🟢 reachable / 🔴 unreachable" pills.

### Two-server setup

| Server | Port | Managed by |
|---|---|---|
| `backend/office-tools-server.js` | 3001 | systemd `office-tools-api.service` |
| `yt-server/server.js` | 9000 | systemd `office-tools-cobalt.service` |

nginx proxies `/pay-api/*` → 3001 and `/yt-api/*` → 9000. The `backend/` directory is excluded from the public web root (`rsync --exclude=backend/`).

### What needs the backend vs. what doesn't

Most tools are 100% browser-local. Backend is only required for: URL Shortener, Pastebin, File Share, Port Checker, Domain Checker, and Network Toolkit. The site works without a running backend — those tools just show an error.

### Adding a new tool checklist

1. Create `tools/<name>/index.html` — copy the header/footer pattern from any existing tool
2. Add a card to the correct `<section class="category-section">` in `index.html` with `data-keywords` and `data-name` for search
3. **Register the tool in the `OT_TOOLS` array in `js/common.js`** (`{ name, path, cat, icon, desc }`, plus `isNew: true` for the New-Tools panel). This single registration is what powers the **left sidebar, header search, breadcrumb name, and the auto-injected "Related Tools" section** (`autoRelatedTools()`) — a tool missing from `OT_TOOLS` silently gets none of these. Related tools need no per-page markup: `autoRelatedTools()` injects them at runtime for any registered tool that has a `.page-tags` anchor (only ~8 of 115 tools override with an explicit `id="related-tools"`; the rest rely on auto). The `cat` string (emoji + label) must **exactly match** an existing category's string, or the tool lands in a category of one.
4. Add a `<url>` entry to `sitemap.xml` (`https://tools.grin.money/tools/<name>/`, today's date as `lastmod`)
5. If it needs backend APIs, add routes to `office-tools-server.js` before `// ── Start ──`
6. Tools must be mobile-responsive, use CSS variables (not hardcoded colors), and include no external analytics or cookies

> **If Related Tools / sidebar / search are missing on a deployed tool page**, the usual cause is a **stale `js/common.js`** (cached or not redeployed) whose `OT_TOOLS` predates the tool — `autoRelatedTools()` can't find the current path and bails. Hard-refresh / redeploy `common.js`, don't add manual markup.

**Standard page structure every tool follows:**
```html
<header class="site-header">…back link, tool name, theme toggle…</header>
<main class="tool-main">
  <div class="tool-header"><h1>…</h1><p>…</p></div>
  <section class="tool-about"><h2>About …</h2><p>…</p></section>
  <!-- tool UI cards -->
  <div class="page-tags">…SEO keyword spans…</div>
</main>
<script src="../../js/config.js"></script>
<script src="../../js/common.js"></script>
<script>…tool logic…</script>
```

**Always escape user-visible output** with a local `escHtml` helper — every tool that renders dynamic content defines one:
```js
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
```

**`const API`** — tools that call the backend always start their script block with:
```js
const API = window.OT_CONFIG?.API_SERVER_URL || 'http://localhost:3001';
```
