/**
 * yt-dlp Server — Self-hosted YouTube download backend
 * Cobalt-compatible API: drop this in place of api.cobalt.tools in the yt-downloader tool.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  PREREQUISITES
 * ═══════════════════════════════════════════════════════════════════
 *
 *  1. Node.js 18+
 *     https://nodejs.org/
 *
 *  2. yt-dlp  (the actual downloader engine)
 *     Windows:  winget install yt-dlp
 *               OR: pip install yt-dlp
 *     Linux:    sudo pip3 install yt-dlp
 *               OR: sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 *                   -o /usr/local/bin/yt-dlp && sudo chmod +x /usr/local/bin/yt-dlp
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
 *   Then in the yt-downloader tool → Advanced → Cobalt API URL:
 *     http://localhost:9000/
 *
 *   To expose on your network (e.g. from a VPS):
 *     PORT=9000 node server.js
 *     → set Cobalt API URL to http://YOUR-SERVER-IP:9000/
 *
 * ═══════════════════════════════════════════════════════════════════
 *  ENVIRONMENT VARIABLES  (all optional)
 * ═══════════════════════════════════════════════════════════════════
 *
 *   PORT          HTTP port to listen on          (default: 9000)
 *   HOST          Interface to bind to            (default: 0.0.0.0)
 *   YTDLP         Path to yt-dlp binary           (default: "yt-dlp")
 *   FFMPEG        Path to ffmpeg binary           (default: "ffmpeg")
 *   CORS_ORIGIN   Allowed CORS origin             (default: "*")
 *   MAX_QUALITY   Max video quality override      (default: "1080")
 *   TEMP_DIR      Directory for temp files        (default: OS temp dir)
 *   JOB_TTL_MS    Job expiry in ms                (default: 600000 = 10 min)
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
 *  GET /health
 *    Returns: { ok: true, ytdlp: "version string", ffmpeg: boolean }
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
const TEMP_DIR   = process.env.TEMP_DIR         || os.tmpdir();
const JOB_TTL    = parseInt(process.env.JOB_TTL_MS || '600000', 10);

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
    return res.json({ status: 'error', error: { code: 'fetch_failed: ' + e.message.slice(0, 80) } });
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
    return res.status(404).json({ error: 'Stream not found or expired' });
  }

  /* Already finished? */
  if (job.status === 'ready') return serveFile(job, req, res);
  if (job.status === 'error') {
    jobs.delete(req.params.id);
    return res.status(500).json({ error: job.error || 'Download failed' });
  }

  /* Wait for the download to complete (event-based, no polling) */
  const timer = setTimeout(() => {
    job.emitter.off('done', onDone);
    jobs.delete(req.params.id);
    cleanTemp(job.tmpPath);
    res.status(504).json({ error: 'Download timed out' });
  }, JOB_TTL);

  function onDone() {
    clearTimeout(timer);
    if (job.status === 'ready') serveFile(job, req, res);
    else {
      jobs.delete(req.params.id);
      res.status(500).json({ error: job.error || 'Download failed' });
    }
  }
  job.emitter.once('done', onDone);
});

/* ══════════════════════════════════════════════════════════════
   GET /health  — dependency check
══════════════════════════════════════════════════════════════ */
app.get('/health', async (req, res) => {
  const [ytdlpVer, ffmpegOk] = await Promise.all([getYtdlpVersion(), hasFfmpeg()]);
  res.json({ ok: !!ytdlpVer, ytdlp: ytdlpVer || 'not found', ffmpeg: ffmpegOk });
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
    let out = '';
    const proc = spawn(YTDLP, ['--no-playlist', '-j', '--no-warnings', url]);
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', () => {}); // suppress
    proc.on('close', code => {
      if (code !== 0) {
        const msg = code === 1
          ? 'yt-dlp exit 1: update yt-dlp (deploy.sh → Option 1) or video is unavailable/private'
          : `yt-dlp metadata failed (exit ${code})`;
        return reject(new Error(msg));
      }
      try {
        const info = JSON.parse(out);
        resolve(info.title || 'download');
      } catch { reject(new Error('Could not parse yt-dlp JSON')); }
    });
    proc.on('error', e => reject(new Error('yt-dlp not found: ' + e.message)));
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
    const q       = videoQuality === 'max' ? '' : `[height<=${Math.min(parseInt(videoQuality) || 1080, parseInt(MAX_QUAL))}]`;
    const format  = `bestvideo${q}[ext=mp4]+bestaudio[ext=m4a]/bestvideo${q}+bestaudio/best${q}/best`;
    args = [
      '--no-playlist', '--no-warnings',
      '-f', format,
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', FFMPEG,
      '-o', tmpPath,
      url,
    ];
  }

  const proc = spawn(YTDLP, args);
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', d => process.stderr.write(`[yt-dlp ${jobId.slice(0,8)}] ${d}`));

  proc.on('close', code => {
    if (!jobs.has(jobId)) return;
    if (code === 0 && fs.existsSync(tmpPath)) {
      job.status = 'ready';
    } else {
      job.status = 'error';
      job.error  = `yt-dlp exited with code ${code}`;
    }
    job.emitter.emit('done');
  });

  proc.on('error', e => {
    if (!jobs.has(jobId)) return;
    job.status = 'error';
    job.error  = 'yt-dlp spawn error: ' + e.message;
    job.emitter.emit('done');
  });

  /* Kill download if client disconnects during the wait */
  // (handled in serveFile for the streaming phase)
}

/**
 * Stream the downloaded temp file to the HTTP response, then delete it.
 */
function serveFile(job, req, res) {
  if (!fs.existsSync(job.tmpPath)) {
    jobs.delete(job.tmpPath); // already cleaned
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

/* ── Periodic cleanup of expired jobs ──────────────────────── */
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expires < now) {
      cleanTemp(job.tmpPath);
      jobs.delete(id);
    }
  }
}, 60_000);

/* ══════════════════════════════════════════════════════════════
   START
══════════════════════════════════════════════════════════════ */
app.listen(PORT, HOST, async () => {
  console.log(`\n  yt-dlp server  →  http://localhost:${PORT}/`);
  console.log(`  In the yt-downloader tool, select "Local" backend (default when deployed via nginx /yt-api/).\n`);

  const [ver, ffmpegOk] = await Promise.all([getYtdlpVersion(), hasFfmpeg()]);
  console.log(`  yt-dlp  : ${ver  ? `✓ ${ver}` : '✗ NOT FOUND — install: pip install yt-dlp'}`);
  console.log(`  ffmpeg  : ${ffmpegOk ? '✓ found'  : '✗ NOT FOUND — MP3 and 1080p will not work (install ffmpeg)'}`);
  console.log('');
});
