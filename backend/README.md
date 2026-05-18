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

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server listen port |
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
location /pay-api/ {
    proxy_pass http://127.0.0.1:3001/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

Then update `js/config.js`:
```js
API_SERVER_URL: 'https://yourdomain.com/pay-api',
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
| GET | `/api/domain/whois` | WHOIS lookup |
| GET | `/api/domain/rdap` | RDAP lookup |
| GET | `/api/domain/dns` | DNS-over-HTTPS proxy |
| GET | `/api/domain/availability` | Domain availability check |
| POST | `/api/domain/ai-suggest` | AI domain name suggestions |
| GET | `/api/health` | Health check |
