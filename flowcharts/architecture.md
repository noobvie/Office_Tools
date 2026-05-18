# Office Tools — System Architecture

## How everything connects

```
Browser
  │
  ├── index.html / tools/*   → 100% local, no backend
  │
  ├── pages/donate.html      → static page (Grin address from config.js)
  │
  └── yt-downloader          → fetch /yt-api/...
          │                           │
          ▼                           ▼
       NGINX :443 / :80
          │                           │
          │ /pay-api/*                │ /yt-api/*
          ▼                           ▼
   Node.js :3001              yt-server :9000
   office-tools-server.js     yt-dlp proxy
          │
          ├── POST /api/tools/s        → SQLite tools.db
          ├── GET  /api/tools/s/:code  → SQLite tools.db
          ├── POST /api/tools/p        → SQLite tools.db
          ├── GET  /api/tools/p/:code  → SQLite tools.db
          ├── POST /api/tools/f        → SQLite tools.db + disk
          ├── GET  /api/tools/f/:code  → SQLite tools.db + disk
          ├── GET  /api/resolve        → dns.resolve4/resolve6
          ├── GET  /api/portcheck      → TCP probe
          ├── GET  /api/net/ping       → SSE stream (spawn ping)
          ├── GET  /api/net/traceroute → SSE stream (spawn traceroute)
          ├── GET  /api/net/ptr        → dns.reverse()
          ├── GET  /api/domain/whois   → whois npm package
          ├── GET  /api/domain/rdap    → rdap.org
          ├── GET  /api/domain/dns     → Cloudflare DoH
          ├── GET  /api/domain/availability → rdap.org / DoH
          └── POST /api/domain/ai-suggest  → Gemini API
```

---

## nginx URL routing

| Path | Destination |
|------|-------------|
| `/` | Static files `/var/www/office-tools/` |
| `/pay-api/*` | Node.js :3001 |
| `/yt-api/*` | yt-server :9000 |
| `/backend/` | 403 DENIED |
| `*.env` `*.sh` `*.md` | 403 DENIED |
