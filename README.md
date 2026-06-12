# Office Tools

100+ free, browser-based utilities for everyday office, productivity, and AI development work.
No build step, no framework — everything runs locally in your browser.

**Live site:** [https://tools.grin.money/](https://tools.grin.money/) — browse and try every tool there.

```bash
git clone https://github.com/noobvie/Office_Tools.git
sudo bash Office_Tools/deploy.sh
```

---

## Tools

**⏱️ Productivity & Time** — Pomodoro Timer · Date & Time Calculator · World Calendar · Stopwatch & Timer · Time Zone Converter

**✨ Generators** — Password Generator · QR Code Generator · UUID Generator · Random Number Generator · Lorem Ipsum Generator · Fake Data Generator · Wheel of Names · Barcode Generator

**📝 PDF & Text** — PDF Toolkit · PDF to Text · Image to PDF · PDF Enhance & Clean · PDF to Images · Sign PDF · PDF Watermark & Page Numbers · Word Counter · Markdown Editor · Text Diff · Typing Speed Test · Text Case Converter · Notepad · Remove Duplicate Lines & Sort · Markdown ↔ HTML Converter

**🔒 Encoding & Crypto** — Base64 Converter · URL Encoder / Decoder · Unix Timestamp · Hash Generator · HTML Entity Encoder · JWT Decoder · Number Base Converter · Binary ↔ Text Converter · Morse Code Translator · ROT13 & Caesar Cipher

**🧮 Calculators** — Percentage Calculator · Aspect Ratio Calculator · Unit Converter · Loan Calculator · Tip Calculator · Number to Words · BMI Calculator · Age Calculator · Sales Tax & VAT Calculator · Discount Calculator · Compound Interest Calculator · Scientific Calculator · Roman Numeral Converter

**💻 Development** — JSON Editor · CSV ↔ JSON · Crontab Explainer · Regex Tester · SQL Formatter · File Compressor · AI Token Counter · AI Prompt Template Builder · AI JSON Schema Builder · Code Beautifier & Minifier · JSON ↔ YAML Converter · XML Formatter · CSS Gradient Generator · Meta Tag Generator · Open Graph & Twitter Card · Robots.txt Generator · Schema.org JSON-LD Generator · URL Slug Generator · Favicon Generator

**🌐 Network & Security** — Currency & Crypto · What Is My IP? · VPN / IP Leak Test · IP Location Lookup · Campaign URL Builder · CSR Decoder · Port Checker · Domain Checker · Online Ping Test · Online Traceroute · DNS Lookup · Reverse DNS Lookup · IPv6 Analyzer · Subnet Calculator

**🖼️ Media** — Image Converter · Image to Text (OCR) · Image Cropper · Image Upscaler · Image Redaction · Collage & Grid Maker · SVG to PNG · Color Converter · Contrast Checker · Palette Extractor · Color Picker / Eyedropper · EXIF Viewer & Remover · Screenshot Beautifier · Character Map · YouTube Downloader · Speech & Voice · Photo Editor

**📤 Share** — URL Shortener · Pastebin · File Share

**🎮 Relax** — 2048 · Sudoku · Gomoku · Memory Match · Chess · Simon Says · Number Memory · Visual Memory · Word Memory

---

## Architecture

```
Office_Tools/
├── index.html                  ← Hub page — tool grid, search, category filter
├── sitemap.xml                 ← Auto-patched with real domain on deploy
├── css/style.css               ← Shared styles, dark/light/matrix themes
├── js/
│   ├── config.js               ← API server URL, Grin wallet address (for donate page)
│   └── common.js               ← Shared nav, theme toggle, copy utilities
├── pages/
│   └── donate.html             ← Grin showcase page — what Grin is, send address, drop.grin.money link
├── backend/
│   ├── office-tools-server.js  ← Node.js/Express — SQLite tools API + network tools
│   ├── package.json
│   └── .env.example
├── yt-server/                  ← Node.js yt-dlp proxy (YouTube download backend)
└── tools/<tool-name>/index.html
```

---

## Tech Stack

- **Frontend:** HTML / CSS / Vanilla JS — no framework, no build step
- **Backend (optional):** Node.js + Express — URL shortener, Pastebin, File Share (SQLite), network tools
- **YouTube backend:** Node.js + yt-dlp + ffmpeg (systemd service, port 9000)
- **AI (browser-only):** `@xenova/transformers` Whisper-tiny (Speech→Text) · `@imgly/background-removal` (Photo Editor)

The frontend works fully without the backend. The backend is only needed for URL Shortener, Pastebin, File Share, Port Checker, Domain Checker, and Network Toolkit.

---

## Production Deployment

Supports **Debian · Ubuntu · AlmaLinux · Rocky Linux · CentOS Stream**.

| Option | What it does |
|--------|-------------|
| 1) Install / Update | UTC timezone · OS packages · nginx · certbot · Node.js 20 · ffmpeg · cobalt · pull latest code |
| 2) Add Domain | Domain + Let's Encrypt SSL · nginx HTTPS config · sitemap.xml patching · optional Node.js backend |
| 3) Remove / Switch | Remove nginx vhost + SSL cert, or switch to a new domain |
| 5) Update from Repo | Pull any branch, sync frontend + backend, refresh nginx config, restart services |
| 6) Admin Tasks | Service status · restart all · list URLs/ports · backup SQLite DB · clean logs · purge temp · update cobalt |
| DEL) Delete | Permanently remove all Office Tools services, configs, and files from the server |

**Security:** HSTS · TLS 1.2/1.3 · security headers · `microphone=(self)` for Speech & Voice · gzip · `client_max_body_size 1100M`

**Server layout:**
```
/var/www/office-tools/        ← frontend (sitemap.xml patched with real domain)
/opt/office-tools/repo/       ← git repo
/opt/office-tools/backend/    ← Node.js server + .env
/opt/office-tools/data/       ← SQLite DB (tools.db) + file uploads
/opt/office-tools/yt-server/  ← yt-dlp Node.js server
/var/log/office-tools/        ← deploy logs
```

---

## Donate

**`pages/donate.html`** is a Grin showcase page — explains what Grin is, displays the TOR send address for direct donations, and links to [drop.grin.money](https://drop.grin.money) for free coins. It is a static page and requires no backend.

---

## Contributing

1. Each tool must work **fully offline** (no required network calls, except Network & Web tools)
2. No frameworks — vanilla HTML/CSS/JS only
3. Each tool page must include the shared nav header and link back to the hub
4. All tools must be **mobile-responsive**
5. Tools must not add their own third-party trackers or cookies; no localStorage abuse (site-wide analytics is centralized in `js/common.js`)

---

## License

MIT — free to use, fork, and modify.
