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
 *  2. yt-dlp  (the actual downloader engine)
 *     Linux:    sudo pip3 install yt-dlp          ← deploy.sh handles this automatically
 *               (also sets up a weekly cron job to keep yt-dlp current)
 *     Windows:  winget install yt-dlp  OR  pip install yt-dlp
 *     macOS:    brew install yt-dlp
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
 *   To expose on a VPS without nginx (not recommended — use deploy.sh instead):
 *     PORT=9000 node server.js
 *     → in Advanced → Local yt-server URL, set http://YOUR-SERVER-IP:9000/
 *
 * ═══════════════════════════════════════════════════════════════════
 *  ENVIRONMENT VARIABLES  (all optional)
 * ═══════════════════════════════════════════════════════════════════
 *
 *   PORT                HTTP port to listen on          (default: 9000)
 *   HOST                Interface to bind to            (default: 0.0.0.0)
 *   YTDLP               Path to yt-dlp binary           (default: "yt-dlp")
 *   FFMPEG              Path to ffmpeg binary           (default: "ffmpeg")
 *   CORS_ORIGIN         Allowed CORS origin             (default: "*")
 *   MAX_QUALITY         Hard cap on video height        (default: "1080")
 *                       Applies to "Best available" too — set "max" (or "none"/"0")
 *                       to lift the cap entirely.
 *   MAX_CONCURRENT      Simultaneous downloads allowed  (default: 2)
 *                       Each one is a yt-dlp + ffmpeg pair writing a full file to
 *                       TEMP_DIR, so this is the CPU/disk guard. Over the cap →
 *                       { error: { code: "server_busy" } }.
 *   RATE_MAX            Downloads per IP per window     (default: 6)
 *   RATE_WINDOW_MS      Rate-limit window in ms         (default: 300000 = 5 min)
 *                       Over the limit → HTTP 429 { error: { code: "rate_limit" } }.
 *   TEMP_DIR            Directory for temp files        (default: OS temp dir)
 *   JOB_TTL_MS          Job expiry in ms                (default: 600000 = 10 min)
 *   YTDLP_PLAYER_CLIENT  YouTube player clients to try  (default: "" = yt-dlp's own defaults)
 *                        Leave EMPTY. YouTube now requires PO (Proof of Origin) tokens for
 *                        most clients (web, android, ios all need them) — hardcoding a client
 *                        list works against the PO-token plugin. The real bot-detection fix is
 *                        the bgutil-ytdlp-pot-provider plugin + its token server (see below).
 *                        Set only as a temporary emergency override.
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
 *    Returns: { status: "tunnel", url: "/stream/:id", filename }
 *          or { status: "error",  error: { code } }
 *
 *  GET /stream/:id
 *    Waits for download to finish, then streams the file.
 *    Deletes temp file after sending.
 *
 *  GET /health  (GET / returns the same, plus a cobalt-style { cobalt: { version } })
 *    Returns: { ok: true, ytdlp: "version string", ffmpeg: boolean,
 *               pot: "provider version" | false,
 *               cookies: "none" | "file:ok" | "file:unchecked" | "file:expired" | "file:missing" | "browser:<name>" }
 */

'use strict';

const express   = require('express');
const { spawn } = require('child_process');
const path      = require('path');
const crypto    = require('crypto');
const fs        = require('fs');
const os        = require('os');
const EventEmitter = require('events');

/* ── Config ─────────────────────────────────────────────────── */
const PORT       = parseInt(process.env.PORT    || '9000', 10);
const HOST       = process.env.HOST             || '0.0.0.0';
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
// Player client override — default EMPTY so yt-dlp picks its own current defaults.
// YouTube now requires PO (Proof of Origin) tokens for most clients (web/android/ios);
// the old 'android,tv_embedded,web' pin is what broke downloads on server IPs.
// Bot detection is handled by the bgutil-ytdlp-pot-provider plugin (installed by
// deploy.sh), which yt-dlp auto-detects — keep this empty unless firefighting.
const YTDLP_PLAYER_CLIENT   = process.env.YTDLP_PLAYER_CLIENT   || '';
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
   number that also clamps the "Best available" choice (which used to bypass it). */
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

// Sliding-window per-IP counter. Deliberately dependency-free — this server has no
// npm deps beyond express, unlike backend/ which uses lib/rate-limit.js.
const rateHits = new Map();   // ip -> number[] (hit timestamps)
function rateAllow(ip) {
  if (RATE_MAX <= 0) return true;
  const now  = Date.now();
  const hits = (rateHits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) { rateHits.set(ip, hits); return false; }
  hits.push(now);
  rateHits.set(ip, hits);
  return true;
}

// Active yt-dlp downloads. Incremented when a job starts, decremented exactly once when
// its process settles (see startDownload) — never derived from jobs.size, which also
// counts finished jobs still waiting to be streamed.
let activeDownloads = 0;

/* ── Job store ───────────────────────────────────────────────── */
// Each job: { tmpPath, filename, status ('pending'|'ready'|'error'), error, emitter, expires }
const jobs = new Map();

/* ══════════════════════════════════════════════════════════════
   POST /  — start a download (cobalt-compatible request format)
══════════════════════════════════════════════════════════════ */
app.post('/', async (req, res) => {
  const {
    url,
    downloadMode  = 'auto',  // 'auto' | 'audio' | 'mute'
    videoQuality  = '1080',  // 'max' | '1080' | '720' | '480' | '360' | '240' | '144'
    audioFormat   = 'mp3',   // 'mp3' | 'm4a' | 'best'
    audioBitrate  = '128',   // kbps: '320' | '256' | '128' | '96'
  } = req.body || {};

  /* ── Abuse guards (before any yt-dlp spawn) ── */
  if (!rateAllow(req.ip)) {
    return res.status(429).json({ status: 'error', error: { code: 'rate_limit' } });
  }
  if (MAX_CONCURRENT > 0 && activeDownloads >= MAX_CONCURRENT) {
    return res.status(503).json({ status: 'error', error: { code: 'server_busy' } });
  }

  /* ── Validate ── */
  if (!url) return res.json({ status: 'error', error: { code: 'missing_url' } });
  try {
    const u = new URL(url);
    // Soft-restrict to known video hosts (YouTube, shorts, music, etc.)
    const allowed = ['youtube.com', 'youtu.be', 'music.youtube.com'];
    if (!allowed.some(h => u.hostname.endsWith(h))) {
      return res.json({ status: 'error', error: { code: 'unsupported_host' } });
    }
  } catch {
    return res.json({ status: 'error', error: { code: 'invalid_url' } });
  }

  /* ── Fetch video metadata (title) ── */
  let title = 'download';
  try {
    title = await getTitle(url);
  } catch (e) {
    return res.json({ status: 'error', error: { code: e.message.slice(0, 200) } });
  }

  /* ── Determine output format + path ── */
  const isAudio  = downloadMode === 'audio';
  const wantMp3  = isAudio && audioFormat === 'mp3';
  const ext      = isAudio ? (wantMp3 ? 'mp3' : 'm4a') : 'mp4';
  const safeTitle = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
  const filename  = `${safeTitle}.${ext}`;
  const jobId     = crypto.randomBytes(16).toString('hex');
  const tmpPath   = path.join(TEMP_DIR, `ytdl-${jobId}.${ext}`);

  /* ── Register job ── */
  const emitter = new EventEmitter();
  jobs.set(jobId, { tmpPath, filename, status: 'pending', error: null, emitter, expires: Date.now() + JOB_TTL });

  /* ── Start download in background ── */
  startDownload({ jobId, url, tmpPath, isAudio, wantMp3, videoQuality, audioBitrate });

  /* ── Respond immediately ── */
  res.json({ status: 'tunnel', url: `/stream/${jobId}`, filename });
});

/* ══════════════════════════════════════════════════════════════
   GET /stream/:id  — wait for download, stream file, clean up
══════════════════════════════════════════════════════════════ */
app.get('/stream/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.expires < Date.now()) {
    return streamError(req, res, 404, 'Stream not found or expired');
  }

  /* Already finished? */
  if (job.status === 'ready') return serveFile(job, req, res);
  if (job.status === 'error') {
    jobs.delete(req.params.id);
    return streamError(req, res, 500, job.error || 'Download failed');
  }

  /* Wait for the download to complete (event-based, no polling) */
  const timer = setTimeout(() => {
    job.emitter.off('done', onDone);
    jobs.delete(req.params.id);
    cleanTemp(job.tmpPath);
    streamError(req, res, 504, 'Download timed out');
  }, JOB_TTL);

  function onDone() {
    clearTimeout(timer);
    if (job.status === 'ready') serveFile(job, req, res);
    else {
      jobs.delete(req.params.id);
      streamError(req, res, 500, job.error || 'Download failed');
    }
  }
  job.emitter.once('done', onDone);
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
    if (fs.existsSync(statusFile)) {
      const line = fs.readFileSync(statusFile, 'utf8').trim().split('\n')[0] || '';
      cookiesOk = line.startsWith('expired') ? 'file:expired' : 'file:ok';
    } else {
      cookiesOk = 'file:unchecked'; // file exists, keep-alive cron not yet run
    }
  }
  return { ok: !!ytdlpVer, ytdlp: ytdlpVer || 'not found', ffmpeg: ffmpegOk, pot: potVer, cookies: cookiesOk };
}

app.get('/health', async (req, res) => {
  res.json(await healthPayload());
});

app.get('/', async (req, res) => {
  const h = await healthPayload();
  res.json({ cobalt: { version: h.ytdlp, services: ['youtube'] }, ...h });
});

/* ══════════════════════════════════════════════════════════════
   INTERNAL HELPERS
══════════════════════════════════════════════════════════════ */

/**
 * Get video title from yt-dlp JSON info.
 * Uses --no-playlist to avoid fetching entire playlist metadata.
 */
function getTitle(url) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const proc = spawn(YTDLP, ['--no-playlist', '-j', '--no-warnings', ...clientArgs(), ...authArgs(), url]);
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code !== 0) {
        // Surface the actual yt-dlp error line (last non-empty stderr line)
        const detail = err.trim().split('\n').filter(Boolean).pop()?.trim() || `exit ${code}`;
        return reject(new Error(detail));
      }
      try {
        const info = JSON.parse(out);
        resolve(info.title || 'download');
      } catch { reject(new Error('Could not parse yt-dlp JSON output')); }
    });
    proc.on('error', e => reject(new Error('yt-dlp not found — install: pip3 install yt-dlp  (' + e.message + ')')));
  });
}

/**
 * Build yt-dlp arguments and start the download subprocess.
 * Downloads to a temp file. Emits 'done' on the job's emitter when finished.
 *
 * Video (mp4):  bestvideo[height<=Q]+bestaudio → merged with ffmpeg to .mp4
 * Audio (mp3):  bestaudio → extracted + converted to .mp3 via ffmpeg
 * Audio (m4a):  bestaudio[ext=m4a]/bestaudio → saved as .m4a
 */
function startDownload({ jobId, url, tmpPath, isAudio, wantMp3, videoQuality, audioBitrate }) {
  const job = jobs.get(jobId);
  if (!job) return;

  let args;
  if (isAudio) {
    if (wantMp3) {
      /*
       * Extract audio and convert to MP3 via FFmpeg.
       * PREREQUISITE: ffmpeg must be installed and in PATH.
       * Without ffmpeg, yt-dlp will skip conversion and save as .webm/.m4a.
       */
      args = [
        '--no-playlist', '--no-warnings',
        ...clientArgs(), ...authArgs(),
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', `${audioBitrate}K`,
        '--ffmpeg-location', FFMPEG,
        '-o', tmpPath,
        url,
      ];
    } else {
      /* M4A — no conversion needed if source is already m4a */
      args = [
        '--no-playlist', '--no-warnings',
        ...clientArgs(), ...authArgs(),
        '-f', 'bestaudio[ext=m4a]/bestaudio/best',
        '-o', tmpPath,
        url,
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
    const want    = videoQuality === 'max' ? 0 : (parseInt(videoQuality) || 1080);
    const height  = (cap && want) ? Math.min(want, cap) : (cap || want);   // 0 = uncapped
    const q       = height ? `[height<=${height}]` : '';
    const format  = `bestvideo${q}[ext=mp4]+bestaudio[ext=m4a]/bestvideo${q}+bestaudio/best${q}/best`;
    args = [
      '--no-playlist', '--no-warnings',
      ...clientArgs(), ...authArgs(),
      '-f', format,
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', FFMPEG,
      '-o', tmpPath,
      url,
    ];
  }

  activeDownloads++;
  let settled = false;
  const release = () => { if (!settled) { settled = true; activeDownloads--; } };

  // Keep the tail of stderr so a failure reports the real yt-dlp line ("Sign in to
  // confirm you're not a bot", "Video unavailable", …) instead of a bare exit code.
  // Without this the reason exists only in the journal and the user is told nothing.
  let errTail = '';
  const proc = spawn(YTDLP, args);
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', d => {
    process.stderr.write(`[yt-dlp ${jobId.slice(0,8)}] ${d}`);
    errTail = (errTail + d).slice(-4096);
  });

  proc.on('close', code => {
    release();
    if (!jobs.has(jobId)) return;
    if (code === 0 && fs.existsSync(tmpPath)) {
      job.status = 'ready';
    } else {
      const detail = errTail.trim().split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('[download]'))
        .pop();
      job.status = 'error';
      job.error  = detail ? detail.slice(0, 300) : `yt-dlp exited with code ${code}`;
    }
    job.emitter.emit('done');
  });

  proc.on('error', e => {
    release();
    if (!jobs.has(jobId)) return;
    job.status = 'error';
    job.error  = 'yt-dlp spawn error: ' + e.message;
    job.emitter.emit('done');
  });

  /* Kill download if client disconnects during the wait */
  // (handled in serveFile for the streaming phase)
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
 * Stream the downloaded temp file to the HTTP response, then delete it.
 */
function serveFile(job, req, res) {
  if (!fs.existsSync(job.tmpPath)) {
    return res.status(410).json({ error: 'File no longer available' });
  }

  const stat = fs.statSync(job.tmpPath);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(job.filename)}"`);
  res.setHeader('Content-Type',        'application/octet-stream');
  res.setHeader('Content-Length',      stat.size);
  res.setHeader('Cache-Control',       'no-store');

  const stream = fs.createReadStream(job.tmpPath);
  stream.pipe(res);
  stream.on('end',   () => cleanTemp(job.tmpPath));
  stream.on('error', () => { cleanTemp(job.tmpPath); res.destroy(); });
  req.on('close',    () => { stream.destroy(); cleanTemp(job.tmpPath); });
}

function cleanTemp(filePath) {
  fs.unlink(filePath, () => {}); // ignore errors (file may already be gone)
}

/* ── Version checks (for /health) ─────────────────────────── */
function getYtdlpVersion() {
  return new Promise(resolve => {
    let out = '';
    const proc = spawn(YTDLP, ['--version']);
    proc.stdout.on('data', d => out += d);
    proc.on('close', code => resolve(code === 0 ? out.trim() : null));
    proc.on('error', () => resolve(null));
  });
}
function hasFfmpeg() {
  return new Promise(resolve => {
    const proc = spawn(FFMPEG, ['-version']);
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
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

/* ── Periodic cleanup of expired jobs ──────────────────────── */
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expires < now) {
      cleanTemp(job.tmpPath);
      jobs.delete(id);
    }
  }
  // Drop rate-limit entries whose whole window has passed, so the map cannot grow
  // unbounded across every IP that ever touched the server.
  for (const [ip, hits] of rateHits) {
    if (!hits.some(t => now - t < RATE_WINDOW_MS)) rateHits.delete(ip);
  }
}, 60_000);

/* ══════════════════════════════════════════════════════════════
   START
══════════════════════════════════════════════════════════════ */
app.listen(PORT, HOST, async () => {
  console.log(`\n  yt-dlp server  →  http://localhost:${PORT}/`);
  console.log(`  In the yt-downloader tool, select "Local" backend (default when deployed via nginx /yt-api/).\n`);

  const [ver, ffmpegOk, potVer] = await Promise.all([getYtdlpVersion(), hasFfmpeg(), getPotStatus()]);
  console.log(`  yt-dlp  : ${ver  ? `✓ ${ver}` : '✗ NOT FOUND — install: pip install yt-dlp'}`);
  console.log(`  ffmpeg  : ${ffmpegOk ? '✓ found'  : '✗ NOT FOUND — MP3 and 1080p will not work (install ffmpeg)'}`);
  console.log(`  PO-token: ${potVer ? `✓ provider v${potVer} at ${POT_PROVIDER_URL}` : `✗ provider NOT reachable at ${POT_PROVIDER_URL} — YouTube may serve bot-check 403s (deploy.sh installs office-tools-pot)`}`);
  console.log(`  Limits  : ${MAX_CONCURRENT > 0 ? MAX_CONCURRENT : '∞'} concurrent · ${RATE_MAX > 0 ? `${RATE_MAX} per IP / ${Math.round(RATE_WINDOW_MS / 1000)}s` : 'no rate limit'} · height cap ${qualityCap() || 'none'}`);
  console.log('');
});
