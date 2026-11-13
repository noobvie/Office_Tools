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
│   │   ├── conf.d/00-office-tools-http.conf ← http level: limit zones, Referer map,
│   │   │                                      office_tools_noquery log_format (sorts
│   │   │                                      before the vhosts that use them)
│   │   └── office-tools/                  ← snippets included inside each server block
│   │       ├── realip.conf                ← Cloudflare ranges → real visitor $remote_addr
│   │       ├── security-headers.conf      ← HSTS, nosniff, X-Frame-Options, …
│   │       ├── csp-static.conf            ← CSP for static-file locations only (not the APIs)
│   │       ├── limits-tools-api.conf      ← limit_req/limit_conn in the /tools-api/ locations
│   │       └── limits-yt-api.conf         ← limit_req in the /yt-api/ location
│   │
│   ├── letsencrypt/live/<domain>/
│   │   ├── fullchain.pem              ← SSL cert (auto-renewed by certbot)
│   │   └── privkey.pem
│   │
│   └── systemd/system/
│       ├── office-tools-{api,cobalt,pot}.service
│       └── office-tools-{api,cobalt,pot}.service.d/10-hardening.conf  ← sandboxing drop-ins
│
├── var/log/nginx/office-tools.access.log  ← site access log, request line without query string
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

Each unit gets `/etc/systemd/system/<unit>.service.d/10-hardening.conf` (`lib/systemd.sh`),
rewritten on every install/update run. The API server gets only `ProtectSystem=full`,
`PrivateTmp=yes`, `TasksMax=512`: the seccomp-based settings would imply `NoNewPrivileges`
for a `User=` service, and it runs sendmail (setgid postdrop) and ping. yt-server adds the
Protect*/Restrict*/LockPersonality set and `TasksMax=1024`; the PO-token provider gets that
set without `PrivateTmp` or a task limit. A unit that cannot start inside its sandbox
(exit 226/227/228) has the drop-in removed and runs unhardened, with a warning.

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
    6. if backend exists: npm ci (npm install if ci fails) + restart office-tools-api
    7. SSL cert: skipped if still valid
```
