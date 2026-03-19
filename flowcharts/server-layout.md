# Office Tools — Server Layout After Deployment

## What `deploy.sh` creates on the server

```
/
├── var/
│   ├── www/
│   │   └── office-tools/              ← nginx serves this directory (public web root)
│   │       ├── index.html             ← tool hub
│   │       ├── css/
│   │       │   └── style.css
│   │       ├── js/
│   │       │   ├── config.js          ← patched by deploy.sh with your domain URLs
│   │       │   ├── common.js
│   │       │   └── auth.js
│   │       ├── auth/
│   │       │   ├── login.html
│   │       │   ├── register.html
│   │       │   ├── dashboard.html
│   │       │   └── upgrade.html
│   │       ├── admin/
│   │       │   └── index.html
│   │       └── tools/
│   │           ├── aspect-ratio/index.html
│   │           ├── base64-converter/index.html
│   │           ├── color-converter/index.html
│   │           ├── contrast-checker/index.html
│   │           ├── crontab/index.html
│   │           ├── csv-json/index.html
│   │           ├── currency/index.html
│   │           ├── date-calculator/index.html
│   │           ├── fake-data/index.html
│   │           ├── hash-generator/index.html
│   │           ├── json-editor/index.html
│   │           ├── markdown-editor/index.html
│   │           ├── my-ip/index.html
│   │           ├── palette-extractor/index.html
│   │           ├── password-generator/index.html
│   │           ├── percentage-calculator/index.html
│   │           ├── pomodoro/index.html
│   │           ├── qr-generator/index.html
│   │           ├── random-number/index.html
│   │           ├── screenshot-beautifier/index.html
│   │           ├── text-diff/index.html
│   │           ├── typing-speed/index.html
│   │           ├── unix-timestamp/index.html
│   │           ├── url-encoder/index.html
│   │           ├── utm-builder/index.html
│   │           ├── uuid-generator/index.html
│   │           ├── wheel-of-names/index.html
│   │           └── word-counter/index.html
│   │
│   └── log/
│       └── office-tools/
│           ├── deploy_20260319_120000.log   ← per-run deploy log
│           └── deploy_20260319_130000.log
│
├── opt/
│   └── office-tools/
│       ├── deploy.conf                ← saved config (domain, email, passwords)
│       │                                 skips re-prompting on redeploy
│       │
│       ├── repo/                      ← git clone of github.com/noobvie/Office_Tools
│       │   ├── deploy.sh              ← run this to redeploy: sudo bash /opt/office-tools/repo/deploy.sh
│       │   ├── index.html
│       │   ├── backend/
│       │   │   ├── grin-payment-server.js
│       │   │   ├── package.json
│       │   │   ├── pb_hooks/main.pb.js
│       │   │   └── pb_schema.json
│       │   └── ...
│       │
│       ├── backend/                   ← Node.js payment server (runtime)
│       │   ├── grin-payment-server.js
│       │   ├── node_modules/
│       │   ├── package.json
│       │   └── .env                  ← secrets (NOT in git): PB credentials, Grin wallet pass
│       │
│       └── pocketbase/
│           ├── pocketbase             ← binary (downloaded by deploy.sh)
│           ├── pb_hooks/
│           │   └── main.pb.js         ← server-side hooks (cron, welcome email)
│           └── pb_data/
│               ├── data.db            ← SQLite: users, subscriptions, grin_payments
│               └── logs/
│
├── etc/
│   ├── nginx/
│   │   ├── sites-available/
│   │   │   └── office-tools          ← nginx config written by deploy.sh
│   │   └── sites-enabled/
│   │       └── office-tools          ← symlink to sites-available/office-tools
│   │
│   ├── letsencrypt/
│   │   └── live/
│   │       └── tools.example.com/
│   │           ├── fullchain.pem      ← SSL certificate (auto-renewed by certbot)
│   │           └── privkey.pem
│   │
│   └── systemd/system/
│       ├── office-tools-pb.service    ← PocketBase systemd service
│       └── office-tools-pay.service   ← Node.js payment server systemd service
│
└── usr/bin/
    ├── nginx
    ├── certbot
    └── node
```

---

## What is NOT served publicly

These paths are blocked in nginx (`deny all; return 404`):

| Path | Why blocked |
|------|-------------|
| `/backend/` | Source code lives in repo but must not be accessible |
| `*.env` | Secrets |
| `*.sh` | Shell scripts |
| `*.json` | Schema, package files |
| `*.md` | Documentation |
| `/.*` (dot files) | Hidden files, `.git`, etc. |

The `backend/` folder is excluded entirely from the web root sync by `deploy.sh` using `rsync --exclude=backend/`.

---

## Systemd services

```
office-tools-pb.service
  ExecStart: /opt/office-tools/pocketbase/pocketbase serve --http=127.0.0.1:8090
  Listens:   127.0.0.1:8090   (localhost only — not exposed to internet)
  Data:      /opt/office-tools/pocketbase/pb_data/

office-tools-pay.service
  ExecStart: node /opt/office-tools/backend/grin-payment-server.js
  Listens:   127.0.0.1:3001   (localhost only — not exposed to internet)
  Env file:  /opt/office-tools/backend/.env
```

Both services are localhost-only. All external access goes through nginx.

---

## Ports summary

| Port | Service | Exposed? |
|------|---------|----------|
| 80   | nginx (HTTP → HTTPS redirect) | Yes, public |
| 443  | nginx (HTTPS) | Yes, public |
| 8090 | PocketBase | No, localhost only |
| 3001 | Node.js payment server | No, localhost only |
| 3420 | Grin Wallet Owner API | No, localhost only |

---

## .env file contents (backend/.env)

```
# PocketBase connection (internal)
PB_URL=http://127.0.0.1:8090
PB_ADMIN_EMAIL=admin@example.com
PB_ADMIN_PASSWORD=your-pb-admin-password

# Grin Wallet Owner API
GRIN_OWNER_URL=http://127.0.0.1:3420/v3/owner
GRIN_WALLET_PASS=your-wallet-password

# CORS — must match your domain
CORS_ORIGINS=https://tools.example.com

# Payment expiry window
PAYMENT_EXPIRY_MINUTES=30

# Plan prices in nanogrin (1 GRIN = 1,000,000,000 nanogrin)
PLAN_PRO_MONTHLY_NANOGRIN=10000000000
PLAN_PRO_YEARLY_NANOGRIN=100000000000
PLAN_LIFETIME_NANOGRIN=500000000000
```

---

## Redeploy workflow

```
[on your local machine]
  git add -A && git commit -m "..." && git push

[on the server]
  sudo bash /opt/office-tools/repo/deploy.sh

  What redeploy does:
    1. git pull (gets latest changes)
    2. rsync frontend to /var/www/office-tools/ (excludes backend/, .git)
    3. patch js/config.js with saved domain (from deploy.conf)
    4. rewrite nginx config
    5. nginx -t && systemctl reload nginx
    6. if backend exists: restart services only (no reinstall)
    7. SSL cert: skipped if still valid
```
