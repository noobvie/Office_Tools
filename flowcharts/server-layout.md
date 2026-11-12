# Office Tools — Server Layout After Deployment

## What `deploy.sh` creates on the server

```
/
├── var/
│   ├── www/
│   │   └── office-tools/              ← nginx serves this (public web root)
│   │       ├── index.html             ← tool hub
│   │       ├── css/style.css
│   │       ├── js/
│   │       │   ├── config.js          ← patched by deploy.sh with domain + server URL
│   │       │   └── common.js
│   │       ├── pages/
│   │       │   └── donate.html        ← Grin donation page (static, no backend)
│   │       └── tools/
│   │           └── <tool-name>/index.html
│   │
│   └── log/
│       └── office-tools/
│           └── deploy_YYYYMMDD_HHMMSS.log
│
├── opt/
│   └── office-tools/
│       ├── deploy.conf                ← saved config (domain, email)
│       │
│       ├── repo/                      ← git clone of Office_Tools repo
│       │   ├── deploy.sh
│       │   └── ...
│       │
│       ├── backend/                   ← Node.js API server (runtime)
│       │   ├── office-tools-server.js
│       │   ├── node_modules/
│       │   ├── package.json
│       │   └── .env                  ← PORT, HOST=127.0.0.1, CORS_ORIGINS, TURN_*
│       │
│       ├── data/
│       │   ├── tools.db              ← SQLite: short_urls, pastes, file_shares
│       │   └── uploads/              ← file share uploads
│       │
│       └── yt-server/               ← yt-dlp Node.js proxy
│           ├── server.js
│           ├── node_modules/
│           ├── package.json
│           └── .env                  ← PORT, HOST=127.0.0.1, operator keys (never rewritten)
│
├── etc/
│   ├── nginx/
│   │   ├── sites-available/office-tools   ← nginx config written by deploy.sh
│   │   ├── sites-enabled/office-tools     ← symlink
│   │   │   (RHEL: conf.d/office-tools.conf instead of the two above)
│   │   └── office-tools/                  ← snippets included inside each server block
│   │       ├── realip.conf                ← Cloudflare ranges → real visitor $remote_addr
│   │       └── security-headers.conf      ← HSTS, nosniff, X-Frame-Options, …
│   │
│   ├── letsencrypt/live/<domain>/
│   │   ├── fullchain.pem              ← SSL cert (auto-renewed by certbot)
│   │   └── privkey.pem
│   │
│   └── systemd/system/
│       └── office-tools-api.service   ← Node.js API server
│
└── usr/bin/
    ├── nginx
    ├── certbot
    └── node
```

---

## What is NOT served publicly

| Path | Why blocked |
|------|-------------|
| `/backend/` | Source code — must not be accessible |
| `*.env` | Secrets |
| `*.sh` | Shell scripts |
| `*.json` | Schema, package files |
| `*.md` | Documentation |
| `/.*` | Hidden files, `.git`, etc. |

The web root sync (`sync_frontend` in `lib/repo.sh`) excludes everything that is not part of
the site — `backend/`, `yt-server/`, `scripts/`, `flowcharts/`, `admin/`, `lib/`, `*.sh`,
`*.md`, `*.json` and the rest of its explicit list — and `--delete-excluded` removes copies
an earlier deploy published.

---

## Systemd services

```
office-tools-api.service
  ExecStart: node /opt/office-tools/backend/office-tools-server.js
  Listens:   127.0.0.1:3001   (localhost only — HOST=127.0.0.1 in .env)
  Env file:  /opt/office-tools/backend/.env

office-tools-cobalt.service  (YouTube download backend)
  ExecStart: node /opt/office-tools/yt-server/server.js
  Listens:   127.0.0.1:9000   (localhost only — HOST=127.0.0.1 in .env)
  Env file:  /opt/office-tools/yt-server/.env

office-tools-pot.service     (bgutil PO-token provider)
  Listens:   *:4416           (no bind option; blocked by ufw only when ufw is active)
```

Both `HOST` keys are added by `env_ensure` on every install/update run when absent; an
operator-set value is kept. Without `HOST` either server binds all interfaces.

---

## Ports summary

| Port | Service | Exposed? |
|------|---------|----------|
| 80 | nginx (HTTP → HTTPS redirect) | Yes, public |
| 443 | nginx (HTTPS) | Yes, public |
| 3001 | Node.js API server | No, localhost only |
| 9000 | yt-server | No, localhost only |
| 4416 | PO-token provider | Listens on all interfaces; firewalled only if ufw is active |
| 3478, 49152–65535/udp | coturn TURN relay (File Drop) | Yes, public |

---

## .env file contents (backend/.env)

```
# CORS — must match your domain
CORS_ORIGINS=https://tools.example.com

# Server port and bind address (loopback: only nginx reaches it)
PORT=3001
HOST=127.0.0.1
```

---

## Redeploy workflow

```
[local machine]
  git add -A && git commit -m "..." && git push

[server]
  sudo bash /opt/office-tools/repo/deploy.sh

  What redeploy does:
    1. git pull (latest changes)
    2. rsync frontend → /var/www/office-tools/  (excludes backend/, .git)
    3. patch js/config.js with saved domain
    4. rewrite nginx config
    5. nginx -t && systemctl reload nginx
    6. if backend exists: npm install + restart office-tools-api
    7. SSL cert: skipped if still valid
```
