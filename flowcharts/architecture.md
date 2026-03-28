# Office Tools — System Architecture

## How everything connects

```
Browser
  │
  ├── index.html / tools/*   → 100% local, no backend
  │
  ├── pages/donate.html      → fetch /pay-api/...
  │
  └── yt-downloader          → fetch /yt-api/...
          │                           │
          ▼                           ▼
       NGINX :443 / :80
          │                           │
          │ /pay-api/*                │ /yt-api/*
          ▼                           ▼
   Node.js :3001              yt-server :9000
   grin-payment-server.js     yt-dlp proxy
          │
          ├── GET  /api/wallet/status  → TCP probe 127.0.0.1:3415
          ├── POST /api/donate/receive  → grin-wallet CLI subprocess
          ├── POST /api/donate/invoice  → grin-wallet CLI subprocess
          ├── POST /api/donate/finalize → grin-wallet CLI subprocess
          ├── POST /api/tools/s        → SQLite tools.db
          ├── GET  /api/tools/s/:code  → SQLite tools.db
          ├── POST /api/tools/p        → SQLite tools.db
          ├── GET  /api/tools/p/:code  → SQLite tools.db
          ├── POST /api/tools/f        → SQLite tools.db + disk
          └── GET  /api/tools/f/:id   → SQLite tools.db + disk

grin-wallet listen :3415
  tmux session "donate_grin_wallet"
  managed by deploy_grinwallet.sh
  watchdog cron every 30 min checks port, restarts if stale
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

---

## Tools — backend usage

### No backend required (100% browser-local)

All tools run entirely in the browser. No server calls needed.

Exceptions — these tools call external public APIs directly from the browser:
- **Currency & Crypto** → `open.er-api.com` + `api.coingecko.com`
- **What Is My IP** → `ipify.org` · `icanhazip.com` · `ip-api.com`
- **IP Location** → `ipwho.is`

### Tools that use the Node.js backend (port 3001)

| Tool | Endpoints used |
|------|----------------|
| URL Shortener | `POST /api/tools/s` · `GET /api/tools/s/:code` |
| Pastebin | `POST /api/tools/p` · `GET /api/tools/p/:code` |
| File Share | `POST /api/tools/f` · `GET /api/tools/f/:id/download` |
| Donate — badge | `GET /api/wallet/status` |
| Donate — receive | `POST /api/donate/receive` |
| Donate — invoice | `POST /api/donate/invoice` |
| Donate — finalize | `POST /api/donate/finalize` |

### YouTube Downloader

Uses the yt-server (port 9000) via nginx `/yt-api/` proxy.
The yt-server spawns a `yt-dlp` subprocess and streams the result.

---

## Grin donation flows

### Method 1 — TOR Direct

User wallet connects directly to `grin-wallet listen :3415` over TOR.
No backend involved — pure peer-to-peer.

### Method 2 — Slatepack (You Send)

```
1. User runs: grin-wallet send -d <our_address> <amount>
   → wallet outputs a send slatepack

2. User pastes slatepack into donate.html
   POST /api/donate/receive { slatepack }
   → backend runs: grin-wallet receive -i <file>
   → returns response slatepack

3. User runs: grin-wallet finalize -i response.slatepack
   → broadcasts the transaction
```

### Method 3 — Invoice (We Request)

```
1. User enters amount + their wallet address in donate.html
   POST /api/donate/invoice { amount, address }
   → backend runs: grin-wallet invoice
   → returns invoice slatepack

2. User runs: grin-wallet pay -i invoice.slatepack
   → wallet outputs a payment slatepack

3. User pastes payment slatepack into donate.html
   POST /api/donate/finalize { slatepack }
   → backend runs: grin-wallet finalize
   → broadcasts the transaction
```

---

## Wallet status badge logic

```
donate.html polls every 30s:
  GET /api/wallet/status
    → Node.js does TCP connect to 127.0.0.1:3415 (3s timeout)
    → reachable   : 200 { status: 'ok' }    → green badge "Wallet online"
    → unreachable : 503 { status: 'error' } → red badge   "Wallet offline"

Watchdog cron (every 30 min) — /opt/office-tools/data/grin-watchdog.sh:
  TCP probe 127.0.0.1:3415
    reachable                        → exit, all good
    not reachable, no tmux session   → start fresh tmux session
    not reachable, tmux < 5 min old  → leave it (still initializing)
    not reachable, tmux >= 5 min old → kill stale session, restart
```
