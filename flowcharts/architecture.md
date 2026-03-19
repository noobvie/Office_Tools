# Office Tools — System Architecture

## How everything connects

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                            USER'S BROWSER                                   ║
║                                                                              ║
║  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐ ║
║  │  index.html  │  │ auth/login   │  │auth/dashboard│  │ auth/upgrade    │ ║
║  │  (tool hub)  │  │  register    │  │  (my account)│  │ (buy Pro/Grin)  │ ║
║  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └────────┬────────┘ ║
║         │  js/auth.js     │ PocketBase SDK   │ PocketBase SDK    │ fetch    ║
╚═════════╪═════════════════╪══════════════════╪═══════════════════╪══════════╝
          │                 │                  │                   │
          ▼                 ▼                  ▼                   ▼
╔══════════════════════════════════════════════════════════════════════════════╗
║                     NGINX  (HTTPS :443 / HTTP :80 → redirect)               ║
║                                                                              ║
║  URL path       →   Action                                                   ║
║  ─────────────────────────────────────────────────────────────────────────  ║
║  /              →   serve /var/www/office-tools/  (static files)            ║
║  /pb-api/*      →   proxy → PocketBase :8090     (frontend auth & data)     ║
║  /_/*           →   proxy → PocketBase :8090/_/  (admin SPA HTML/JS/CSS)   ║
║  /api/*         →   proxy → PocketBase :8090/api/ (admin SPA API calls)    ║
║  /pay-api/*     →   proxy → Node.js :3001         (Grin payment server)    ║
║  /backend/      →   403 DENIED                                              ║
║  *.env *.sh etc →   403 DENIED                                              ║
╚══════════════════════════════════╤═══════════════════════╤══════════════════╝
                                   │                       │
          ┌────────────────────────┘                       └──────────────┐
          ▼                                                                ▼
╔═════════════════════════════╗                        ╔═══════════════════════════╗
║     POCKETBASE  :8090       ║                        ║  NODE.JS PAYMENT  :3001   ║
║                             ║                        ║  grin-payment-server.js   ║
║  Collections (SQLite DB):   ║◄───────────────────────║                           ║
║  • users                    ║  internal HTTP         ║  POST /api/payment/       ║
║  • subscriptions            ║  (PB admin token)      ║    initiate               ║
║  • grin_payments            ║                        ║  POST /api/payment/       ║
║                             ║                        ║    respond                ║
║  Hooks (pb_hooks/main.pb.js)║                        ║  GET  /api/payment/       ║
║  • on user create →         ║                        ║    status/:id             ║
║    send welcome email       ║                        ║                           ║
║  • cron daily 03:00 →       ║                        ╚══════════════╤════════════╝
║    expire old subscriptions ║                                       │
║  • cron every 15min →       ║                                       │ JSON-RPC
║    expire old payments      ║                                       ▼
║                             ║                        ╔═══════════════════════════╗
╚════════════════╤════════════╝                        ║   GRIN WALLET  :3420      ║
                 │                                     ║   Owner API v3            ║
                 │ SMTP                                ║                           ║
                 ▼                                     ║  open_wallet              ║
        ┌─────────────────┐                            ║  init_send_tx             ║
        │   Email Server  │                            ║  finalize_tx              ║
        │  (welcome mail) │                            ║  post_tx                  ║
        └─────────────────┘                            ╚═══════════════════════════╝
```

---

## Page-by-page: what each page calls

### Public pages (no login required)

| Page | Path | Backend calls |
|------|------|---------------|
| Tool hub | `/` | `GET /pb-api/api/collections/users/auth-refresh` (check session) |
| Any tool | `/tools/<name>/` | None (runs 100% locally in browser) |
| Login | `/auth/login.html` | `POST /pb-api/api/collections/users/auth-with-password` |
| Register | `/auth/register.html` | `POST /pb-api/api/collections/users/records` |

### Authenticated pages (require login)

| Page | Path | Backend calls |
|------|------|---------------|
| Dashboard | `/auth/dashboard.html` | `GET /pb-api/api/collections/subscriptions/records?filter=user=...` |
| Upgrade | `/auth/upgrade.html` | `POST /pay-api/api/payment/initiate` → `POST /pay-api/api/payment/respond` → `GET /pay-api/api/payment/status/:id` |

### Admin pages (require PocketBase superuser)

| Page | Path | What it is |
|------|------|------------|
| Custom admin | `/admin/` | Static HTML page — shows users/subs via `GET /pb-api/api/collections/...` |
| PocketBase admin | `/pb-api/_/` | PocketBase's built-in admin SPA (login with superuser creds) |

---

## Grin payment flow step-by-step

```
auth/upgrade.html                 pay-api (Node.js :3001)          Grin Wallet :3420
       │                                  │                                │
       │  POST /pay-api/api/payment/      │                                │
       │    initiate                      │                                │
       │  { plan, user_token }            │                                │
       │ ────────────────────────────────►│                                │
       │                                  │  open_wallet                   │
       │                                  │ ──────────────────────────────►│
       │                                  │  init_send_tx (create slate)  │
       │                                  │ ──────────────────────────────►│
       │                                  │◄───────────────────────────────│
       │                                  │  save grin_payments record     │
       │                                  │ ──────────► PocketBase :8090   │
       │◄─────────────────────────────────│                                │
       │  { payment_id, slatepack }       │                                │
       │                                  │                                │
       │  [user sends Grin transaction]   │                                │
       │                                  │                                │
       │  POST /pay-api/api/payment/      │                                │
       │    respond                       │                                │
       │  { payment_id, slatepack_resp }  │                                │
       │ ────────────────────────────────►│                                │
       │                                  │  finalize_tx                   │
       │                                  │ ──────────────────────────────►│
       │                                  │  post_tx (broadcast)           │
       │                                  │ ──────────────────────────────►│
       │                                  │  update grin_payments → paid   │
       │                                  │  create subscriptions record   │
       │                                  │ ──────────► PocketBase :8090   │
       │◄─────────────────────────────────│                                │
       │  { success: true }               │                                │
```

---

## PocketBase admin UI: why three nginx locations

The admin UI at `/_/` is a Single-Page App (SPA) built into PocketBase.
It makes two types of requests that need separate nginx routes:

```
Browser requests /_/index.html
       │
       ▼
  location ^~ /_/    ← serves the HTML shell + assets (index-xyz.js, index-xyz.css)
       │  proxy_pass http://127.0.0.1:8090/_/
       │
       ▼
  Browser JS runs, calls /api/collections, /api/admins ...
       │
       ▼
  location ^~ /api/  ← admin SPA API calls (absolute path /api/)
       │  proxy_pass http://127.0.0.1:8090/api/
       │
  (NOT /pb-api/ — that prefix is only for the frontend app)

  location ^~ /pb-api/ ← frontend app calls  (js/auth.js, PocketBase SDK)
       │  proxy_pass http://127.0.0.1:8090/    (strips /pb-api/ prefix)
```

The `^~` prefix on all three stops the static-asset caching rule
`~* \.(css|js|...)$` from intercepting admin SPA JS/CSS files.
