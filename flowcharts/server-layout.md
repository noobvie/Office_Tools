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
│   │       │   └── donate.html        ← Grin donation page
│   │       └── tools/
│   │           └── <tool-name>/index.html  (69 tools)
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
│       │   ├── deploy_grinwallet.sh
│       │   └── ...
│       │
│       ├── backend/                   ← Node.js payment server (runtime)
│       │   ├── grin-payment-server.js
│       │   ├── node_modules/
│       │   ├── package.json
│       │   └── .env                  ← secrets: GRIN_WALLET_BIN, CORS_ORIGINS, etc.
│       │
│       ├── data/
│       │   ├── tools.db              ← SQLite: short_urls, pastes, file_shares
│       │   ├── uploads/              ← file share uploads
│       │   ├── .temp                 ← grin-wallet passphrase (chmod 640, root:grin)
│       │   ├── grin-listen.sh        ← wallet listener wrapper (written by deploy_grinwallet.sh)
│       │   └── grin-watchdog.sh      ← watchdog script (written by deploy_grinwallet.sh)
│       │
│       ├── cmdgrinwallet/            ← grin-wallet installation
│       │   ├── grin-wallet           ← binary (downloaded by deploy_grinwallet.sh)
│       │   ├── grin-wallet.toml      ← config (node selection)
│       │   ├── wallet_data/          ← wallet files (created by grin-wallet init)
│       │   └── grin-wallet.log       ← runtime log
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
│       └── office-tools-pay.service   ← Node.js payment server
│           (office-tools-pb removed — PocketBase no longer used)
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
office-tools-pay.service
  ExecStart: node /opt/office-tools/backend/grin-payment-server.js
  Listens:   127.0.0.1:3001   (localhost only)
  Env file:  /opt/office-tools/backend/.env

office-tools-cobalt.service  (optional — YouTube download backend)
  ExecStart: pnpm start (cobalt API)
  Listens:   127.0.0.1:9000   (localhost only)
```

The grin-wallet listener is NOT a systemd service — it runs in a tmux session
managed by `deploy_grinwallet.sh` with an optional watchdog cron.

---

## Ports summary

| Port | Service | Exposed? |
|------|---------|----------|
| 80 | nginx (HTTP → HTTPS redirect) | Yes, public |
| 443 | nginx (HTTPS) | Yes, public |
| 3001 | Node.js payment server | No, localhost only |
| 3415 | grin-wallet listen (tmux) | No, localhost only |
| 9000 | cobalt yt-server (optional) | No, localhost only |

---

## .env file contents (backend/.env)

```
# Grin wallet binary path
GRIN_WALLET_BIN=/opt/office-tools/cmdgrinwallet/grin-wallet
GRIN_WALLET_FALLBACK=/opt/grin/cmdwallet/mainnet/grin-wallet

# Passphrase — one of:
GRIN_WALLET_PASS_FILE=/opt/office-tools/data/.temp   # recommended
# GRIN_WALLET_PASS=yourpassphrase                    # or plain env var

# Grin wallet listener port (for status check)
GRIN_LISTEN_PORT=3415
GRIN_LISTEN_HOST=127.0.0.1

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
    6. if backend exists: npm install + restart office-tools-pay
    7. SSL cert: skipped if still valid
```

---

## Grin wallet cron entries (root crontab)

```
# Auto-start wallet on reboot (set via deploy_grinwallet.sh option 2 → 7)
@reboot sleep 30 && tmux new-session -d -s donate_grin_wallet ...

# Watchdog — restart wallet if port 3415 down (set via option 2 → 9)
*/30 * * * * bash /opt/office-tools/data/grin-watchdog.sh # grin-watchdog
```
