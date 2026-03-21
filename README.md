# Office Tools

56 free, browser-based utilities for everyday office and productivity work.
No build step, no framework, no tracking — everything runs locally in your browser.

**Live site:** [https://github.com/noobvie/Office_Tools](https://github.com/noobvie/Office_Tools)

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
| Fake Data Generator | Realistic test data — names, emails, phones, addresses. Download CSV/JSON |
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
| CSV ↔ JSON | Convert CSV and JSON — table preview, file upload, download |
| Crontab Explainer | Parse cron expressions into plain English — next 10 run times |
| Regex Tester | Live regex match highlighting with capture groups and flag toggles |
| SQL Formatter | Beautify and minify SQL — uppercase keywords, configurable indent |
| File Compressor | Create ZIP archives or extract ZIPs — 100% in your browser |

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

---

## Architecture

```
Office_Tools/
├── index.html                  ← Hub page — tool grid, search, category filter
├── sitemap.xml                 ← Auto-patched with real domain on deploy
├── css/style.css               ← Shared styles, dark/light/matrix themes
├── js/
│   ├── config.js               ← PocketBase URL, Grin payment server URL
│   ├── common.js               ← Shared nav, theme toggle, utilities
│   └── auth.js                 ← Login/register/session state (PocketBase SDK)
├── auth/                       ← Login, register, dashboard, upgrade pages
├── admin/index.html            ← Admin dashboard
├── backend/
│   ├── grin-payment-server.js  ← Node.js/Express — Grin payments + SQLite tools API
│   ├── package.json
│   └── .env.example
├── yt-server/                  ← Node.js yt-dlp proxy (YouTube download backend)
└── tools/<tool-name>/index.html
```

---

## Tech Stack

- **Frontend:** HTML / CSS / Vanilla JS — no framework, no build step
- **Backend (optional):** PocketBase (auth, admin UI) · Node.js + Express (Grin payments, URL shortener, Pastebin, File Share via SQLite)
- **YouTube backend:** Node.js + yt-dlp + ffmpeg (systemd service, port 9000)
- **Crypto payments:** Grin Wallet via Owner API v3
- **AI (browser-only):** `@xenova/transformers` Whisper-tiny (Speech→Text) · `@imgly/background-removal` (Photo Editor)

The frontend works fully without the backend. Auth and Pro features are opt-in.

---

## Production Deployment

```bash
git clone https://github.com/noobvie/Office_Tools.git
sudo bash Office_Tools/deploy.sh
```

Supports **Debian · Ubuntu · AlmaLinux · Rocky Linux · CentOS Stream**.

| Option | What it does |
|--------|-------------|
| 1) Install / Update | UTC timezone · OS packages · nginx · certbot · Node.js 20 · yt-dlp · ffmpeg · pull latest code |
| 2) Add Domain | Domain + Let's Encrypt SSL · nginx HTTPS config · sitemap.xml domain patching · optional backend |
| 3) Remove / Switch | Remove nginx vhost + SSL cert, or switch to a new domain |
| 4) Set / Reset Admin | Create or update PocketBase superuser account |
| 5) Update from Repo | Pull any branch, sync frontend + backend, restart services |
| 6) Admin Tasks | Service status · restart all · list URLs/ports · backup/restore DB · clean logs · purge temp |
| DEL) Delete | Remove all services, configs, certs, and directories |

**Security:** HSTS · TLS 1.2/1.3 · security headers · `microphone=(self)` for Speech & Voice · gzip · `client_max_body_size 1100M`

**Server layout:**
```
/var/www/office-tools/        ← frontend (sitemap.xml patched with real domain)
/opt/office-tools/repo/       ← git repo
/opt/office-tools/backend/    ← Node.js server + .env
/opt/office-tools/pocketbase/ ← PocketBase binary + data
/opt/office-tools/yt-server/  ← yt-dlp Node.js server
/opt/office-tools/data/       ← SQLite DB + file uploads
/opt/office-tools/backups/    ← PocketBase database backups
/var/log/office-tools/        ← deploy logs
```

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
