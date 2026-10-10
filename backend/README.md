# Office Tools — Backend Setup

## Stack

| Component | Role |
|-----------|------|
| Node.js + Express | API server (URL shortener, pastebin, file share, network tools) |
| better-sqlite3 | Local SQLite database |

---

## Quick Start

```bash
cd backend
cp .env.example .env
# Edit .env — set CORS_ORIGINS to your domain
npm install
npm start
```

Development (auto-restart on changes):
```bash
npm run dev
```

Syntax check without running:
```bash
node --check office-tools-server.js
```

Tests (`node:test`, zero dependencies; fixture servers bind `127.0.0.1:0` and close themselves):
```bash
npm test             # node --test "test/**/*.test.js"
```

Local smoke test on loopback only:
```bash
HOST=127.0.0.1 PORT=3999 TOOLS_DB=/tmp/t.db UPLOADS_DIR=/tmp/up npm start
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server listen port |
| `HOST` | *(unset = all interfaces)* | Listen address; set `127.0.0.1` for local tests |
| `CORS_ORIGINS` | `http://localhost:8080` | Comma-separated allowed origins |
| `TOOLS_DB` | `/opt/office-tools/data/tools.db` | SQLite DB path |
| `UPLOADS_DIR` | `/opt/office-tools/data/uploads` | File share upload directory |
| `GEMINI_API_KEY` | *(optional)* | Enables AI domain name suggestions |

---

## Run as systemd service

```ini
# /etc/systemd/system/office-tools-api.service
[Unit]
Description=Office Tools — API Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/office-tools/backend
ExecStart=/usr/bin/node office-tools-server.js
Environment=TZ=UTC
EnvironmentFile=/opt/office-tools/backend/.env
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now office-tools-api
```

---

## Nginx Reverse Proxy

```nginx
location /tools-api/ {
    proxy_pass http://127.0.0.1:3001/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

Then update `js/config.js`:
```js
API_SERVER_URL: 'https://yourdomain.com/tools-api',
```

---

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tools/s` | Create short URL |
| GET | `/api/tools/s/:code` | Resolve short URL |
| POST | `/api/tools/p` | Create paste |
| GET | `/api/tools/p/:code` | Get paste |
| POST | `/api/tools/f` | Upload file |
| GET | `/api/tools/f/:code` | Get file metadata |
| GET | `/api/tools/f/:code/download` | Download file |
| GET | `/api/resolve` | DNS resolve (A + AAAA) |
| GET | `/api/portcheck` | TCP port probe |
| GET | `/api/net/ping` | SSE ping stream |
| GET | `/api/net/traceroute` | SSE traceroute stream |
| GET | `/api/net/ptr` | Reverse DNS |
| GET | `/api/net/uptime` | Website status (final URL, status, cert) |
| GET | `/api/net/proxy` | Web proxy (12 MiB decoded cap, `CSP: sandbox` on every response) |
| GET | `/api/net/redirects` | URL Expander: every redirect hop (12/min, 16 in flight) |
| GET | `/api/domain/whois` | WHOIS lookup |
| GET | `/api/domain/rdap` | RDAP lookup |
| GET | `/api/domain/dns` | DNS-over-HTTPS proxy |
| GET | `/api/domain/availability` | Domain availability check |
| POST | `/api/domain/ai-suggest` | AI domain name suggestions |
| GET | `/api/health` | Health check |

---

## `lib/` modules

| File | Role |
|------|------|
| `rate-limit.js` | `makeRateLimiter({ windowMs, max, message })` → `.middleware` / `.allow(key)` |
| `safe-fetch.js` | SSRF-safe outbound HTTP — **every** request to a user-influenced address |
| `proxy-rewrite.js` | HTML/CSS rewriting for `/api/net/proxy` (linear-time patterns only) |
| `redirects-route.js` | `makeRedirectsHandler({ fetcher, maxInFlight, traceOpts })` for `/api/net/redirects` |

### `safe-fetch.js`

Each address is validated at **connect time**, on the DNS answer the socket actually uses
(a custom `lookup` on `node:http`/`node:https`, `agent: false`, no `fetch`). A host whose
answer contains ANY non-public address is refused (`ERR_SSRF_BLOCKED`). IP literals are
classified directly (Node never calls `lookup` for them). The byte cap counts **decoded**
bytes (gzip/deflate/br).

| Export | Purpose |
|--------|---------|
| `isPublicIp(ip)` | The one classifier. IPv6 is an allowlist (`2000::/3` minus Teredo/doc; NAT64, 6to4 and mapped addresses decoded to their IPv4) |
| `normalizeUserUrl(raw)` | → `{ url, userinfo }`; adds `https://`, http(s) only, strips `user:pw@` and reports it. Throws `SafeFetchError` (`ERR_BAD_URL`, `ERR_UNSUPPORTED_PROTOCOL`) |
| `safeRequest(url, { method, headers, timeoutMs, maxBytes, readBody, truncate, signal })` | One hop, no redirects → `{ status, headers, body, remoteAddress, url }` |
| `fetchFollow(url, { headers, maxBytes, maxRedirects, totalTimeoutMs, signal })` | 3xx followed, each hop guarded, body read on the final hop only (the proxy) |
| `traceRedirects(url, { maxHops, hopTimeoutMs, totalTimeoutMs, signal })` | Every hop: 3xx, `Refresh:`, meta refresh; JS redirects reported, never followed → `{ start, hops, final, stop, stopDetail, jsRedirectHint, totalMs }` |
| `certInfo(url, ip)` | TLS to the **pinned** IP with SNI = hostname → `{ validTo, daysLeft, issuer }` or `null` |
| `resolvePublicTarget(host, { family })` | → a validated public IP, for raw sockets and child processes (portcheck, ping, traceroute) |
| `guardedLookup` | The `lookup` hook itself |
| `createSafeFetcher({ classify, resolve, userAgent })` | Factory — the test seam (below) |
| `SafeFetchError`, `PROXY_UA`, `parseRefresh`, `findMetaRefresh`, `findTitle`, `findJsRedirect` | Error class, UA string, pure parsers |

**Test seam.** The module-level functions use the real policy. A test builds its own
fetcher with `createSafeFetcher({ classify: (ip, port) => …, resolve: fakeLookup })`, so it can
allow exactly ONE fixture `127.0.0.1:<port>` (`classify` gets the port) while everything else,
including another port on `127.0.0.1`, still goes through `isPublicIp`. There is deliberately
**no env var or global** that turns the guard off.
