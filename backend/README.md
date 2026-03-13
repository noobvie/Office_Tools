# Office Tools — Backend Setup

## Stack

| Component | Role |
|-----------|------|
| [PocketBase](https://pocketbase.io) | Database, Auth, REST API, Admin UI |
| Node.js + Express | Grin payment server (invoice creation + finalization) |
| Grin Wallet | Crypto payment receiver (via Owner API v3) |

---

## 1. PocketBase

### Download & Run

```bash
# Debian/Ubuntu
wget https://github.com/pocketbase/pocketbase/releases/latest/download/pocketbase_linux_amd64.zip
unzip pocketbase_linux_amd64.zip
chmod +x pocketbase

# Start (default: http://localhost:8090)
./pocketbase serve --http=0.0.0.0:8090
```

### First-time Setup

1. Open `http://yourserver:8090/_/` — create admin account
2. Import collections from `pb_schema.json`:
   - Go to **Settings → Import Collections**
   - Paste contents of `pb_schema.json`
3. Copy `pb_hooks/main.pb.js` to your PocketBase `pb_hooks/` directory
4. Configure email (Settings → Mail) for welcome emails

### Run as systemd service

```ini
# /etc/systemd/system/pocketbase.service
[Unit]
Description=PocketBase — Office Tools
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/office-tools/backend
ExecStart=/opt/office-tools/backend/pocketbase serve --http=127.0.0.1:8090
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now pocketbase
```

---

## 2. Grin Payment Server

### Prerequisites

- Node.js ≥ 18
- A running Grin wallet with Owner API enabled (your existing Grin node from the toolkit works)
- PocketBase running

### Setup

```bash
cd backend
cp .env.example .env
# Edit .env with your values
nano .env

npm install
npm start
```

### Enable Grin Wallet Owner API

In your Grin wallet config (`~/.grin/main/.api_secret` or `grin-wallet.toml`):

```toml
[wallet]
owner_api_listen_port = 3420
owner_api_include_foreign = false
```

Start wallet in listening mode:
```bash
grin-wallet owner_api
```

### Run as systemd service

```ini
# /etc/systemd/system/ot-payment.service
[Unit]
Description=Office Tools Grin Payment Server
After=network.target pocketbase.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/office-tools/backend
ExecStart=/usr/bin/node grin-payment-server.js
Restart=on-failure
EnvironmentFile=/opt/office-tools/backend/.env

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now ot-payment
```

---

## 3. Nginx Reverse Proxy (recommended)

Add to your nginx site config:

```nginx
# PocketBase API
location /pb-api/ {
    proxy_pass http://127.0.0.1:8090/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

# Grin payment server
location /pay-api/ {
    proxy_pass http://127.0.0.1:3001/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

Then update `js/config.js`:
```js
PB_URL: 'https://yourdomain.com/pb-api',
GRIN_SERVER_URL: 'https://yourdomain.com/pay-api',
```

---

## 4. Update Frontend Config

Edit `js/config.js` before deploying:

```js
PB_URL: 'https://yourdomain.com',           // or /pb-api if using nginx proxy
GRIN_SERVER_URL: 'https://pay.yourdomain.com',  // or /pay-api
```

---

## Collections Reference

| Collection | Purpose |
|------------|---------|
| `users` | Built-in PocketBase auth |
| `subscriptions` | Active/expired Pro subscriptions |
| `grin_payments` | Grin invoice + transaction records |
| `usage_logs` | Server-side tool usage tracking |

## Admin Dashboard

Available at `/admin/index.html` — log in with your PocketBase admin credentials.

Features:
- User list + search
- Subscription management + manual grant
- Grin payment queue (confirm/expire manually)
- Tool usage analytics
