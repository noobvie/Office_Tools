# Office Tools

A collection of 28 free, browser-based utilities for everyday office and productivity work.
No build step, no framework, no tracking — everything runs locally in your browser.

**Live site:** [https://github.com/noobvie/Office_Tools](https://github.com/noobvie/Office_Tools)

---

## Tools

### ⏱️ Productivity & Time
| Tool | Description |
|------|-------------|
| Pomodoro Timer | 25-min focus cycles with short/long breaks, session counter and desktop notifications |
| Date Calculator | Date difference, add/subtract days, precise age calculator, countdown to any date |

### ✨ Generators
| Tool | Description |
|------|-------------|
| Password Generator | Secure random passwords — custom length, character sets, exclude ambiguous chars |
| QR Code Generator | QR codes for URL, text, WiFi, vCard — download as PNG |
| UUID Generator | UUID v4 (random) and v7 (time-ordered) — single or bulk, one-click copy |
| Random Number Generator | Random integers or decimals in any range — bulk generation, no-duplicates option |

### 📝 Text & Content
| Tool | Description |
|------|-------------|
| Word Counter | Words, characters, sentences, reading time and keyword density — live |
| Markdown Editor | Live split-pane editor with HTML preview, toolbar and export |
| Text Diff | Side-by-side diff of two text blocks with color-highlighted additions/deletions |
| Typing Speed Test | WPM and accuracy with real-time error tracking and grade rating |

### 🔒 Encoding & Crypto
| Tool | Description |
|------|-------------|
| Base64 Converter | Encode/decode text or files to/from Base64 — supports drag-and-drop |
| URL Encoder / Decoder | Percent-encode and decode URLs with before/after diff view |
| Unix Timestamp | Convert Unix timestamps ↔ human-readable dates. Shows live current timestamp |
| Hash Generator | SHA-1/256/384/512 and HMAC from text or files — uses Web Crypto API, 100% local |

### 🧮 Calculators
| Tool | Description |
|------|-------------|
| Percentage Calculator | What is X% of Y? X is what % of Y? Percentage change between two values |
| Aspect Ratio Calculator | Find missing dimension from ratio. Common presets: 16:9, 4:3, 1:1 |

### 💻 Development
| Tool | Description |
|------|-------------|
| JSON Editor | Validate, format, minify JSON with syntax highlighting and interactive tree view |
| CSV ↔ JSON | Convert between CSV and JSON — table preview, file upload, download |
| Crontab Explainer | Parse cron expressions into plain English — shows next 10 run times |

### 🎨 Design
| Tool | Description |
|------|-------------|
| Color Converter | Convert HEX, RGB, HSL, HSV, CMYK — live preview, shades generator, named colors |

### 🌐 Network & Web
| Tool | Description |
|------|-------------|
| Currency Converter | 40+ currencies with live exchange rates, popular pairs and quick-convert table |
| What Is My IP? | Public IP, ISP, country, city, coordinates and IPv6 support status |
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

## Development Setup

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

## Backend Setup

See [backend/README.md](backend/README.md) for full setup instructions covering:
- PocketBase install and collection import (`pb_schema.json`)
- Grin payment server setup (`.env.example`)
- nginx reverse proxy config
- systemd service files for both services
- Frontend config (`js/config.js`) for connecting to your backend

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
