/**
 * yt-dlp Server — Self-hosted YouTube download backend
 * Default "Local" backend for the yt-downloader tool. deploy.sh installs and manages this.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  PREREQUISITES
 * ═══════════════════════════════════════════════════════════════════
 *
 *  1. Node.js 18+
 *     https://nodejs.org/
 *
 *  2. yt-dlp  (the actual downloader engine) — with its JavaScript pieces
 *     YouTube makes yt-dlp solve JavaScript challenges. That takes the yt-dlp-ejs scripts
 *     and a JS runtime; without them yt-dlp still runs, with formats missing.
 *     Linux:    sudo pip3 install -U --pre "yt-dlp[default,deno]"
 *               ← deploy.sh handles this automatically (nightly channel, daily cron).
 *               [default] brings yt-dlp-ejs, [deno] brings the Deno runtime.
 *     Windows:  winget install yt-dlp  (the official build bundles yt-dlp-ejs)
 *     macOS:    brew install yt-dlp deno
 *     No Deno? This server names its own Node binary as a fallback runtime — see
 *     YTDLP_JS_RUNTIMES below.
 *
 *  3. FFmpeg  (required for: MP3 audio conversion, 1080p+ video muxing)
 *     Without ffmpeg: video is limited to a single-file stream (usually 720p),
 *     and audio export will be M4A/WEBM instead of MP3.
 *     Windows:  winget install ffmpeg
 *               OR: https://ffmpeg.org/download.html (add to PATH)
 *     Linux:    sudo apt install ffmpeg
 *     macOS:    brew install ffmpeg
 *
 * ═══════════════════════════════════════════════════════════════════
 *  SETUP & RUN
 * ═══════════════════════════════════════════════════════════════════
 *
 *   cd yt-server
 *   npm install
 *   node server.js
 *
 *   Then in the yt-downloader tool, select the "Local" backend (default).
 *   For local dev the URL defaults to http://localhost:9000/ automatically.
 *
 *   The server binds 127.0.0.1 by default: nginx (/yt-api/ → 127.0.0.1:9000) is the only
 *   intended client. To expose it on a VPS without nginx (not recommended — use deploy.sh):
 *     HOST=0.0.0.0 PORT=9000 node server.js
 *     → in Advanced → Local yt-server URL, set http://YOUR-SERVER-IP:9000/
 *
 * ═══════════════════════════════════════════════════════════════════
 *  ENVIRONMENT VARIABLES  (all optional)
 * ═══════════════════════════════════════════════════════════════════
 *
 *   PORT                HTTP port to listen on          (default: 9000)
 *   HOST                Interface to bind to            (default: 127.0.0.1)
 *   YTDLP               Path to yt-dlp binary           (default: "yt-dlp")
 *   FFMPEG              Path to ffmpeg binary           (default: "ffmpeg")
 *   CORS_ORIGIN         Allowed CORS origin             (default: "*")
 *                       The page reaches this server same-origin through nginx /yt-api/,
 *                       which needs no CORS header; "*" serves local dev and custom setups.
 *   MAX_QUALITY         Hard cap on video height        (default: "1080")
 *                       Applies to "Best available" too — set "max" (or "none"/"0")
 *                       to lift the cap entirely.
 *   MAX_CONCURRENT      Simultaneous jobs allowed       (default: 2)
 *                       A slot is held from the metadata lookup until the download
 *                       process exits. Each download is a yt-dlp + ffmpeg pair writing a
 *                       full file to TEMP_DIR, so this is the CPU/disk guard. Over the
 *                       cap → { error: { code: "server_busy" } }.
 *   RATE_MAX            Downloads per client per window (default: 6)
 *   RATE_WINDOW_MS      Rate-limit window in ms         (default: 300000 = 5 min)
 *                       A client is one IPv4 address or one IPv6 /64.
 *                       Over the limit → HTTP 429 { error: { code: "rate_limit" } }.
 *   TEMP_DIR            Directory for temp files        (default: OS temp dir)
 *                       Files named ytdl-<32 hex>* in it belong to this server and are
 *                       removed at start-up.
 *   JOB_TTL_MS          How long a finished file waits to be fetched, in ms
 *                                                       (default: 600000 = 10 min)
 *   YTDLP_MAX_RUNTIME_MS  Wall-clock limit per download; the process is killed after it
 *                                                       (default: 1800000 = 30 min)
 *   YTDLP_INFO_TIMEOUT_MS Limit for the metadata lookup before a download
 *                                                       (default: 90000 = 90 s)
 *   MAX_DURATION_S      Longest video accepted, seconds (default: 14400 = 4 h; 0 = no limit)
 *   MAX_FILESIZE        yt-dlp --max-filesize value     (default: "4G"; "0"/"none" = off)
 *   YTDLP_PLAYER_CLIENT  YouTube player clients to try  (default: "" = yt-dlp's own defaults)
 *                        Leave EMPTY. YouTube now requires PO (Proof of Origin) tokens for
 *                        most clients (web, android, ios all need them) — hardcoding a client
 *                        list works against the PO-token plugin. The real bot-detection fix is
 *                        the bgutil-ytdlp-pot-provider plugin + its token server (see below).
 *                        Set only as a temporary emergency override.
 *   YTDLP_JS_RUNTIMES   Extra JS runtime for yt-dlp, as RUNTIME[:PATH]
 *                                                       (default: "" = this server's own Node)
 *                       yt-dlp enables only Deno by itself and prefers it when it is
 *                       installed; the runtime named here is what it falls back to. Node
 *                       must be 22+. "none" passes no --js-runtimes flag at all — needed
 *                       for a yt-dlp older than 2025.11.12, which rejects the flag.
 *   POT_PROVIDER_URL    bgutil PO-token provider server (default: "http://127.0.0.1:4416")
 *                       deploy.sh installs this as the office-tools-pot service. The yt-dlp
 *                       plugin auto-detects it at the default URL — this setting is only used
 *                       by /health to report provider reachability.
 *   YTDLP_COOKIES       Path to Netscape cookies.txt    (optional fallback for age-restricted
 *                       videos or severe IP bans where PO tokens alone aren't enough)
 *                       Export from browser with "Get cookies.txt LOCALLY" extension.
 *   YTDLP_COOKIES_BROWSER  Browser name for live cookie extraction (e.g. "chrome").
 *                          Only works if the browser is installed on the same machine.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  API (cobalt-compatible)
 * ═══════════════════════════════════════════════════════════════════
 *
 *  POST /
 *    Body: { url, downloadMode, videoQuality, audioFormat, audioBitrate }
 *      url           a single YouTube video (watch, shorts, live, embed, youtu.be)
 *      downloadMode  auto | audio | mute                       (default auto)
 *      videoQuality  max | 4320 | 2160 | 1440 | 1080 | 720 | 480 | 360 | 240 | 144
 *                                                              (default 1080)
 *      audioFormat   mp3 | m4a | best                          (default mp3)
 *      audioBitrate  320 | 256 | 128 | 96 | 64                 (default 128)
 *      Other body fields are ignored. A value outside these lists → HTTP 400
 *      { status: "error", error: { code: "invalid_option", field } }.
 *    Returns: { status: "tunnel", url: "/stream/:id", filename }
 *          or { status: "error",  error: { code } }
 *
 *  GET /stream/:id
 *    Waits for the download to finish, then streams the file. The temp files are
 *    deleted once the response has been sent in full (or when the job expires), so an
 *    aborted transfer can be retried. HEAD reports headers without waiting or deleting.
 *
 *  GET /health  (GET / returns the same, plus a cobalt-style { cobalt: { version } })
 *    Returns: { ok: true, ytdlp: "version string", ffmpeg: boolean,
 *               pot: "provider version" | false,
 *               cookies: "none" | "file:ok" | "file:unchecked" | "file:expired" | "file:missing" | "browser:<name>" }
 *    Computed at most once a minute; concurrent callers share one computation.
 */

'use strict';

const express   = require('express');
const { spawn } = require('child_process');
const path      = require('path');
const crypto    = require('crypto');
const fs        = require('fs');
const os        = require('os');
const net       = require('net');
const { checkVideoUrl } = require('./url-guard');

const IS_WIN = process.platform === 'win32';

/* ── Config ─────────────────────────────────────────────────── */
// Non-negative integer from the environment; unset, empty or unparsable → the default.
function intEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[config] ${name}="${raw}" is not a non-negative integer - using ${def}`);
    return def;
  }
  return n;
}

const PORT       = parseInt(process.env.PORT    || '9000', 10);
const HOST       = process.env.HOST             || '127.0.0.1';
const YTDLP      = process.env.YTDLP            || 'yt-dlp';
const FFMPEG     = process.env.FFMPEG           || 'ffmpeg';
const CORS_ORIG  = process.env.CORS_ORIGIN      || '*';
const MAX_QUAL   = process.env.MAX_QUALITY      || '1080';
// Abuse guards — this endpoint is public through nginx /yt-api/ and every request
// spawns yt-dlp (+ffmpeg) and writes a full video to TEMP_DIR.
const MAX_CONCURRENT  = parseInt(process.env.MAX_CONCURRENT || '2', 10);
const RATE_MAX        = parseInt(process.env.RATE_MAX       || '6', 10);
const RATE_WINDOW_MS  = parseInt(process.env.RATE_WINDOW_MS || '300000', 10);
const TEMP_DIR   = process.env.TEMP_DIR         || os.tmpdir();
const JOB_TTL    = parseInt(process.env.JOB_TTL_MS || '600000', 10);
const MAX_RUNTIME_MS  = intEnv('YTDLP_MAX_RUNTIME_MS', 30 * 60 * 1000) || 30 * 60 * 1000;
const INFO_TIMEOUT_MS = intEnv('YTDLP_INFO_TIMEOUT_MS', 90 * 1000) || 90 * 1000;
const MAX_DURATION_S  = intEnv('MAX_DURATION_S', 4 * 60 * 60);   // 0 = no limit
const MAX_FILESIZE    = parseFilesizeLimit(process.env.MAX_FILESIZE);
// A `-j` dump for one video is a few hundred KB to ~2 MB (format and caption lists);
// anything far beyond that is not one video, and buffering it unbounded costs memory.
const INFO_MAX_BYTES  = 16 * 1024 * 1024;
const HEALTH_CACHE_MS = 60 * 1000;
// Player client override — default EMPTY so yt-dlp picks its own current defaults.
// YouTube now requires PO (Proof of Origin) tokens for most clients (web/android/ios);
// the old 'android,tv_embedded,web' pin is what broke downloads on server IPs.
// Bot detection is handled by the bgutil-ytdlp-pot-provider plugin (installed by
// deploy.sh), which yt-dlp auto-detects — keep this empty unless firefighting.
const YTDLP_PLAYER_CLIENT   = process.env.YTDLP_PLAYER_CLIENT   || '';
// Fallback JS runtime for YouTube's player challenges — see jsRuntimeArgs.
const JS_RUNTIME_ARGS       = jsRuntimeArgs(process.env.YTDLP_JS_RUNTIMES, process.execPath);
// bgutil PO-token provider server — used only for the /health reachability probe.
const POT_PROVIDER_URL      = process.env.POT_PROVIDER_URL      || 'http://127.0.0.1:4416';
// Optional cookie fallback for age-restricted videos or IP bans.
// See deploy.sh → Option 6 → j) YouTube cookies.
const YTDLP_COOKIES         = process.env.YTDLP_COOKIES         || '';  // path to cookies.txt
const YTDLP_COOKIES_BROWSER = process.env.YTDLP_COOKIES_BROWSER || '';  // e.g. "chrome"

/* Returns player client args — empty by default (yt-dlp defaults + PO-token plugin) */
function clientArgs() {
  if (!YTDLP_PLAYER_CLIENT) return [];
  return ['--extractor-args', `youtube:player_client=${YTDLP_PLAYER_CLIENT}`];
}

/* Operator height cap. MAX_QUALITY="max"|"none"|"0"|"" lifts it; anything else is a
   number that also clamps the "Best available" choice. */
function qualityCap() {
  const raw = String(MAX_QUAL).trim().toLowerCase();
  if (!raw || raw === 'max' || raw === 'none' || raw === '0') return 0;
  const n = parseInt(raw, 10);
  // A typo must not fail open (uncapped) or produce a nonsense cap: parseInt('1o80')
  // is 1, which would filter every format away. Anything below the smallest real
  // YouTube height falls back to the documented default.
  if (!Number.isFinite(n) || n < 144) {
    console.warn(`[config] MAX_QUALITY="${MAX_QUAL}" is not a usable height - using 1080`);
    return 1080;
  }
  return n;
}

/* Returns extra cookie auth args — fallback for age-restricted / IP-banned videos */
function authArgs() {
  if (YTDLP_COOKIES_BROWSER) return ['--cookies-from-browser', YTDLP_COOKIES_BROWSER];
  if (YTDLP_COOKIES && fs.existsSync(YTDLP_COOKIES)) return ['--cookies', YTDLP_COOKIES];
  return [];
}

/* ══════════════════════════════════════════════════════════════
   PURE HELPERS  (exported for test/server-helpers.test.js)
══════════════════════════════════════════════════════════════ */

/* MAX_FILESIZE → the string passed to yt-dlp --max-filesize, or '' for no limit.
   yt-dlp's own size syntax: digits, optional fraction, optional k/M/G/T suffix. */
function parseFilesizeLimit(raw) {
  const DEFAULT = '4G';
  if (raw === undefined || String(raw).trim() === '') return DEFAULT;
  const s = String(raw).trim();
  if (s === '0' || s.toLowerCase() === 'none') return '';
  if (/^\d+(?:\.\d+)?[kKmMgGtT]?$/.test(s)) return s;
  console.warn(`[config] MAX_FILESIZE="${raw}" is not a size like 4G or 500M - using ${DEFAULT}`);
  return DEFAULT;
}

/* Every option the page (tools/yt-downloader) or a cobalt-style client may send. The
   values reach yt-dlp's argv, so anything outside these lists is refused. */
const REQUEST_OPTIONS = {
  downloadMode: { def: 'auto', allowed: ['auto', 'audio', 'mute'] },
  videoQuality: { def: '1080', allowed: ['max', '4320', '2160', '1440', '1080', '720', '480', '360', '240', '144'] },
  audioFormat:  { def: 'mp3',  allowed: ['mp3', 'm4a', 'best'] },
  audioBitrate: { def: '128',  allowed: ['320', '256', '128', '96', '64'] },
};

/* → { options } with every field set, or { error: 'invalid_option', field }.
   Absent/null fields take the default; integers are accepted as their string form. */
function validateDownloadOptions(body) {
  const src = body && typeof body === 'object' ? body : {};
  const options = {};
  for (const [field, { def, allowed }] of Object.entries(REQUEST_OPTIONS)) {
    let v = src[field];
    if (v === undefined || v === null) v = def;
    else if (Number.isInteger(v)) v = String(v);
    if (typeof v !== 'string' || !allowed.includes(v)) return { error: 'invalid_option', field };
    options[field] = v;
  }
  return { options };
}

/* --js-runtimes argv for the YTDLP_JS_RUNTIMES setting.
   yt-dlp solves YouTube's JavaScript challenges in an external runtime and enables only
   Deno by itself. On a host without Deno it would otherwise extract with formats missing
   and say so only in a warning, which every call here silences (--no-warnings). Naming a
   second runtime costs nothing when Deno is there: yt-dlp prefers Deno, and skips a
   runtime whose binary it cannot find.
     unset/empty → node:<nodePath>, the Node binary running this server
     "none"      → no flag
     other       → passed through as RUNTIME[:PATH] */
function jsRuntimeArgs(raw, nodePath) {
  const s = String(raw ?? '').trim();
  if (s.toLowerCase() === 'none') return [];
  return ['--js-runtimes', s || `node:${nodePath}`];
}

/* yt-dlp argv for every call that reaches YouTube: --ignore-config first (a planted
   yt-dlp.conf could otherwise add --exec), then the JS runtime (here, not at the call
   sites, so no call can be added without it), and `--` before the URL so it can never
   be read as an option. */
function ytdlpArgs(options, url, runtimeArgs = JS_RUNTIME_ARGS) {
  return ['--ignore-config', ...runtimeArgs, ...options, '--', url];
}

/* Replace absolute filesystem paths with "<path>" in text shown to visitors. yt-dlp
   error lines can name the cookie file or temp paths. URLs are left alone: the "//"
   after "https:" never starts a match, and a path must follow whitespace, a quote, a
   bracket, "=", "," or ":" (or the start of the text). */
function scrubPaths(text) {
  return String(text)
    .replace(/(^|[\s'"(\[=,:])\/[A-Za-z0-9._~@%+-][^\s'"<>)\]]*/g, '$1<path>')
    .replace(/(^|[\s'"(\[=,:])[A-Za-z]:\\[^\s'"<>)\]]*/g, '$1<path>');
}

/* Temp files this server owns: ytdl-<32 hex job id>, followed by anything yt-dlp adds
   (.mp4, .part, .f137.mp4, .ytdl, .temp.mp4 …). With a jobId, only that job's files. */
const TEMP_NAME_RE = /^ytdl-([0-9a-f]{32})(?![0-9a-f])/;
function isJobTempFile(name, jobId) {
  const m = TEMP_NAME_RE.exec(String(name));
  if (!m) return false;
  if (jobId === undefined) return true;
  return /^[0-9a-f]{32}$/.test(jobId) && m[1] === jobId;
}

/* Rate-limit key: an IPv4 address as-is, an IPv6 address by its /64 — one IPv6
   subscriber usually holds a whole /64 and could otherwise rotate addresses freely. */
function rateKey(ip) {
  if (typeof ip !== 'string' || !ip.trim()) return 'unknown';
  let a = ip.trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped && net.isIPv4(mapped[1])) return mapped[1];
  if (!net.isIPv6(a)) return a;
  let s = a;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const [b1, b2, b3, b4] = v4.slice(1).map(Number);
    s = s.slice(0, v4.index) + ((b1 << 8) | b2).toString(16) + ':' + ((b3 << 8) | b4).toString(16);
  }
  const [l, r] = s.split('::');
  const left  = l ? l.split(':') : [];
  const right = r ? r.split(':') : [];
  const fill  = s.includes('::') ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(Math.max(fill, 0)).fill('0'), ...right];
  return groups.slice(0, 4).map(h => parseInt(h, 16).toString(16)).join(':') + '::/64';
}

function formatDuration(s) {
  return s >= 3600 ? `${+(s / 3600).toFixed(1)} hours` : `${Math.round(s / 60)} minutes`;
}

/* Reason to refuse a video before downloading it, from yt-dlp's -j metadata, or null.
   A missing duration is not refused: the size and runtime limits still apply. */
function infoRefusal(info, maxDurationS) {
  if (!info || typeof info !== 'object') return null;
  if (info.is_live === true || info.live_status === 'is_live') {
    return 'Live streams cannot be downloaded. Try again after the stream has ended.';
  }
  if (info.live_status === 'is_upcoming') {
    return 'This video has not started yet (upcoming premiere or stream).';
  }
  if (maxDurationS > 0 && typeof info.duration === 'number' && info.duration > maxDurationS) {
    return `This video is longer than this server's limit of ${formatDuration(maxDurationS)}.`;
  }
  return null;
}

/* ── App ─────────────────────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: '1mb' }));

/* ── CORS ────────────────────────────────────────────────────── */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  CORS_ORIG);
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* ── Abuse guards ─────────────────────────────────────── */
// nginx proxies from loopback and sets X-Forwarded-For; trusting only loopback means
// req.ip is the real client behind nginx but cannot be spoofed by a direct caller.
app.set('trust proxy', 'loopback');

// Sliding-window per-client counter (key: rateKey). Deliberately dependency-free — this
// server has no npm deps beyond express, unlike backend/ which uses lib/rate-limit.js.
const rateHits = new Map();   // key -> number[] (hit timestamps)
function rateAllow(key) {
  if (RATE_MAX <= 0) return true;
  const now  = Date.now();
  const hits = (rateHits.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) { rateHits.set(key, hits); return false; }
  hits.push(now);
  rateHits.set(key, hits);
  return true;
}

// Busy slots. A slot is reserved BEFORE the metadata lookup (so a burst cannot all pass
// the check while their lookups run) and released exactly once, when the job's last
// process has exited or the request failed before a download started.
let activeSlots = 0;
function reserveSlot() {
  activeSlots++;
  let released = false;
  return () => { if (!released) { released = true; activeSlots--; } };
}

/* ── Child processes ─────────────────────────────────────────── */
// On Linux every tool runs in its own process group so a kill also reaches the ffmpeg
// that yt-dlp starts. Windows has no process groups; there the direct child is killed.
function spawnTool(cmd, args) {
  return spawn(cmd, args, { detached: !IS_WIN });
}
function killTree(proc) {
  if (!proc) return;
  if (!IS_WIN && proc.pid) {
    try { process.kill(-proc.pid, 'SIGKILL'); return; } catch { /* fall through */ }
  }
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
}

/* ── Job store ───────────────────────────────────────────────── */
// Each job: { id, url, tmpPath, filename, status ('pending'|'ready'|'error'), error,
//             settled, proc, killReason, runTimer, waiter, expires }
// While pending, `expires` is a backstop past the runtime limit; once settled it is
// JOB_TTL from then, the time the visitor has to fetch the file.
const jobs = new Map();

/* Delete every temp file of one job (or, without an id, every ytdl-<32hex>* file). */
function removeTempFiles(jobId) {
  fs.readdir(TEMP_DIR, (err, names) => {
    if (err) return;
    for (const name of names) {
      if (isJobTempFile(name, jobId)) fs.unlink(path.join(TEMP_DIR, name), () => {});
    }
  });
}

function settleJob(job, status, error) {
  if (job.settled) return;
  job.settled = true;
  job.status  = status;
  job.error   = error ? scrubPaths(error).slice(0, 300) : null;
  job.expires = Date.now() + JOB_TTL;
  if (status === 'error') removeTempFiles(job.id);
  const waiter = job.waiter;
  job.waiter = null;
  if (waiter) waiter();
}

/* Drop a job and its files (delivered, failed-and-reported, or expired). */
function forgetJob(job) {
  if (job.proc) { job.killReason = job.killReason || 'The download was cancelled.'; killTree(job.proc); }
  if (!job.settled) settleJob(job, 'error', 'The download expired before it finished.');
  removeTempFiles(job.id);
  if (jobs.get(job.id) === job) jobs.delete(job.id);
}

/* Wrap an async route so a throw or rejection becomes a 500 JSON reply. */
function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch(err => {
        console.error('[route]', (err && err.stack) || err);
        if (!res.headersSent) res.status(500).json({ status: 'error', error: { code: 'internal_error' } });
        else res.destroy();
      });
  };
}

/* ══════════════════════════════════════════════════════════════
   POST /  — start a download (cobalt-compatible request format)
══════════════════════════════════════════════════════════════ */
app.post('/', asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  /* ── Abuse guard (before any yt-dlp spawn) ── */
  if (!rateAllow(rateKey(req.ip))) {
    return res.status(429).json({ status: 'error', error: { code: 'rate_limit' } });
  }

  /* ── Validate ── */
  const { url } = body;
  if (url === undefined || url === null || url === '') {
    return res.json({ status: 'error', error: { code: 'missing_url' } });
  }
  if (typeof url !== 'string') {
    return res.status(400).json({ status: 'error', error: { code: 'invalid_url' } });
  }
  const opts = validateDownloadOptions(body);
  if (opts.error) {
    return res.status(400).json({ status: 'error', error: { code: opts.error, field: opts.field } });
  }
  const { downloadMode, videoQuality, audioFormat, audioBitrate } = opts.options;
  // SSRF guard (url-guard.js): exact host allowlist, single videos only, and yt-dlp only
  // ever gets the canonical watch URL rebuilt from the checked id — never the raw `url`.
  const checked = checkVideoUrl(url);
  if (checked.error) return res.json({ status: 'error', error: { code: checked.error } });
  const videoUrl = checked.href;

  if (MAX_CONCURRENT > 0 && activeSlots >= MAX_CONCURRENT) {
    return res.status(503).json({ status: 'error', error: { code: 'server_busy' } });
  }
  const release = reserveSlot();
  let handedOff = false;
  try {
    /* ── Fetch video metadata (title, live state, duration) ── */
    let info;
    try {
      info = await getVideoInfo(videoUrl);
    } catch (e) {
      console.error(`[yt-dlp info] ${e.message}`);
      return res.json({ status: 'error', error: { code: scrubPaths(e.message).slice(0, 200) } });
    }
    const refusal = infoRefusal(info, MAX_DURATION_S);
    if (refusal) return res.json({ status: 'error', error: { code: refusal } });
    const title = typeof info.title === 'string' && info.title ? info.title : 'download';

    /* ── Determine output format + path ── */
    const isAudio  = downloadMode === 'audio';
    const wantMp3  = isAudio && audioFormat === 'mp3';
    const ext      = isAudio ? (wantMp3 ? 'mp3' : 'm4a') : 'mp4';
    const safeTitle = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
    const filename  = `${safeTitle}.${ext}`;
    const jobId     = crypto.randomBytes(16).toString('hex');
    const tmpPath   = path.join(TEMP_DIR, `ytdl-${jobId}.${ext}`);

    /* ── Register job ── */
    const job = {
      id: jobId, url: videoUrl, tmpPath, filename, status: 'pending', error: null,
      settled: false, proc: null, killReason: null, runTimer: null, waiter: null,
      expires: Date.now() + MAX_RUNTIME_MS + JOB_TTL,
    };
    jobs.set(jobId, job);

    /* ── Start download in background (owns the slot from here on) ── */
    handedOff = true;
    startDownload(job, { isAudio, wantMp3, videoQuality, audioBitrate }, release);

    /* ── Respond immediately ── */
    res.json({ status: 'tunnel', url: `/stream/${jobId}`, filename });
  } finally {
    if (!handedOff) release();
  }
}));

/* ══════════════════════════════════════════════════════════════
   GET /stream/:id  — wait for download, stream file, clean up
   (Express routes HEAD here too.)
══════════════════════════════════════════════════════════════ */
app.get('/stream/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.expires < Date.now()) {
    return streamError(req, res, 404, 'Stream not found or expired');
  }
  const isHead = req.method === 'HEAD';

  /* Already finished? */
  if (job.status === 'ready') return serveFile(job, req, res);
  if (job.status === 'error') {
    if (!isHead) forgetJob(job);
    return streamError(req, res, 500, job.error || 'Download failed');
  }
  if (isHead) return res.status(202).end();

  /* Wait for the download to finish. One waiter per job: the job's own runtime limit
     and TTL bound the wait, so no per-request timer is needed. */
  if (job.waiter) {
    return streamError(req, res, 409, 'This download is already being fetched in another tab.');
  }
  const onDone = () => {
    if (job.status === 'ready') return serveFile(job, req, res);
    forgetJob(job);
    streamError(req, res, 500, job.error || 'Download failed');
  };
  job.waiter = onDone;
  // The visitor left (or nginx timed out) before the file was ready: free the slot for
  // a retry. The download itself continues and waits JOB_TTL to be fetched.
  res.on('close', () => { if (job.waiter === onDone) job.waiter = null; });
});

/* ══════════════════════════════════════════════════════════════
   GET /health  — dependency check
   GET /        — same payload + cobalt-style { cobalt: { version } }
                  (the yt-downloader frontend probes GET / for its
                  status indicator, cobalt-API style)
══════════════════════════════════════════════════════════════ */
async function healthPayload() {
  const [ytdlpVer, ffmpegOk, potVer] = await Promise.all([getYtdlpVersion(), hasFfmpeg(), getPotStatus()]);
  let cookiesOk;
  if (YTDLP_COOKIES_BROWSER) {
    cookiesOk = 'browser:' + YTDLP_COOKIES_BROWSER;
  } else if (!YTDLP_COOKIES) {
    cookiesOk = 'none';
  } else if (!fs.existsSync(YTDLP_COOKIES)) {
    cookiesOk = 'file:missing';
  } else {
    // Check keep-alive status file written by ytcookie-keepalive.sh cron
    const statusFile = path.join(path.dirname(YTDLP_COOKIES), 'cookies.status');
    let line = null;
    try { line = fs.readFileSync(statusFile, 'utf8').trim().split('\n')[0] || ''; } catch { /* absent */ }
    if (line === null) cookiesOk = 'file:unchecked'; // file exists, keep-alive cron not yet run
    else cookiesOk = line.startsWith('expired') ? 'file:expired' : 'file:ok';
  }
  return { ok: !!ytdlpVer, ytdlp: ytdlpVer || 'not found', ffmpeg: ffmpegOk, pot: potVer, cookies: cookiesOk };
}

// Anonymous visitors hit GET / on every page load; each computation spawns yt-dlp and
// ffmpeg and probes the PO-token provider, so it is shared for HEALTH_CACHE_MS.
let healthCache = null;   // { at, promise }
function cachedHealth() {
  const now = Date.now();
  if (healthCache && now - healthCache.at < HEALTH_CACHE_MS) return healthCache.promise;
  const promise = healthPayload();
  healthCache = { at: now, promise };
  promise.catch(() => { if (healthCache && healthCache.promise === promise) healthCache = null; });
  return promise;
}

app.get('/health', asyncRoute(async (req, res) => {
  res.json(await cachedHealth());
}));

app.get('/', asyncRoute(async (req, res) => {
  const h = await cachedHealth();
  res.json({ cobalt: { version: h.ytdlp, services: ['youtube'] }, ...h });
}));

/* ══════════════════════════════════════════════════════════════
   INTERNAL HELPERS
══════════════════════════════════════════════════════════════ */

/**
 * Get the video's metadata from yt-dlp's JSON dump (title, is_live, live_status,
 * duration …). Uses --no-playlist to avoid fetching playlist metadata. Bounded in time
 * (INFO_TIMEOUT_MS) and in output size (INFO_MAX_BYTES); either limit kills the process.
 */
function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let outLen = 0, err = '', done = false, timer = null, proc = null;
    const finish = (e, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (e) reject(e); else resolve(v);
    };
    try {
      proc = spawnTool(YTDLP, ytdlpArgs(['--no-playlist', '-j', '--no-warnings', ...clientArgs(), ...authArgs()], url));
    } catch (e) {
      return finish(new Error('yt-dlp could not be started (' + e.message + ')'));
    }
    let exited = false;
    const stop = () => { if (!exited) killTree(proc); };
    timer = setTimeout(() => {
      stop();
      finish(new Error('Reading the video information timed out - try again in a moment.'));
    }, INFO_TIMEOUT_MS);
    proc.stdout.on('data', d => {
      if (done) return;
      outLen += d.length;
      if (outLen > INFO_MAX_BYTES) {
        stop();
        return finish(new Error('yt-dlp returned more video information than expected for one video.'));
      }
      chunks.push(d);
    });
    proc.stderr.on('data', d => { err = (err + d).slice(-8192); });
    proc.on('close', code => {
      exited = true;
      if (done) return;
      if (code !== 0) {
        // Surface the actual yt-dlp error line (last non-empty stderr line)
        const detail = err.trim().split('\n').filter(Boolean).pop()?.trim() || `exit ${code}`;
        return finish(new Error(detail));
      }
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch { finish(new Error('Could not parse yt-dlp JSON output')); }
    });
    proc.on('error', e => {
      exited = true;
      finish(new Error('yt-dlp not found — install: pip3 install -U --pre "yt-dlp[default,deno]"  (' + e.message + ')'));
    });
  });
}

/**
 * Build yt-dlp arguments and start the download subprocess for `job`. Downloads to a
 * temp file and settles the job when the process exits; `release` frees the busy slot
 * at that moment. The process is killed after MAX_RUNTIME_MS.
 *
 * Video (mp4):  bestvideo[height<=Q]+bestaudio → merged with ffmpeg to .mp4
 * Audio (mp3):  bestaudio → extracted + converted to .mp3 via ffmpeg
 * Audio (m4a):  bestaudio[ext=m4a]/bestaudio → saved as .m4a
 */
function startDownload(job, { isAudio, wantMp3, videoQuality, audioBitrate }, release) {
  const sizeArgs = MAX_FILESIZE ? ['--max-filesize', MAX_FILESIZE] : [];
  let opts;
  if (isAudio) {
    if (wantMp3) {
      /*
       * Extract audio and convert to MP3 via FFmpeg.
       * PREREQUISITE: ffmpeg must be installed and in PATH.
       * Without ffmpeg, yt-dlp will skip conversion and save as .webm/.m4a.
       */
      opts = [
        '--no-playlist', '--no-warnings',
        ...clientArgs(), ...authArgs(), ...sizeArgs,
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', `${audioBitrate}K`,
        '--ffmpeg-location', FFMPEG,
        '-o', job.tmpPath,
      ];
    } else {
      /* M4A — no conversion needed if source is already m4a */
      opts = [
        '--no-playlist', '--no-warnings',
        ...clientArgs(), ...authArgs(), ...sizeArgs,
        '-f', 'bestaudio[ext=m4a]/bestaudio/best',
        '-o', job.tmpPath,
      ];
    }
  } else {
    /*
     * Video: download best video + best audio and merge into mp4.
     * PREREQUISITE: ffmpeg must be installed for merging separate streams.
     * Without ffmpeg, falls back to a single pre-merged stream (usually ≤720p).
     */
    // "max" is capped too: MAX_QUALITY is an operator limit, not just a default.
    const cap     = qualityCap();
    const want    = videoQuality === 'max' ? 0 : (parseInt(videoQuality, 10) || 1080);
    const height  = (cap && want) ? Math.min(want, cap) : (cap || want);   // 0 = uncapped
    const q       = height ? `[height<=${height}]` : '';
    const format  = `bestvideo${q}[ext=mp4]+bestaudio[ext=m4a]/bestvideo${q}+bestaudio/best${q}/best`;
    opts = [
      '--no-playlist', '--no-warnings',
      ...clientArgs(), ...authArgs(), ...sizeArgs,
      '-f', format,
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', FFMPEG,
      '-o', job.tmpPath,
    ];
  }

  let proc;
  try {
    proc = spawnTool(YTDLP, ytdlpArgs(opts, job.url));
  } catch (e) {
    console.error(`[yt-dlp ${job.id.slice(0, 8)}] spawn failed: ${e.message}`);
    release();
    settleJob(job, 'error', 'yt-dlp could not be started on the server.');
    return;
  }
  job.proc = proc;
  job.runTimer = setTimeout(() => {
    job.killReason = `The download took longer than ${formatDuration(MAX_RUNTIME_MS / 1000)} and was stopped.`;
    killTree(proc);
  }, MAX_RUNTIME_MS);

  // Keep the tail of stderr so a failure reports the real yt-dlp line ("Sign in to
  // confirm you're not a bot", "Video unavailable", …) instead of a bare exit code.
  // Without this the reason exists only in the journal and the user is told nothing.
  // The stdout tail is kept for the "larger than max-filesize" notice yt-dlp prints there.
  let errTail = '', outTail = '';
  proc.stdout.on('data', d => { outTail = (outTail + d).slice(-4096); });
  proc.stderr.on('data', d => {
    process.stderr.write(`[yt-dlp ${job.id.slice(0, 8)}] ${d}`);
    errTail = (errTail + d).slice(-4096);
  });

  let exited = false;
  const onExit = (code, spawnErr) => {
    if (exited) return;
    exited = true;
    job.proc = null;
    clearTimeout(job.runTimer);
    release();
    if (job.settled) return;                       // expired/forgotten while running
    if (job.killReason) return settleJob(job, 'error', job.killReason);
    if (spawnErr) return settleJob(job, 'error', 'yt-dlp spawn error: ' + spawnErr.message);
    if (code === 0 && fs.existsSync(job.tmpPath)) return settleJob(job, 'ready');
    if (/max-filesize/i.test(outTail + errTail)) {
      return settleJob(job, 'error', `This file is larger than this server's limit of ${MAX_FILESIZE}B.`);
    }
    const detail = errTail.trim().split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('[download]'))
      .pop();
    settleJob(job, 'error', detail || `yt-dlp exited with code ${code}`);
  };
  proc.on('close', code => onExit(code));
  proc.on('error', e => onExit(null, e));
}

/**
 * Report a /stream failure. The browser reaches this URL through a plain navigation
 * (the frontend's hidden <a download>), so a JSON body would render as raw JSON in a
 * fresh tab — HTML for browsers, JSON for anything asking for it.
 */
function streamError(req, res, status, message) {
  res.status(status);
  if (!req.accepts('html')) return res.json({ error: message });
  const safe = String(message)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Download failed</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
             background:#0f1115;color:#e5e7eb;font:15px/1.55 system-ui,sans-serif;padding:1.5rem">
  <div style="max-width:36rem;background:#171a21;border:1px solid #2a2f3a;border-radius:12px;padding:1.5rem">
    <h1 style="margin:0 0 .6rem;font-size:1.15rem">❌ Download failed</h1>
    <p style="margin:0 0 .9rem;color:#9ca3af">The server could not produce this file.</p>
    <pre style="margin:0;padding:.8rem;background:#0f1115;border-radius:8px;white-space:pre-wrap;
                word-break:break-word;font-size:.85rem;color:#fca5a5">${safe}</pre>
  </div>
</body></html>`);
}

/**
 * Stream the downloaded temp file to the HTTP response. The job and its files are
 * removed only once the response has been sent in full; an aborted transfer keeps them
 * until JOB_TTL so the visitor can retry. HEAD sends the headers only.
 */
function serveFile(job, req, res) {
  let stat;
  try { stat = fs.statSync(job.tmpPath); } catch {
    return res.status(410).json({ error: 'File no longer available' });
  }
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(job.filename)}"`);
  res.setHeader('Content-Type',        'application/octet-stream');
  res.setHeader('Content-Length',      stat.size);
  res.setHeader('Cache-Control',       'no-store');
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(job.tmpPath);
  stream.on('error', () => res.destroy());
  res.on('close', () => {
    if (res.writableFinished) forgetJob(job);
    else stream.destroy();
  });
  stream.pipe(res);
}

/* ── Version checks (for /health) ─────────────────────────── */
// Each probe is killed after 10 s so a hung binary cannot hold /health open.
function probe(cmd, args, onClose) {
  return new Promise(resolve => {
    let out = '', proc, settled = false;
    const done = v => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    try { proc = spawnTool(cmd, args); } catch { return resolve(onClose(null, '')); }
    const timer = setTimeout(() => { killTree(proc); done(onClose(null, '')); }, 10_000);
    proc.stdout.on('data', d => { out = (out + d).slice(0, 4096); });
    proc.stderr.on('data', () => {});
    proc.on('close', code => done(onClose(code, out)));
    proc.on('error', () => done(onClose(null, '')));
  });
}
function getYtdlpVersion() {
  return probe(YTDLP, ['--ignore-config', '--version'], (code, out) => (code === 0 ? out.trim() : null));
}
function hasFfmpeg() {
  return probe(FFMPEG, ['-version'], code => code === 0);
}
/* Probe the bgutil PO-token provider (GET /ping → { version, server_uptime }).
   Returns the provider version string, or false when unreachable. */
async function getPotStatus() {
  try {
    const r = await fetch(`${POT_PROVIDER_URL}/ping`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    const d = await r.json();
    return d.version || 'unknown';
  } catch {
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════
   START
══════════════════════════════════════════════════════════════ */
function main() {
  // Backstop: one bad request must not take the whole service down. Routes already turn
  // their own errors into 500 replies; these catch anything that escapes elsewhere.
  process.on('unhandledRejection', err => console.error('[unhandledRejection]', (err && err.stack) || err));
  process.on('uncaughtException',  err => console.error('[uncaughtException]',  (err && err.stack) || err));

  // Temp files left by a previous run (crash, restart mid-download) belong to no job.
  removeTempFiles();

  /* ── Periodic cleanup of expired jobs ──────────────────────── */
  setInterval(() => {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (job.expires < now) forgetJob(job);   // kills a still-running process too
    }
    // Drop rate-limit entries whose whole window has passed, so the map cannot grow
    // unbounded across every client that ever touched the server.
    for (const [key, hits] of rateHits) {
      if (!hits.some(t => now - t < RATE_WINDOW_MS)) rateHits.delete(key);
    }
  }, 60_000);

  app.listen(PORT, HOST, async () => {
    console.log(`\n  yt-dlp server  →  http://${HOST}:${PORT}/`);
    console.log(`  In the yt-downloader tool, select "Local" backend (default when deployed via nginx /yt-api/).\n`);

    const { ytdlp, ffmpeg: ffmpegOk, pot: potVer, ok } = await cachedHealth();
    console.log(`  yt-dlp  : ${ok ? `✓ ${ytdlp}` : '✗ NOT FOUND — install: pip install -U --pre "yt-dlp[default,deno]"'}`);
    console.log(`  JS run. : Deno when installed${JS_RUNTIME_ARGS.length ? `, else ${JS_RUNTIME_ARGS[1]}` : ' (no fallback: YTDLP_JS_RUNTIMES=none)'}`);
    console.log(`  ffmpeg  : ${ffmpegOk ? '✓ found'  : '✗ NOT FOUND — MP3 and 1080p will not work (install ffmpeg)'}`);
    console.log(`  PO-token: ${potVer ? `✓ provider v${potVer} at ${POT_PROVIDER_URL}` : `✗ provider NOT reachable at ${POT_PROVIDER_URL} — YouTube may serve bot-check 403s (deploy.sh installs office-tools-pot)`}`);
    console.log(`  Limits  : ${MAX_CONCURRENT > 0 ? MAX_CONCURRENT : '∞'} concurrent · ${RATE_MAX > 0 ? `${RATE_MAX} per client / ${Math.round(RATE_WINDOW_MS / 1000)}s` : 'no rate limit'} · height cap ${qualityCap() || 'none'}`);
    console.log(`            run ≤ ${formatDuration(MAX_RUNTIME_MS / 1000)} · video ≤ ${MAX_DURATION_S > 0 ? formatDuration(MAX_DURATION_S) : '∞'} · file ≤ ${MAX_FILESIZE || '∞'}`);
    console.log('');
  });
}

if (require.main === module) main();

module.exports = {
  validateDownloadOptions, REQUEST_OPTIONS, ytdlpArgs, jsRuntimeArgs, scrubPaths, isJobTempFile,
  rateKey, infoRefusal, parseFilesizeLimit,
};
