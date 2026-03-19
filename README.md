# Office Tools

A collection of 52 free, browser-based utilities for everyday office and productivity work.
No build step, no framework, no tracking — everything runs locally in your browser.

**Live site:** [https://github.com/noobvie/Office_Tools](https://github.com/noobvie/Office_Tools)

---

## Tools

### ⏱️ Productivity & Time
| Tool | Description |
|------|-------------|
| Pomodoro Timer | 25-min focus cycles with short/long breaks, session counter and desktop notifications |
| Date Calculator | Date difference, add/subtract days, precise age calculator, countdown to any date |
| World Calendar | View any month in Gregorian, Chinese Lunar (农历), and Islamic Hijri calendars side by side |
| Stopwatch & Timer | Precise stopwatch with lap times and countdown timer with alarm — accurate to centiseconds |
| Time Zone Converter | Convert times between any two time zones — world clock for 40+ cities |

### ✨ Generators
| Tool | Description |
|------|-------------|
| Password Generator | Secure random passwords — custom length, character sets, exclude ambiguous chars |
| QR Code Generator | QR codes for URL, text, WiFi, vCard — download as PNG |
| UUID Generator | UUID v4 (random) and v7 (time-ordered) — single or bulk, one-click copy |
| Random Number Generator | Random integers or decimals in any range — bulk generation, no-duplicates option |
| Lorem Ipsum Generator | Generate Lorem Ipsum placeholder text by paragraphs, sentences, words, or list items |

### 📝 Text & Content
| Tool | Description |
|------|-------------|
| Word Counter | Words, characters, sentences, reading time and keyword density — live |
| Markdown Editor | Live split-pane editor with HTML preview, toolbar and export |
| Text Diff | Side-by-side diff of two text blocks with color-highlighted additions/deletions |
| Typing Speed Test | WPM and accuracy with real-time error tracking and grade rating |
| Text Case Converter | Convert to UPPERCASE, lowercase, Title Case, camelCase, snake_case, kebab-case and more |
| Notepad | Auto-saving scratch pad with up to 5 named notes stored in localStorage |

### 🔒 Encoding & Crypto
| Tool | Description |
|------|-------------|
| Base64 Converter | Encode/decode text or files to/from Base64 — supports drag-and-drop |
| URL Encoder / Decoder | Percent-encode and decode URLs with before/after diff view |
| Unix Timestamp | Convert Unix timestamps ↔ human-readable dates. Shows live current timestamp |
| Hash Generator | SHA-1/256/384/512 and HMAC from text or files — uses Web Crypto API, 100% local |
| HTML Entity Encoder | Encode & decode HTML entities (&amp;, &lt;, &gt;) — includes common entity reference table |
| JWT Decoder | Decode JSON Web Tokens — view header, payload, expiry and claims. Fully local |
| Number Base Converter | Convert between binary, octal, decimal, and hexadecimal — shows bit-length and signed/unsigned ranges |

### 🧮 Calculators
| Tool | Description |
|------|-------------|
| Percentage Calculator | What is X% of Y? X is what % of Y? Percentage change between two values |
| Aspect Ratio Calculator | Find missing dimension from ratio. Common presets: 16:9, 4:3, 1:1 |
| Unit Converter | Convert length, weight, temperature, volume, area, speed and data units — all results shown at once |
| Loan Calculator | Monthly payment, total interest, and yearly amortization schedule for any loan |
| Tip Calculator | Calculate tip and split the bill — quick buttons for 10%–25%, per-person total |
| Number to Words | Spell out any number in English — supports up to one quadrillion, with ordinal and currency modes |

### 💻 Development
| Tool | Description |
|------|-------------|
| JSON Editor | Validate, format, minify JSON with syntax highlighting and interactive tree view |
| CSV ↔ JSON | Convert between CSV and JSON — table preview, file upload, download |
| Crontab Explainer | Parse cron expressions into plain English — shows next 10 run times |
| Regex Tester | Live regex match highlighting with capture groups and g/i/m/s flag toggles |
| SQL Formatter | Beautify and minify SQL — uppercase keywords, configurable indent, comma style |

### 🎨 Design
| Tool | Description |
|------|-------------|
| Color Converter | Convert HEX, RGB, HSL, HSV, CMYK — live preview, shades generator, named colors |
| Character Map | Browse and copy special characters, symbols, arrows, math, currency, Greek and emoji |

### 🌐 Network & Web
| Tool | Description |
|------|-------------|
| Currency Converter | 40+ currencies with live exchange rates, popular pairs and quick-convert table |
| What Is My IP? | Public IP, ISP, country, city, coordinates and IPv6 support status |
| IP Location Lookup | Look up any IPv4/IPv6/domain — country, city, ISP, ASN, timezone, VPN/proxy detection, map |
| Campaign URL Builder | Build UTM-tagged URLs for Google Analytics — history and QR code generation |

### ✨ Visual & Design
| Tool | Description |
|------|-------------|
| Screenshot Beautifier | Gradient backgrounds, padding, shadows and rounded corners — download PNG |
| Contrast Checker | WCAG AA/AAA contrast ratios for foreground/background pairs — live preview |
| Palette Extractor | Upload an image to extract dominant colors as HEX swatches and CSS variables |

### 🎲 Fun & Productivity
| Tool | Description |
|------|-------------|
| Fake Data Generator | Realistic test data — names, emails, phones, addresses. Download CSV or JSON |
| Wheel of Names | Animated spinning wheel to randomly pick a winner. Remove or keep winners |

### 📤 Share
| Tool | Description |
|------|-------------|
| URL Shortener | Short links with custom alias and expiry — self-hosted via PocketBase |
| Pastebin | Share text/code snippets with syntax label, expiry, and burn-after-read |
| File Share | Upload .zip/.tar/.rar (up to 1 GB) and share a download link — auto-deleted in max 7 days |

### 🔒 Security & Certificates
| Tool | Description |
|------|-------------|
| CSR Decoder | Decode a Certificate Signing Request — subject, key size & quality, SANs, signature algorithm, SHA-256/SHA-1/MD5 fingerprints |

### 🖼️ Images & PDF
| Tool | Description |
|------|-------------|
| Image Converter | Convert HEIC/HEIF (iPhone) → JPG/PNG/WebP, compress with quality slider, resize with aspect-ratio lock |
| PDF Toolkit | Merge PDFs, extract page ranges, split into individual files, reorder pages with drag-and-drop thumbnails |
| PDF to Text | Extract text from PDF — per-page view, copy to clipboard, download as .txt or Word .docx |

---

## Architecture

```
Office_Tools/
├── index.html                  ← Hub page — tool grid, search, category filter
├── css/
│   └── style.css               ← Shared styles, dark/light/matrix themes
├── js/
│   ├── config.js               ← PocketBase URL, Grin payment server URL
│   ├── common.js               ← Shared nav, theme toggle, utilities
│   └── auth.js                 ← Login/register/session state (PocketBase SDK)
├── auth/
│   ├── login.html
│   ├── register.html
│   ├── dashboard.html          ← User account + subscription status
│   └── upgrade.html            ← Pro upgrade — Grin payment flow
├── admin/
│   └── index.html              ← Admin dashboard (PocketBase admin credentials)
├── backend/
│   ├── grin-payment-server.js  ← Node.js/Express — Grin invoice creation & finalization
│   ├── package.json
│   ├── .env.example
│   ├── pb_schema.json          ← PocketBase collection definitions
│   ├── pb_hooks/main.pb.js     ← PocketBase server-side hooks
│   └── README.md               ← Backend setup guide
└── tools/
    └── <tool-name>/
        └── index.html          ← One self-contained HTML file per tool
```

Each tool lives in its own folder under `tools/` with a self-contained `index.html`.
Shared CSS and JS are loaded from the root `css/` and `js/` folders.

---

## Tech Stack

### Frontend
- **HTML / CSS / Vanilla JS** — no framework, no build step
- External libraries loaded via CDN where needed (qrcode.js, marked.js, PapaParse, diff.js, cronstrue)
- Deploys to GitHub Pages, Netlify, or Cloudflare Pages as-is

### Backend (optional — for auth and Pro features)
| Component | Role |
|-----------|------|
| [PocketBase](https://pocketbase.io) | Auth, database, REST API, admin UI |
| Node.js + Express | Grin payment server — invoice creation and finalization |
| Grin Wallet | Crypto payment receiver via Owner API v3 |

The frontend works fully without the backend. Auth and Pro features are opt-in.

---

## Local Development

```bash
git clone https://github.com/noobvie/Office_Tools.git
cd Office_Tools

# Option A — Python (no install needed on most systems)
python3 -m http.server 8181

# Option B — Node
npx serve .

# Then open: http://localhost:8181
```

No build step, no `npm install`, no environment variables required for the frontend.

---

## Production Deployment

### Deploy Manager (interactive menu)

`deploy.sh` is a menu-driven deployment manager. Supports **Debian · Ubuntu · AlmaLinux · Rocky Linux · CentOS Stream**.

```bash
git clone https://github.com/noobvie/Office_Tools.git
sudo bash Office_Tools/deploy.sh
```

On launch it detects the OS, shows current status, and presents a menu:

```
  1)    Install / Update    — packages · OS · pull latest code
  2)    Add Domain          — configure domain · SSL · backend
  3)    Remove / Switch     — remove or change active domain
  4)    Update from Repo    — pull specific branch, restart services
  DEL)  Delete              — permanently remove Office Tools
  0)    Exit
```

#### Option 1 — Install / Update

| Action | Detail |
|--------|--------|
| Update OS packages | `apt upgrade` (Debian/Ubuntu) or `dnf upgrade` (AlmaLinux/Rocky) |
| Install packages | nginx · certbot · python3-certbot-nginx · git · curl · Node.js 20 |
| EPEL (RHEL only) | Installs EPEL release for certbot availability |
| SELinux (RHEL only) | Sets `httpd_can_network_connect` for nginx → PocketBase proxying |
| Firewall (RHEL only) | Opens HTTP + HTTPS via `firewall-cmd` if firewalld is active |
| Pull / clone repo | `git pull` if repo exists, `git clone` if first run |
| Sync frontend | `rsync` → `/var/www/office-tools/`, patches domain placeholders |
| Restart services | Reloads nginx, restarts backend services if configured |

#### Option 2 — Add / Configure Domain

Prompts for domain name and Let's Encrypt email, then:
1. Syncs frontend and patches all `yourdomain.com` placeholders in HTML + `config.js`
2. Writes HTTP nginx config and runs `certbot --nginx` for SSL
3. Overwrites config with hardened HTTPS block (HSTS, TLS 1.2/1.3, security headers, gzip, `client_max_body_size 1100M`)
4. Optionally sets up PocketBase + Grin payment server as systemd services (first run only)

All settings are saved to `/opt/office-tools/deploy.conf` for future runs.

#### Option 3 — Remove / Switch Domain

- **Remove:** deletes nginx vhost config + Let's Encrypt certificate for the current domain
- **Switch:** removes old domain config, then runs a full Option 2 setup for a new domain

#### Option 4 — Update from Repo

Pull the latest code from GitHub — optionally switching to a different branch:
1. Fetches remote branch list and lets you choose by number or name
2. Checks out the chosen branch and pulls latest commits
3. Re-syncs frontend to `/var/www/office-tools/` (patches domain placeholders)
4. Re-syncs backend files and restarts services (if already configured)

Useful for updating after a `git push`, or for testing a feature branch on the live server.

```bash
sudo bash /opt/office-tools/repo/deploy.sh   # choose option 4
```

#### DEL — Delete

Type `del` at the menu prompt. Hands off to `undeploy.sh` which prompts for confirmation and removes:
services · systemd unit files · nginx config · SSL certificate · all directories

**Server layout after deploy:**

```
/var/www/office-tools/        ← frontend (nginx serves directly)
/opt/office-tools/repo/       ← git repo
/opt/office-tools/backend/    ← Node.js payment server + .env
/opt/office-tools/pocketbase/ ← PocketBase binary + data
/opt/office-tools/deploy.conf ← saved domain + settings
/var/log/office-tools/        ← per-run deploy logs
```

**Update / redeploy after a git push:**

```bash
sudo bash /opt/office-tools/repo/deploy.sh   # option 1 = full update (OS + packages + pull)
                                              # option 4 = repo-only update (choose branch)
```

---

### After deploy — PocketBase first-time setup

1. Open `https://your-domain.com/pb-api/_/`
2. Create your admin account
3. Go to **Settings → Import Collections** → paste contents of `backend/pb_schema.json`
4. Copy `backend/pb_hooks/main.pb.js` to `/opt/office-tools/pocketbase/pb_hooks/`
5. Restart PocketBase: `systemctl restart office-tools-pb`

---

### Manual backend setup

See [backend/README.md](backend/README.md) for manual instructions covering PocketBase,
the Grin payment server, nginx config and systemd services.

---

## Contributing

1. Each tool must work **fully offline** (no required network calls, except Network & Web tools)
2. No frameworks — vanilla HTML/CSS/JS only
3. Each tool page must include the shared nav header and link back to the hub
4. All tools must be **mobile-responsive**
5. No cookies, no analytics, no localStorage abuse

---

## License

MIT — free to use, fork, and modify.
