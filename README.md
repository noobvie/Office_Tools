# Office Tools

68 free, browser-based utilities for everyday office, productivity, and AI development work.
No build step, no framework, no tracking — everything runs locally in your browser.

**Live site:** [https://tools.grin.money/](https://tools.grin.money/)

```bash
git clone https://github.com/noobvie/Office_Tools.git
sudo bash Office_Tools/deploy.sh
```

---

## Tools

### ⏱️ Productivity & Time
| Tool | Description |
|------|-------------|
| Pomodoro Timer | 25-min focus cycles with breaks, session counter and desktop notifications |
| Date Calculator | Date difference, add/subtract days, age calculator, countdown to any date |
| World Calendar | Gregorian, Chinese Lunar (农历), and Islamic Hijri calendars side by side |
| Stopwatch & Timer | Stopwatch with lap times and countdown timer with alarm |
| Time Zone Converter | Convert times between time zones — world clock for 40+ cities |

### ✨ Generators
| Tool | Description |
|------|-------------|
| Password Generator | Secure random passwords — custom length, character sets |
| QR Code Generator | QR codes for URL, text, WiFi, vCard — download PNG |
| UUID Generator | UUID v4 and v7 — single or bulk, one-click copy |
| Random Number Generator | Random integers or decimals in any range — no-duplicates option |
| Lorem Ipsum Generator | Placeholder text by paragraphs, sentences, words, or list items |
| Fake Data Generator | Realistic test data — names, emails, phones, addresses. Download CSV/JSON/**JSONL AI training pairs** |
| Wheel of Names | Animated spinning wheel to randomly pick a winner from your list |

### 📝 PDF & Text
| Tool | Description |
|------|-------------|
| PDF Toolkit | Merge, split, extract pages, reorder with drag-and-drop thumbnails |
| PDF to Text | Extract text per-page, copy or download as .txt / Word .docx |
| Word Counter | Words, characters, sentences, reading time and keyword density |
| Markdown Editor | Live split-pane editor with HTML preview, toolbar and export |
| Text Diff | Side-by-side diff with color-highlighted additions/deletions |
| Typing Speed Test | WPM and accuracy with real-time error tracking |
| Text Case Converter | UPPERCASE, lowercase, Title Case, camelCase, snake_case, kebab-case |
| Notepad | Auto-saving scratch pad with up to 5 named notes in localStorage |

### 🔒 Encoding & Crypto
| Tool | Description |
|------|-------------|
| Base64 Converter | Encode/decode text or files to/from Base64 |
| URL Encoder / Decoder | Percent-encode and decode URLs with diff view |
| Unix Timestamp | Convert Unix timestamps ↔ human-readable dates, live current time |
| Hash Generator | SHA-1/256/384/512 and HMAC from text or files — Web Crypto API, 100% local |
| HTML Entity Encoder | Encode & decode HTML entities — includes entity reference table |
| JWT Decoder | Decode JSON Web Tokens — header, payload, expiry, claims. Fully local |
| Number Base Converter | Convert between binary, octal, decimal, hex — bit-length and ranges |

### 🧮 Calculators
| Tool | Description |
|------|-------------|
| Percentage Calculator | X% of Y · X is what % of Y · percentage change |
| Aspect Ratio Calculator | Find missing dimension from ratio — common presets |
| Unit Converter | Length, weight, temperature, volume, area, speed, data — all results at once |
| Loan Calculator | Monthly payment, total interest, and amortization schedule |
| Tip Calculator | Tip and bill split — quick buttons for 10%–25%, per-person total |
| Number to Words | Spell out any number in English — ordinal and currency modes |

### 💻 Development
| Tool | Description |
|------|-------------|
| JSON Editor | Validate, format, minify JSON with syntax highlighting and tree view |
| CSV ↔ JSON | Convert CSV and JSON — table preview, file upload, download, **JSONL output** |
| Crontab Explainer | Parse cron expressions into plain English — next 10 run times |
| Regex Tester | Live regex match highlighting with capture groups, flag toggles, **named group explainer** |
| SQL Formatter | Beautify and minify SQL — uppercase keywords, configurable indent |
| File Compressor | Create ZIP archives or extract ZIPs — 100% in your browser |
| AI Token Counter | Estimate token count and API cost for GPT-4, Claude, Llama, Gemini — context window usage bar |
| AI Prompt Template Builder | Write prompts with `{{variable}}` placeholders, fill in, preview, save to browser |
| AI JSON Schema Builder | Auto-generate JSON Schema from any JSON or build visually — export for OpenAI/Anthropic tool calling |

### 🌐 Network & Security
| Tool | Description |
|------|-------------|
| Currency & Crypto | 40+ currencies + BTC/ETH/XMR/GRIN with live rates |
| What Is My IP? | Public IP, ISP, country, city, coordinates, IPv6 status |
| IP Location Lookup | IPv4/IPv6/domain — country, city, ISP, ASN, VPN/proxy detection, map |
| Campaign URL Builder | Build UTM-tagged URLs for Google Analytics with QR code |
| CSR Decoder | Decode a CSR — subject, key size, SANs, fingerprints. Fully local |

### 🖼️ Media
| Tool | Description |
|------|-------------|
| Image Converter | Convert HEIC/HEIF → JPG/PNG/WebP, compress, resize with aspect-ratio lock |
| Color Converter | HEX, RGB, HSL, HSV, CMYK — live preview, shades, named colors |
| Contrast Checker | WCAG AA/AAA contrast ratios for color pairs — live preview |
| Palette Extractor | Upload an image to extract dominant colors as HEX swatches |
| Screenshot Beautifier | Gradient backgrounds, padding, shadows, rounded corners — download PNG |
| Character Map | Browse and copy symbols, arrows, math, currency, Greek and emoji |
| YouTube Downloader | Download YouTube videos as MP4 or audio as MP3, including playlists |
| Speech & Voice | Transcribe mic or audio files to text (EN/FR/ES, Whisper AI) · Text to speech |
| Photo Editor | Remove backgrounds (AI), resize for social media, color adjust, add text, replace colors |

### 📤 Share
| Tool | Description |
|------|-------------|
| URL Shortener | Short links with optional custom alias and expiry — self-hosted |
| Pastebin | Share text/code with syntax label, expiry, and burn-after-read |
| File Share | Upload .zip/.tar/.rar (up to 1 GB) and share a download link |

### 🎮 Relax
| Tool | Description |
|------|-------------|
| 2048 | Slide and merge tiles to reach 2048. Undo, best score, swipe on mobile |
| Sudoku | 9×9 Sudoku — Easy / Medium / Hard, pencil mode, timer, check and solve |
| Gomoku | 5-in-a-row on a 15×15 board. Heuristic AI or two-player local |
| Memory Match | Flip emoji cards to find matching pairs — 3 grid sizes, star rating |
| Chess | Full-rules chess (castling, en passant, promotion) vs AI or friend |
| Simon Says | Watch the color/sound sequence and repeat it — grows each round |
| Number Memory | Memorize a number before it vanishes, then type it back — gets longer |
| Visual Memory | Recall which grid squares were highlighted — grid expands each round |
| Word Memory | Study a word list, then identify which words you actually saw |

---

## Architecture

```
Office_Tools/
├── index.html                  ← Hub page — tool grid, search, category filter
├── sitemap.xml                 ← Auto-patched with real domain on deploy
├── css/style.css               ← Shared styles, dark/light/matrix themes
├── js/
│   ├── config.js               ← Grin payment server URL, Grin wallet address
│   └── common.js               ← Shared nav, theme toggle, copy utilities
├── pages/
│   └── donate.html             ← Grin donation page (TOR / Slatepack / Invoice)
├── backend/
│   ├── grin-payment-server.js  ← Node.js/Express — Grin donations + SQLite tools API
│   ├── package.json
│   └── .env.example
├── yt-server/                  ← Node.js yt-dlp proxy (YouTube download backend)
└── tools/<tool-name>/index.html
```

---

## Tech Stack

- **Frontend:** HTML / CSS / Vanilla JS — no framework, no build step
- **Backend (optional):** Node.js + Express — Grin donations, URL shortener, Pastebin, File Share (SQLite)
- **YouTube backend:** Node.js + yt-dlp + ffmpeg (systemd service, port 9000)
- **Crypto donations:** Grin wallet — two tmux sessions: `donate_grin_tor` (Foreign API :3415, `grin-wallet listen`) + `donate_grin_slatepack` (Owner API :3420, `grin-wallet owner_api`) + watchdog cron
- **AI (browser-only):** `@xenova/transformers` Whisper-tiny (Speech→Text) · `@imgly/background-removal` (Photo Editor)

The frontend works fully without the backend. The backend is only needed for URL Shortener, Pastebin, File Share, and Grin donations.

---

## Production Deployment

Supports **Debian · Ubuntu · AlmaLinux · Rocky Linux · CentOS Stream**.

| Option | What it does |
|--------|-------------|
| 1) Install / Update | UTC timezone · OS packages · nginx · certbot · Node.js 20 · yt-dlp (pip3) · ffmpeg · pull latest code · weekly auto-update cron |
| 2) Add Domain | Domain + Let's Encrypt SSL · nginx HTTPS config · sitemap.xml patching · optional Node.js backend |
| 3) Remove / Switch | Remove nginx vhost + SSL cert, or switch to a new domain |
| 4) Update from Repo | Pull any branch, sync frontend + backend, update yt-dlp binary, restart services |
| 5) Admin Tasks | Service status · restart all · list URLs/ports · backup SQLite DB · clean logs · purge temp · update yt-dlp |

**Security:** HSTS · TLS 1.2/1.3 · security headers · `microphone=(self)` for Speech & Voice · gzip · `client_max_body_size 1100M`

**Server layout:**
```
/var/www/office-tools/        ← frontend (sitemap.xml patched with real domain)
/opt/office-tools/repo/       ← git repo
/opt/office-tools/backend/    ← Node.js server + .env
/opt/office-tools/data/       ← SQLite DB (tools.db) + file uploads
/opt/office-tools/yt-server/  ← yt-dlp Node.js server
/opt/office-tools/cmdgrinwallet/ ← grin-wallet binary + config + wallet_data/
/opt/office-tools/data/.temp  ← wallet passphrase (plain text, chmod 640, root:grin)
/var/log/office-tools/        ← deploy logs
```

---

## Grin Wallet Setup

Two tmux sessions are managed by `deploy_grinwallet.sh` — no systemd required:

| Session | Command | Port | Purpose |
|---------|---------|------|---------|
| `donate_grin_tor` | `grin-wallet listen` | 3415 | Foreign API — TOR direct-send + `receive_tx` |
| `donate_grin_slatepack` | `grin-wallet owner_api` | 3420 | Owner API — invoice, finalize, slatepack encode/decode |

```bash
sudo bash deploy_grinwallet.sh
```

| Option | What it does |
|--------|-------------|
| 1) Integrate Grin Wallet | Download binary · init or recover wallet · configure node · save passphrase |
| 2) Manage Listeners | Start/Stop/Restart each tmux session independently · view wallet log |
| 3) Listener Settings | Re-save passphrase · auto-start · watchdog · nginx rate limit |
| 3 → 2) Auto-start on reboot | Adds `@reboot` cron entries for both sessions |
| 3 → 4) Watchdog cron | Checks port 3415 every 30 min · restarts TOR listener if down · logs to `grin-watchdog.log` |
| 3 → 7) nginx rate limit | Enables 20 req/min per IP on `/pay-api/api/donate/*` (burst 3) |

**Donation methods on `pages/donate.html`:**
- **Method 1 — TOR direct send:** sender runs `grin-wallet send` over TOR directly to the server's onion address. Requires TOR.
- **Method 2 — Slatepack:** sender generates a slatepack, pastes it here; server calls `receive_tx` and returns a response slatepack for the sender to finalize. No TOR required.
- **Method 3 — Invoice:** server issues an invoice slatepack; sender pays it with `grin-wallet pay`; server finalizes automatically. No TOR required.

The donate page badge checks port 3415 via the Node.js backend (`/api/wallet/status`). The watchdog (option 11) handles automatic recovery if the TOR listener goes down.

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
