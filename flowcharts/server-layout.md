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
│       │   └── .env                  ← PORT, CORS_ORIGINS
│       │
│       ├── data/
│       │   ├── tools.db              ← SQLite: short_urls, pastes, file_shares
│       │   └── uploads/              ← file share uploads
│       │
│       └── yt-server/               ← yt-dlp Node.js proxy
│           ├── server.js
│           ├── node_modules/
│           └── package.json
│
├── etc/
│   ├── nginx/
│   │   ├── sites-available/office-tools   ← nginx config written by deploy.sh
│   │   └── sites-enabled/office-tools     ← symlink
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

The `backend/` folder is excluded from the web root sync by `rsync --exclude=backend/`.

---

## Systemd services

```
office-tools-api.service
  ExecStart: node /opt/office-tools/backend/office-tools-server.js
  Listens:   127.0.0.1:3001   (localhost only)
  Env file:  /opt/office-tools/backend/.env

office-tools-cobalt.service  (optional — YouTube download backend)
  ExecStart: pnpm start (cobalt API)
  Listens:   127.0.0.1:9000   (localhost only)
```

---

## Ports summary

| Port | Service | Exposed? |
|------|---------|----------|
| 80 | nginx (HTTP → HTTPS redirect) | Yes, public |
| 443 | nginx (HTTPS) | Yes, public |
| 3001 | Node.js API server | No, localhost only |
| 9000 | cobalt yt-server (optional) | No, localhost only |

---

## .env file contents (backend/.env)

```
# CORS — must match your domain
CORS_ORIGINS=https://tools.example.com

# Server port
PORT=3001
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
