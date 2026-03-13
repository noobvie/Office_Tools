# Office Tools

A collection of free, open-source browser-based tools for everyday office and productivity use.
No backend. No login. No tracking. Everything runs locally in your browser.

**Live site:** _add your GitHub Pages / Netlify URL here_

---

## Architecture

```
Office_Tools/
├── index.html              ← Hub page (tool grid)
├── css/
│   └── style.css           ← Shared styles, dark/light theme
├── js/
│   └── common.js           ← Shared nav, theme toggle, utilities
├── assets/
│   └── icons/              ← SVG icons per tool
└── tools/
    ├── password-generator/
    │   └── index.html
    ├── word-counter/
    │   └── index.html
    └── ... (one folder per tool)
```

Each tool lives in its own folder under `tools/` with a self-contained `index.html`.
Shared CSS and JS are loaded from the root `css/` and `js/` folders.

---

## Tech Stack

- **HTML / CSS / Vanilla JS only** — no framework, no build step
- Deploys to GitHub Pages, Netlify, or Cloudflare Pages as-is
- External libraries loaded via CDN where needed (listed per tool below)

---

## Development Setup

```bash
git clone https://github.com/YOUR_USERNAME/Office_Tools.git
cd Office_Tools

# Option A — Python (no install needed on most systems)
python3 -m http.server 8080

# Option B — Node
npx serve .

# Then open: http://localhost:8080
```

No build step, no `npm install`, no environment variables required.

---

## Tool Checklist

### Phase 1 — Foundation
- [ ] **Hub page** (`index.html`) — responsive grid of all tools, category filters, dark/light toggle

---

### Phase 2 — Quick Wins (pure JS, no external API)

| # | Tool | Folder | Description | Libraries |
|---|------|--------|-------------|-----------|
| 1 | Password Generator | `tools/password-generator/` | Generate secure random passwords with options: length, uppercase, lowercase, numbers, symbols, exclude ambiguous chars | None |
| 2 | Word Counter | `tools/word-counter/` | Count words, characters (with/without spaces), sentences, paragraphs, estimated reading time, keyword density | None |
| 3 | Base64 Converter | `tools/base64-converter/` | Encode and decode text or files to/from Base64. Supports file drag-and-drop | None |
| 4 | URL Encoder / Decoder | `tools/url-encoder/` | Percent-encode and decode URLs. Shows before/after diff | None |
| 5 | Unix Timestamp Converter | `tools/unix-timestamp/` | Convert Unix timestamp ↔ human-readable date/time. Shows current timestamp live | None |
| 6 | QR Code Generator | `tools/qr-generator/` | Generate QR codes for URL, plain text, WiFi, vCard. Download as PNG/SVG | [qrcode.js](https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js) |
| 7 | Date Calculator | `tools/date-calculator/` | Difference between two dates (days/weeks/months/years), add/subtract days, countdown to a date, precise age from birthdate | None |
| 8 | Percentage Calculator | `tools/percentage-calculator/` | What is X% of Y? X is what % of Y? Percentage change between two values | None |
| 9 | Aspect Ratio Calculator | `tools/aspect-ratio/` | Calculate missing dimension given ratio and one side. Common presets (16:9, 4:3, 1:1, etc.) | None |
| 10 | Random Number Generator | `tools/random-number/` | Generate one or many random integers/decimals in a range. Exclude duplicates option. Copy all | None |
| 11 | UUID Generator | `tools/uuid-generator/` | Generate UUID v4 (random) and v7 (time-ordered). Bulk generation. Copy all. Uses built-in `crypto.randomUUID()` | None |
| 12 | Pomodoro Timer | `tools/pomodoro/` | Focus timer using 25-min work / 5-min break / 15-min long break cycles. Desktop notification support | None |

---

### Phase 3 — Medium Effort

| # | Tool | Folder | Description | Libraries |
|---|------|--------|-------------|-----------|
| 13 | JSON Editor | `tools/json-editor/` | Paste or upload JSON, validate, format/minify, syntax-highlighted view, copy output | [CodeMirror 6](https://cdnjs.cloudflare.com/ajax/libs/codemirror/6.65.7/) |
| 14 | Text Diff | `tools/text-diff/` | Side-by-side or inline diff of two text blocks with color highlighting of additions/removals | [diff.js](https://cdnjs.cloudflare.com/ajax/libs/diff/5.1.0/diff.min.js) |
| 15 | Markdown Editor | `tools/markdown-editor/` | Live split-pane markdown editor with HTML preview. Export as HTML or copy markdown | [marked.js](https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js) |
| 16 | CSV ↔ JSON Converter | `tools/csv-json/` | Convert CSV to JSON or JSON to CSV. Preview table. Download output. Handles quoted fields | [PapaParse](https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js) |
| 17 | Hash Generator | `tools/hash-generator/` | Generate SHA-256, SHA-384, SHA-512, HMAC hashes from text or file. Uses Web Crypto API | None |
| 18 | Color Converter | `tools/color-converter/` | Convert between HEX, RGB, HSL, HSV, CMYK. Live color preview swatch. Copy each format | None |
| 19 | Crontab Explainer | `tools/crontab/` | Parse any cron expression and display human-readable description. Show next 5 run times | [cronstrue](https://cdnjs.cloudflare.com/ajax/libs/cronstrue/2.47.0/cronstrue.min.js) |
| 20 | Typing Speed Test | `tools/typing-speed/` | 1-minute typing test. WPM, accuracy %, incorrect words highlighted. Multiple passage options | None |

---

### Phase 4 — Needs External API

| # | Tool | Folder | Description | API |
|---|------|--------|-------------|-----|
| 21 | Currency Converter | `tools/currency/` | Convert between 150+ currencies. Shows rate and last update time | [exchangerate-api.com](https://www.exchangerate-api.com/) free tier |
| 22 | What Is My IP? | `tools/my-ip/` | Show public IP, ISP, country, city, timezone | [ipify.org](https://api.ipify.org) (IP only, free, no key) |
| 23 | Campaign URL Builder | `tools/utm-builder/` | Append UTM parameters (source, medium, campaign, term, content) to any URL. Copy final URL | None |

---

### Phase 5 — Visual / Canvas Tools

| # | Tool | Folder | Description | Libraries |
|---|------|--------|-------------|-----------|
| 24 | Screenshot Beautifier | `tools/screenshot-beautifier/` | Upload screenshot, add gradient background, padding, rounded corners, drop shadow. Download PNG | None (Canvas API) |
| 25 | Color Contrast Checker | `tools/contrast-checker/` | Enter foreground + background color. Shows contrast ratio, WCAG AA/AAA pass/fail badges | None |
| 26 | Image Palette Extractor | `tools/palette-extractor/` | Upload an image, extract 5–10 dominant colors as HEX swatches. Copy palette | None (Canvas API) |
| 27 | Fake Data Generator | `tools/fake-data/` | Generate N rows of fake names, emails, phone numbers, addresses, dates. Download CSV/JSON | None |
| 28 | Wheel of Names | `tools/wheel-of-names/` | Enter a list of names, spin the animated wheel, pick a random winner. Remove winner option | None (Canvas API) |

---

## Contributing

1. Each tool must work **fully offline** (no required network calls, except Phase 4 tools)
2. No frameworks — vanilla HTML/CSS/JS only
3. Each tool page must include the shared nav header and link back to the hub
4. All tools must be **mobile-responsive**
5. No cookies, no localStorage abuse, no analytics

---

## License

MIT — free to use, fork, and modify.
